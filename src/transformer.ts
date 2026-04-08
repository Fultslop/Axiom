import typescript from 'typescript';
import { extractContractTags } from './jsdoc-parser';
import { buildPreCheck, buildBodyCapture, buildPostCheck, buildResultReturn } from './ast-builder';
import type { ContractTag } from './jsdoc-parser';

const KIND_PRE = 'pre' as const;
const KIND_POST = 'post' as const;

function isPublicTarget(node: typescript.FunctionLikeDeclaration): boolean {
  const modifiers = typescript.canHaveModifiers(node)
    ? typescript.getModifiers(node) ?? []
    : [];

  const isPrivateOrProtected = modifiers.some(
    (mod) =>
      mod.kind === typescript.SyntaxKind.PrivateKeyword ||
      mod.kind === typescript.SyntaxKind.ProtectedKeyword,
  );

  const isExportedFunction =
    typescript.isFunctionDeclaration(node) &&
    modifiers.some((mod) => mod.kind === typescript.SyntaxKind.ExportKeyword);

  const isPublicMethod = typescript.isMethodDeclaration(node) && !isPrivateOrProtected;

  return isExportedFunction || isPublicMethod;
}

function buildLocationName(node: typescript.FunctionLikeDeclaration): string {
  if (typescript.isMethodDeclaration(node)) {
    const className =
      typescript.isClassDeclaration(node.parent) && node.parent.name
        ? node.parent.name.text
        : 'UnknownClass';
    const methodName =
      typescript.isIdentifier(node.name) ? node.name.text : 'unknownMethod';
    return `${className}.${methodName}`;
  }
  if (typescript.isFunctionDeclaration(node) && node.name) {
    return node.name.text;
  }
  return 'anonymous';
}

function buildGuardedStatements(
  factory: typescript.NodeFactory,
  preTags: ContractTag[],
  postTags: ContractTag[],
  originalBody: typescript.Block,
  location: string,
): typescript.Statement[] {
  const statements: typescript.Statement[] = [];

  for (const tag of preTags) {
    statements.push(buildPreCheck(tag.expression, location, factory));
  }

  if (postTags.length > 0) {
    statements.push(buildBodyCapture(originalBody.statements, factory));
    for (const tag of postTags) {
      statements.push(buildPostCheck(tag.expression, location, factory));
    }
    statements.push(buildResultReturn(factory));
  } else {
    statements.push(...Array.from(originalBody.statements));
  }

  return statements;
}

function buildRequireStatement(
  factory: typescript.NodeFactory,
): typescript.VariableStatement {
  // Inject as a require() call rather than an import declaration so TypeScript's
  // CJS emit cannot elide it (import elision skips imports with no parse-time
  // value usage; synthetic usages added in a before-transformer are invisible).
  return factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [factory.createVariableDeclaration(
        factory.createObjectBindingPattern([
          factory.createBindingElement(
            undefined,
            undefined,
            factory.createIdentifier('ContractViolationError'),
          ),
        ]),
        undefined,
        undefined,
        factory.createCallExpression(
          factory.createIdentifier('require'),
          undefined,
          [factory.createStringLiteral('fsprepost')],
        ),
      )],
      typescript.NodeFlags.Const,
    ),
  );
}

/**
 * Re-parse the source file with setParentNodes:true so JSDoc nodes are
 * attached. Returns a map from source position to reparsed node.
 */
function buildReparsedIndex(
  sourceFile: typescript.SourceFile,
): Map<number, typescript.FunctionLikeDeclaration> {
  const reparsed = typescript.createSourceFile(
    sourceFile.fileName,
    sourceFile.text,
    sourceFile.languageVersion,
    /* setParentNodes */ true,
  );

  const index = new Map<number, typescript.FunctionLikeDeclaration>();

  function visit(node: typescript.Node): void {
    if (typescript.isFunctionLike(node)) {
      index.set(node.pos, node as typescript.FunctionLikeDeclaration);
    }
    typescript.forEachChild(node, visit);
  }

  visit(reparsed);
  return index;
}

function rewriteFunction(
  factory: typescript.NodeFactory,
  node: typescript.FunctionLikeDeclaration,
  reparsedIndex: Map<number, typescript.FunctionLikeDeclaration>,
): typescript.FunctionLikeDeclaration | null {
  const originalBody = node.body;
  if (!originalBody || !typescript.isBlock(originalBody)) {
    return null;
  }

  // Use the reparsed counterpart so getJSDocTags works correctly.
  const reparsedNode = reparsedIndex.get(node.pos) ?? node;
  const tags = extractContractTags(reparsedNode);
  if (tags.length === 0) {
    return null;
  }

  const preTags = tags.filter((tag) => tag.kind === KIND_PRE);
  const postTags = tags.filter((tag) => tag.kind === KIND_POST);
  const location = buildLocationName(node);
  const newStatements = buildGuardedStatements(
    factory, preTags, postTags, originalBody, location,
  );
  const newBody = factory.createBlock(newStatements, true);

  if (typescript.isMethodDeclaration(node)) {
    return factory.updateMethodDeclaration(
      node,
      typescript.getModifiers(node),
      node.asteriskToken,
      node.name,
      node.questionToken,
      node.typeParameters,
      node.parameters,
      node.type,
      newBody,
    );
  }

  if (typescript.isFunctionDeclaration(node)) {
    return factory.updateFunctionDeclaration(
      node,
      typescript.getModifiers(node),
      node.asteriskToken,
      node.name,
      node.typeParameters,
      node.parameters,
      node.type,
      newBody,
    );
  }

  return null;
}

function tryRewriteFunction(
  factory: typescript.NodeFactory,
  node: typescript.FunctionLikeDeclaration,
  reparsedIndex: Map<number, typescript.FunctionLikeDeclaration>,
  transformed: { value: boolean },
): typescript.FunctionLikeDeclaration {
  try {
    const rewritten = rewriteFunction(factory, node, reparsedIndex);
    if (rewritten === null) {
      return node;
    }
    transformed.value = true;
    return rewritten;
  } catch {
    // Safety invariant: on any error, return original node unmodified.
    return node;
  }
}

function visitNode(
  factory: typescript.NodeFactory,
  node: typescript.Node,
  context: typescript.TransformationContext,
  reparsedIndex: Map<number, typescript.FunctionLikeDeclaration>,
  transformed: { value: boolean },
): typescript.Node {
  if (
    (typescript.isMethodDeclaration(node) || typescript.isFunctionDeclaration(node)) &&
    isPublicTarget(node as typescript.FunctionLikeDeclaration)
  ) {
    return tryRewriteFunction(
      factory,
      node as typescript.FunctionLikeDeclaration,
      reparsedIndex,
      transformed,
    );
  }
  return typescript.visitEachChild(
    node,
    (child) => visitNode(factory, child, context, reparsedIndex, transformed),
    context,
  );
}

// ts-patch plugin entry point. program is optional so the transformer can
// also be used in transpileModule() for unit testing.
export default function createTransformer(
  _program?: typescript.Program,
): typescript.TransformerFactory<typescript.SourceFile> {
  return (context: typescript.TransformationContext) => {
    // Use the compiler's own factory so synthesized nodes are compatible
    // with the AST nodes created by the host TypeScript instance.
    const { factory } = context;

    return (sourceFile: typescript.SourceFile): typescript.SourceFile => {
      const reparsedIndex = buildReparsedIndex(sourceFile);
      const transformed = { value: false };
      const visited = typescript.visitEachChild(
        sourceFile,
        (node) => visitNode(factory, node, context, reparsedIndex, transformed),
        context,
      );

      if (!transformed.value) {
        return visited;
      }

      const importDecl = buildRequireStatement(factory);
      return factory.updateSourceFile(visited, [importDecl, ...Array.from(visited.statements)]);
    };
  };
}

// Named export required by ts-jest's astTransformers pipeline.
export { createTransformer as factory };
