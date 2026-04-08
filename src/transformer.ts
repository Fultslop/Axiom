import typescript from 'typescript';
import { extractContractTags } from './jsdoc-parser';
import {
  buildPreCheck, buildBodyCapture, buildPostCheck, buildResultReturn, parseContractExpression,
} from './ast-builder';
import { validateExpression } from './contract-validator';
import type { ContractTag } from './jsdoc-parser';
import type { SimpleType } from './contract-validator';

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

function simpleTypeFromFlags(flags: number): SimpleType | undefined {
  /* eslint-disable no-bitwise */
  if (flags & typescript.TypeFlags.NumberLike) {
    return 'number';
  }
  if (flags & typescript.TypeFlags.StringLike) {
    return 'string';
  }
  if (flags & typescript.TypeFlags.BooleanLike) {
    return 'boolean';
  }
  /* eslint-enable no-bitwise */
  return undefined;
}

function buildParameterTypes(
  node: typescript.FunctionLikeDeclaration,
  checker: typescript.TypeChecker,
): Map<string, SimpleType> {
  const types = new Map<string, SimpleType>();
  for (const param of node.parameters) {
    if (typescript.isIdentifier(param.name)) {
      const paramType = checker.getTypeAtLocation(param);
      const simpleType = simpleTypeFromFlags(paramType.flags);
      if (simpleType !== undefined) {
        types.set(param.name.text, simpleType);
      }
    }
  }
  return types;
}

function buildPostParamTypes(
  node: typescript.FunctionLikeDeclaration,
  checker: typescript.TypeChecker | undefined,
  base: Map<string, SimpleType> | undefined,
): Map<string, SimpleType> | undefined {
  if (checker === undefined || base === undefined) {
    return base;
  }
  const sig = checker.getSignatureFromDeclaration(node);
  if (sig === undefined) {
    return base;
  }
  const returnType = checker.getReturnTypeOfSignature(sig);
  const resultSimpleType = simpleTypeFromFlags(returnType.flags);
  if (resultSimpleType === undefined) {
    return base;
  }
  const extended = new Map(base);
  extended.set('result', resultSimpleType);
  return extended;
}

function buildKnownIdentifiers(
  node: typescript.FunctionLikeDeclaration,
  includeResult: boolean,
): Set<string> {
  const names = new Set<string>(['this']);
  for (const param of node.parameters) {
    if (typescript.isIdentifier(param.name)) {
      names.add(param.name.text);
    }
  }
  if (includeResult) {
    names.add('result');
  }
  return names;
}

function filterValidTags(
  tags: ContractTag[],
  kind: 'pre' | 'post',
  location: string,
  warn: (msg: string) => void,
  knownIdentifiers: Set<string>,
  paramTypes?: Map<string, SimpleType>,
): ContractTag[] {
  return tags.filter((tag) => {
    const errors = validateExpression(
      parseContractExpression(tag.expression),
      tag.expression,
      location,
      knownIdentifiers,
      paramTypes,
    );
    if (errors.length > 0) {
      errors.forEach((err) => {
        warn(
          `[fsprepost] Contract validation warning in ${location}:`
          + `\n  @${kind} ${err.expression} — ${err.message}`,
        );
      });
      return false;
    }
    return true;
  });
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
  warn: (msg: string) => void,
  checker?: typescript.TypeChecker,
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

  const location = buildLocationName(node);
  const preKnown = buildKnownIdentifiers(node, false);
  const postKnown = buildKnownIdentifiers(node, true);
  const paramTypes = checker !== undefined ? buildParameterTypes(node, checker) : undefined;
  const postParamTypes = buildPostParamTypes(node, checker, paramTypes);
  const preTags = filterValidTags(
    tags.filter((tag) => tag.kind === KIND_PRE), KIND_PRE, location, warn, preKnown, paramTypes,
  );
  const postTags = filterValidTags(
    tags.filter((tag) => tag.kind === KIND_POST),
    KIND_POST, location, warn, postKnown, postParamTypes,
  );
  if (preTags.length === 0 && postTags.length === 0) {
    return null;
  }
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
  warn: (msg: string) => void,
  checker?: typescript.TypeChecker,
): typescript.FunctionLikeDeclaration {
  try {
    const rewritten = rewriteFunction(factory, node, reparsedIndex, warn, checker);
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
  warn: (msg: string) => void,
  checker?: typescript.TypeChecker,
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
      warn,
      checker,
    );
  }
  return typescript.visitEachChild(
    node,
    (child) => visitNode(factory, child, context, reparsedIndex, transformed, warn, checker),
    context,
  );
}

// ts-patch plugin entry point. program is optional so the transformer can
// also be used in transpileModule() for unit testing.
export default function createTransformer(
  _program?: typescript.Program,
  options?: { warn?: (msg: string) => void },
): typescript.TransformerFactory<typescript.SourceFile> {
  const warn = options?.warn ?? ((msg: string): void => {
    process.stderr.write(`${msg}\n`);
  });
  const checker = _program?.getTypeChecker?.();
  return (context: typescript.TransformationContext) => {
    // Use the compiler's own factory so synthesized nodes are compatible
    // with the AST nodes created by the host TypeScript instance.
    const { factory } = context;

    return (sourceFile: typescript.SourceFile): typescript.SourceFile => {
      const reparsedIndex = buildReparsedIndex(sourceFile);
      const transformed = { value: false };
      const visited = typescript.visitEachChild(
        sourceFile,
        (node) => visitNode(factory, node, context, reparsedIndex, transformed, warn, checker),
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
