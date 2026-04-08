import typescript from 'typescript';
import { extractContractTags } from './jsdoc-parser';
import { buildPreCheck, buildBodyCapture, buildPostCheck, buildResultReturn } from './ast-builder';
import type { ContractTag } from './jsdoc-parser';

const { factory } = typescript;

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
  preTags: ContractTag[],
  postTags: ContractTag[],
  originalBody: typescript.Block,
  location: string,
): typescript.Statement[] {
  const statements: typescript.Statement[] = [];

  for (const tag of preTags) {
    statements.push(buildPreCheck(tag.expression, location));
  }

  if (postTags.length > 0) {
    statements.push(buildBodyCapture(originalBody.statements));
    for (const tag of postTags) {
      statements.push(buildPostCheck(tag.expression, location));
    }
    statements.push(buildResultReturn());
  } else {
    statements.push(...Array.from(originalBody.statements));
  }

  return statements;
}

function buildImportDeclaration(): typescript.ImportDeclaration {
  return factory.createImportDeclaration(
    undefined,
    factory.createImportClause(
      false,
      undefined,
      factory.createNamedImports([
        factory.createImportSpecifier(
          false,
          undefined,
          factory.createIdentifier('ContractViolationError'),
        ),
      ]),
    ),
    factory.createStringLiteral('fsprepost'),
  );
}

function rewriteFunction(
  node: typescript.FunctionLikeDeclaration,
): typescript.FunctionLikeDeclaration | null {
  const originalBody = node.body;
  if (!originalBody || !typescript.isBlock(originalBody)) {
    return null;
  }

  const tags = extractContractTags(node);
  const preTags = tags.filter((tag) => tag.kind === KIND_PRE);
  const postTags = tags.filter((tag) => tag.kind === KIND_POST);
  const location = buildLocationName(node);
  const newStatements = buildGuardedStatements(preTags, postTags, originalBody, location);
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
  node: typescript.FunctionLikeDeclaration,
  transformed: { value: boolean },
): typescript.FunctionLikeDeclaration {
  try {
    const tags = extractContractTags(node);
    if (tags.length === 0) {
      return node;
    }
    const rewritten = rewriteFunction(node);
    if (rewritten === null) {
      return node;
    }
    transformed.value = true;
    return rewritten;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (err) {
    // Safety invariant: on any error, return original node unmodified.
    // In a full ts-patch context with a Program, emit a diagnostic warning here.
    return node;
  }
}

function visitNode(
  node: typescript.Node,
  context: typescript.TransformationContext,
  transformed: { value: boolean },
): typescript.Node {
  if (
    (typescript.isMethodDeclaration(node) || typescript.isFunctionDeclaration(node)) &&
    isPublicTarget(node as typescript.FunctionLikeDeclaration)
  ) {
    return tryRewriteFunction(node as typescript.FunctionLikeDeclaration, transformed);
  }
  return typescript.visitEachChild(
    node,
    (child) => visitNode(child, context, transformed),
    context,
  );
}

// ts-patch plugin entry point. program is optional so the transformer can
// also be used in transpileModule() for unit testing.
export default function createTransformer(
  _program?: typescript.Program,
): typescript.TransformerFactory<typescript.SourceFile> {
  return (context: typescript.TransformationContext) =>
    (sourceFile: typescript.SourceFile): typescript.SourceFile => {
      const transformed = { value: false };
      const visited = typescript.visitEachChild(
        sourceFile,
        (node) => visitNode(node, context, transformed),
        context,
      );

      if (!transformed.value) {
        return visited;
      }

      const importDecl = buildImportDeclaration();
      return factory.updateSourceFile(visited, [importDecl, ...Array.from(visited.statements)]);
    };
}
