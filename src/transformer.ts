import typescript from 'typescript';
import { extractContractTags, extractInvariantExpressions } from './jsdoc-parser';
import {
  buildPreCheck, buildBodyCapture, buildPostCheck, buildResultReturn, parseContractExpression,
  buildCheckInvariantsCall, buildCheckInvariantsMethod,
} from './ast-builder';
import { validateExpression } from './contract-validator';
import type { ContractTag } from './jsdoc-parser';
import type { SimpleType } from './contract-validator';

const KIND_PRE = 'pre' as const;
const KIND_POST = 'post' as const;
const CHECK_INVARIANTS_NAME = '#checkInvariants' as const;

// ---------------------------------------------------------------------------
// Reparsed-index: positions → nodes with JSDoc attached
// ---------------------------------------------------------------------------

interface ReparsedIndex {
  functions: Map<number, typescript.FunctionLikeDeclaration>;
  classes: Map<number, typescript.ClassDeclaration>;
}

/**
 * Re-parse the source file with setParentNodes:true so JSDoc nodes are
 * attached. Returns maps from source position to reparsed node.
 */
function buildReparsedIndex(sourceFile: typescript.SourceFile): ReparsedIndex {
  const reparsed = typescript.createSourceFile(
    sourceFile.fileName,
    sourceFile.text,
    sourceFile.languageVersion,
    /* setParentNodes */ true,
  );

  const functions = new Map<number, typescript.FunctionLikeDeclaration>();
  const classes = new Map<number, typescript.ClassDeclaration>();

  function visit(node: typescript.Node): void {
    if (typescript.isFunctionLike(node)) {
      functions.set(node.pos, node as typescript.FunctionLikeDeclaration);
    }
    if (typescript.isClassDeclaration(node)) {
      classes.set(node.pos, node);
    }
    typescript.forEachChild(node, visit);
  }

  visit(reparsed);
  return { functions, classes };
}

// ---------------------------------------------------------------------------
// Visibility helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Name helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tag validation
// ---------------------------------------------------------------------------

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

function filterValidInvariants(
  expressions: string[],
  className: string,
  warn: (msg: string) => void,
): string[] {
  const knownIdentifiers = new Set(['this']);
  return expressions.filter((expr) => {
    const errors = validateExpression(
      parseContractExpression(expr),
      expr,
      className,
      knownIdentifiers,
    );
    if (errors.length > 0) {
      errors.forEach((err) => {
        warn(
          `[fsprepost] Invariant validation warning in ${className}:`
          + `\n  @invariant ${err.expression} — ${err.message}`,
        );
      });
      return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Statement builders
// ---------------------------------------------------------------------------

function buildGuardedStatements(
  factory: typescript.NodeFactory,
  preTags: ContractTag[],
  postTags: ContractTag[],
  originalBody: typescript.Block,
  location: string,
  invariantCall: typescript.ExpressionStatement | null,
): typescript.Statement[] {
  const statements: typescript.Statement[] = [];

  for (const tag of preTags) {
    statements.push(buildPreCheck(tag.expression, location, factory));
  }

  if (postTags.length > 0 || invariantCall !== null) {
    statements.push(buildBodyCapture(originalBody.statements, factory));
    for (const tag of postTags) {
      statements.push(buildPostCheck(tag.expression, location, factory));
    }
    if (invariantCall !== null) {
      statements.push(invariantCall);
    }
    statements.push(buildResultReturn(factory));
  } else {
    statements.push(...Array.from(originalBody.statements));
  }

  return statements;
}

// ---------------------------------------------------------------------------
// require() injection
// ---------------------------------------------------------------------------

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
          factory.createBindingElement(
            undefined,
            undefined,
            factory.createIdentifier('InvariantViolationError'),
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

// ---------------------------------------------------------------------------
// Function / method rewriting
// ---------------------------------------------------------------------------

function applyNewBody(
  factory: typescript.NodeFactory,
  node: typescript.FunctionLikeDeclaration,
  newBody: typescript.Block,
): typescript.FunctionLikeDeclaration | null {
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

function isStaticMethod(node: typescript.FunctionLikeDeclaration): boolean {
  const modifiers = typescript.canHaveModifiers(node)
    ? typescript.getModifiers(node) ?? []
    : [];
  return modifiers.some((mod) => mod.kind === typescript.SyntaxKind.StaticKeyword);
}

function buildInvariantCallIfNeeded(
  factory: typescript.NodeFactory,
  node: typescript.FunctionLikeDeclaration,
  location: string,
  invariantExpressions: string[],
): typescript.ExpressionStatement | null {
  if (
    invariantExpressions.length > 0 &&
    typescript.isMethodDeclaration(node) &&
    !isStaticMethod(node)
  ) {
    return buildCheckInvariantsCall(location, factory);
  }
  return null;
}

function rewriteFunction(
  factory: typescript.NodeFactory,
  node: typescript.FunctionLikeDeclaration,
  reparsedFunctions: Map<number, typescript.FunctionLikeDeclaration>,
  warn: (msg: string) => void,
  checker?: typescript.TypeChecker,
  invariantExpressions: string[] = [],
): typescript.FunctionLikeDeclaration | null {
  const originalBody = node.body;
  if (!originalBody || !typescript.isBlock(originalBody)) {
    return null;
  }

  // Use the reparsed counterpart so getJSDocTags works correctly.
  const reparsedNode = reparsedFunctions.get(node.pos) ?? node;
  const tags = extractContractTags(reparsedNode);

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

  const invariantCall = buildInvariantCallIfNeeded(factory, node, location, invariantExpressions);

  if (preTags.length === 0 && postTags.length === 0 && invariantCall === null) {
    return null;
  }

  const newStatements = buildGuardedStatements(
    factory, preTags, postTags, originalBody, location, invariantCall,
  );
  return applyNewBody(factory, node, factory.createBlock(newStatements, true));
}

function tryRewriteFunction(
  factory: typescript.NodeFactory,
  node: typescript.FunctionLikeDeclaration,
  reparsedFunctions: Map<number, typescript.FunctionLikeDeclaration>,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker?: typescript.TypeChecker,
  invariantExpressions: string[] = [],
): typescript.FunctionLikeDeclaration {
  try {
    const rewritten = rewriteFunction(
      factory, node, reparsedFunctions, warn, checker, invariantExpressions,
    );
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

// ---------------------------------------------------------------------------
// Constructor rewriting (invariant exit-check only)
// ---------------------------------------------------------------------------

function rewriteConstructor(
  factory: typescript.NodeFactory,
  node: typescript.ConstructorDeclaration,
  className: string,
): typescript.ConstructorDeclaration {
  const originalBody = node.body;
  if (!originalBody) {
    return node;
  }
  const location = `${className}.constructor`;
  const newStatements = [
    ...Array.from(originalBody.statements),
    buildCheckInvariantsCall(location, factory),
  ];
  return factory.updateConstructorDeclaration(
    node,
    typescript.getModifiers(node),
    node.parameters,
    factory.createBlock(newStatements, true),
  );
}

// ---------------------------------------------------------------------------
// Class rewriting
// ---------------------------------------------------------------------------

function hasClashingMember(node: typescript.ClassDeclaration): boolean {
  return node.members.some(
    (member) =>
      (typescript.isMethodDeclaration(member) || typescript.isPropertyDeclaration(member)) &&
      typescript.isPrivateIdentifier(member.name) &&
      member.name.text === CHECK_INVARIANTS_NAME,
  );
}

function rewriteMember(
  factory: typescript.NodeFactory,
  member: typescript.ClassElement,
  reparsedIndex: ReparsedIndex,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker: typescript.TypeChecker | undefined,
  effectiveInvariants: string[],
  className: string,
): { element: typescript.ClassElement; changed: boolean } {
  if (typescript.isMethodDeclaration(member) && isPublicTarget(member)) {
    const rewritten = tryRewriteFunction(
      factory, member, reparsedIndex.functions, transformed, warn, checker, effectiveInvariants,
    );
    return { element: rewritten as typescript.MethodDeclaration, changed: rewritten !== member };
  }
  if (typescript.isConstructorDeclaration(member) && effectiveInvariants.length > 0) {
    return { element: rewriteConstructor(factory, member, className), changed: true };
  }
  return { element: member, changed: false };
}

function resolveEffectiveInvariants(
  node: typescript.ClassDeclaration,
  reparsedClass: typescript.ClassDeclaration | typescript.Node,
  className: string,
  warn: (msg: string) => void,
): string[] {
  const raw = extractInvariantExpressions(reparsedClass);
  const valid = filterValidInvariants(raw, className, warn);
  if (valid.length > 0 && hasClashingMember(node)) {
    const clashMsg = `${className}: ${CHECK_INVARIANTS_NAME} already defined`;
    warn(`[fsprepost] Cannot inject invariants into ${clashMsg}`);
    return [];
  }
  return valid;
}

function rewriteClass(
  factory: typescript.NodeFactory,
  node: typescript.ClassDeclaration,
  reparsedIndex: ReparsedIndex,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker?: typescript.TypeChecker,
): typescript.ClassDeclaration {
  const className = node.name?.text ?? 'UnknownClass';
  const reparsedClass = reparsedIndex.classes.get(node.pos) ?? node;
  const effectiveInvariants = resolveEffectiveInvariants(node, reparsedClass, className, warn);

  let classTransformed = false;
  const newMembers: typescript.ClassElement[] = [];

  for (const member of node.members) {
    const result = rewriteMember(
      factory, member, reparsedIndex, transformed, warn, checker, effectiveInvariants, className,
    );
    if (result.changed) {
      classTransformed = true;
    }
    newMembers.push(result.element);
  }

  if (effectiveInvariants.length > 0) {
    newMembers.push(buildCheckInvariantsMethod(effectiveInvariants, factory));
    classTransformed = true;
  }

  if (!classTransformed) {
    return node;
  }

  transformed.value = true;
  return factory.updateClassDeclaration(
    node,
    typescript.getModifiers(node),
    node.name,
    node.typeParameters,
    node.heritageClauses,
    newMembers,
  );
}

function tryRewriteClass(
  factory: typescript.NodeFactory,
  node: typescript.ClassDeclaration,
  reparsedIndex: ReparsedIndex,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker?: typescript.TypeChecker,
): typescript.ClassDeclaration {
  try {
    return rewriteClass(factory, node, reparsedIndex, transformed, warn, checker);
  } catch {
    return node;
  }
}

// ---------------------------------------------------------------------------
// Node visitor
// ---------------------------------------------------------------------------

function visitNode(
  factory: typescript.NodeFactory,
  node: typescript.Node,
  context: typescript.TransformationContext,
  reparsedIndex: ReparsedIndex,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker?: typescript.TypeChecker,
): typescript.Node {
  if (typescript.isClassDeclaration(node)) {
    return tryRewriteClass(factory, node, reparsedIndex, transformed, warn, checker);
  }

  if (
    typescript.isFunctionDeclaration(node) &&
    isPublicTarget(node as typescript.FunctionLikeDeclaration)
  ) {
    return tryRewriteFunction(
      factory,
      node as typescript.FunctionLikeDeclaration,
      reparsedIndex.functions,
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

// ---------------------------------------------------------------------------
// Transformer entry point
// ---------------------------------------------------------------------------

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
