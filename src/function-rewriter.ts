import typescript from 'typescript';
import {
  buildPreCheck, buildPostCheck, buildBodyCapture, buildResultReturn,
  parseContractExpression, buildCheckInvariantsCall, buildPrevCapture,
} from './ast-builder';
import { validateExpression } from './contract-validator';
import { buildLocationName, buildKnownIdentifiers, isPublicTarget } from './node-helpers';
import { buildParameterTypes, buildPostParamTypes, type TypeMapValue } from './type-helpers';
import type { ContractTag } from './jsdoc-parser';
import { extractContractTags, extractPrevExpression } from './jsdoc-parser';
import type { InterfaceMethodContracts } from './interface-resolver';

const KIND_PRE = 'pre' as const;
const KIND_POST = 'post' as const;
const RESULT_ID = 'result' as const;
const RETURN_TYPE_OK = 'ok' as const;
const PREV_ID = 'prev' as const;

const KEEP_PRE = 'pre' as const;
const KEEP_POST = 'post' as const;
const KEEP_INVARIANT = 'invariant' as const;
const KEEP_ALL = 'all' as const;

export type KeepContracts = false | 'pre' | 'post' | 'invariant' | 'all';


export function shouldEmitPre(keepContracts: KeepContracts): boolean {
  if (keepContracts === false) {
    return true;
  }
  if (keepContracts === KEEP_PRE) {
    return true;
  }
  if (keepContracts === KEEP_ALL) {
    return true;
  }
  return false;
}

export function shouldEmitPost(keepContracts: KeepContracts): boolean {
  if (keepContracts === false) {
    return true;
  }
  if (keepContracts === KEEP_POST) {
    return true;
  }
  if (keepContracts === KEEP_ALL) {
    return true;
  }
  return false;
}

export function shouldEmitInvariant(keepContracts: KeepContracts): boolean {
  if (keepContracts === false) {
    return true;
  }
  if (keepContracts === KEEP_INVARIANT) {
    return true;
  }
  if (keepContracts === KEEP_ALL) {
    return true;
  }
  return false;
}

function allContractsFiltered(
  preTags: ContractTag[],
  postTags: ContractTag[],
  invariantCall: typescript.ExpressionStatement | null,
  keepContracts: KeepContracts,
): boolean {
  const activePre = shouldEmitPre(keepContracts) ? preTags.length : 0;
  const activePost = shouldEmitPost(keepContracts) ? postTags.length : 0;
  const activeInv = shouldEmitInvariant(keepContracts) && invariantCall !== null ? 1 : 0;
  return activePre === 0 && activePost === 0 && activeInv === 0;
}

export function expressionUsesResult(expression: string): boolean {
  try {
    const parsed = parseContractExpression(expression);
    let found = false;
    function walk(node: typescript.Node): void {
      if (!found) {
        if (typescript.isIdentifier(node) && node.text === RESULT_ID) {
          found = true;
        } else {
          typescript.forEachChild(node, walk);
        }
      }
    }
    walk(parsed);
    return found;
  } catch {
    return false;
  }
}

function returnTypeDescription(node: typescript.FunctionLikeDeclaration): string | undefined {
  const typeNode = node.type;
  if (typeNode === undefined) {
    return undefined; // no annotation at all
  }
  if (
    typeNode.kind === typescript.SyntaxKind.VoidKeyword ||
    typeNode.kind === typescript.SyntaxKind.NeverKeyword ||
    typeNode.kind === typescript.SyntaxKind.UndefinedKeyword
  ) {
    return typescript.tokenToString(typeNode.kind) ?? 'void';
  }
  return RETURN_TYPE_OK;
}

function filterPostTagsWithResult(
  postTags: ContractTag[],
  node: typescript.FunctionLikeDeclaration,
  location: string,
  warn: (msg: string) => void,
): ContractTag[] {
  const desc = returnTypeDescription(node);
  return postTags.filter((tag) => {
    if (!expressionUsesResult(tag.expression)) {
      return true;
    }
    if (desc === undefined) {
      warn(
        `[axiom] Contract validation warning in ${location}:`
        + `\n  @post ${tag.expression}`
        + ` — 'result' used but no return type is declared; @post dropped`,
      );
      return false;
    }
    if (desc !== RETURN_TYPE_OK) {
      warn(
        `[axiom] Contract validation warning in ${location}:`
        + `\n  @post ${tag.expression}`
        + ` — 'result' used but return type is '${desc}'; @post dropped`,
      );
      return false;
    }
    return true;
  });
}

function expressionUsesPrev(expression: string): boolean {
  try {
    const parsed = parseContractExpression(expression);
    let found = false;
    function walk(node: typescript.Node): void {
      if (!found) {
        if (typescript.isIdentifier(node) && node.text === PREV_ID) {
          found = true;
        } else {
          typescript.forEachChild(node, walk);
        }
      }
    }
    walk(parsed);
    return found;
  } catch {
    return false;
  }
}

function buildScopeIdentifiers(
  node: typescript.FunctionLikeDeclaration,
  checker: typescript.TypeChecker,
): Set<string> {
  const scopeNode = node.parent;
  const symbols = checker.getSymbolsInScope(
    scopeNode,
    typescript.SymbolFlags.Value,
  );
  return new Set(symbols.map((sym) => sym.name));
}

function isNodeExported(node: typescript.Node): boolean {
  const modifiers = typescript.canHaveModifiers(node)
    ? typescript.getModifiers(node) ?? []
    : [];
  return modifiers.some((mod) => mod.kind === typescript.SyntaxKind.ExportKeyword);
}

function collectExportedNames(
  sourceFile: typescript.SourceFile,
): Set<string> {
  const exported = new Set<string>();
  function visit(node: typescript.Node): void {
    if (typescript.isVariableStatement(node) && isNodeExported(node)) {
      for (const decl of node.declarationList.declarations) {
        if (typescript.isIdentifier(decl.name)) {
          exported.add(decl.name.text);
        }
      }
    }
    if (
      (typescript.isEnumDeclaration(node) ||
      typescript.isFunctionDeclaration(node) ||
      typescript.isClassDeclaration(node)) &&
      isNodeExported(node) &&
      node.name
    ) {
      exported.add(node.name.text);
    }
    typescript.forEachChild(node, visit);
  }
  visit(sourceFile);
  return exported;
}

function mergeIdentifiers(
  preKnown: Set<string>,
  postKnown: Set<string>,
  checker: typescript.TypeChecker | undefined,
  node: typescript.FunctionLikeDeclaration,
  allowIdentifiers: string[],
): Set<string> {
  if (checker !== undefined) {
    const scopeIds = buildScopeIdentifiers(node, checker);
    for (const scopeId of scopeIds) {
      preKnown.add(scopeId);
      postKnown.add(scopeId);
    }
  }
  for (const allowedId of allowIdentifiers) {
    preKnown.add(allowedId);
    postKnown.add(allowedId);
  }
  const sourceFile = node.getSourceFile();
  return sourceFile ? collectExportedNames(sourceFile) : new Set<string>();
}

function resolvePrevCapture(
  node: typescript.FunctionLikeDeclaration,
  reparsedNode: typescript.FunctionLikeDeclaration,
  interfaceMethodContracts: InterfaceMethodContracts | undefined,
  location: string,
  warn: (msg: string) => void,
): string | null {
  // 1. Class-level @prev tag
  const classPrev = extractPrevExpression(reparsedNode);
  if (classPrev !== undefined) {
    // Check for multiple @prev tags
    const jsDocTags = typescript.getJSDocTags(reparsedNode);
    const prevTags = jsDocTags.filter(
      (tag) => tag.tagName.text.toLowerCase() === PREV_ID,
    );
    if (prevTags.length > 1) {
      warn(
        `[axiom] Contract validation warning in ${location}:`
        + `\n  multiple @prev tags found — using first`,
      );
    }
    return classPrev;
  }

  // 2. Interface-level @prev
  if (interfaceMethodContracts?.prevExpression !== undefined) {
    return interfaceMethodContracts.prevExpression;
  }

  // 3. Default for methods: shallow clone
  if (typescript.isMethodDeclaration(node)) {
    return '{ ...this }';
  }

  // 4. Standalone function: no default
  return null;
}

function filterPostTagsRequiringPrev(
  postTags: ContractTag[],
  prevCapture: string | null,
  location: string,
  warn: (msg: string) => void,
): ContractTag[] {
  return postTags.filter((tag) => {
    if (!expressionUsesPrev(tag.expression)) {
      return true;
    }
    if (prevCapture === null) {
      warn(
        `[axiom] Contract validation warning in ${location}:`
        + `\n  @post ${tag.expression}`
        + ` — 'prev' used but no @prev capture available; @post dropped`,
      );
      return false;
    }
    return true;
  });
}

export function filterValidTags(
  tags: ContractTag[],
  kind: 'pre' | 'post',
  location: string,
  warn: (msg: string) => void,
  knownIdentifiers: Set<string>,
  paramTypes?: Map<string, TypeMapValue>,
  checker?: typescript.TypeChecker,
  contextNode?: typescript.FunctionLikeDeclaration,
): ContractTag[] {
  return tags.filter((tag) => {
    const errors = validateExpression(
      parseContractExpression(tag.expression),
      tag.expression,
      location,
      knownIdentifiers,
      paramTypes,
      checker,
      contextNode,
    );
    if (errors.length > 0) {
      errors.forEach((err) => {
        warn(
          `[axiom] Contract validation warning in ${location}:`
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
  invariantCall: typescript.ExpressionStatement | null,
  prevCapture: string | null,
  exportedNames: Set<string>,
  keepContracts: KeepContracts,
): typescript.Statement[] {
  const statements: typescript.Statement[] = [];

  const activePre = shouldEmitPre(keepContracts) ? preTags : [];
  const activePost = shouldEmitPost(keepContracts) ? postTags : [];
  const activeInvariant = shouldEmitInvariant(keepContracts) ? invariantCall : null;

  for (const tag of activePre) {
    statements.push(buildPreCheck(tag.expression, location, factory, exportedNames));
  }

  if (activePost.length > 0 || activeInvariant !== null) {
    if (prevCapture !== null) {
      statements.push(buildPrevCapture(prevCapture, factory));
    }
    statements.push(buildBodyCapture(originalBody.statements, factory));
    for (const tag of activePost) {
      statements.push(buildPostCheck(tag.expression, location, factory, exportedNames));
    }
    if (activeInvariant !== null) {
      statements.push(activeInvariant);
    }
    statements.push(buildResultReturn(factory));
  } else {
    statements.push(...Array.from(originalBody.statements));
  }

  return statements;
}

export function normaliseArrowBody(
  factory: typescript.NodeFactory,
  node: typescript.ArrowFunction,
): typescript.ArrowFunction {
  if (typescript.isBlock(node.body)) {
    return node;
  }
  const returnStmt = factory.createReturnStatement(node.body);
  const block = factory.createBlock([returnStmt], /* multiLine */ true);
  return factory.updateArrowFunction(
    node,
    typescript.getModifiers(node),
    node.typeParameters,
    node.parameters,
    node.type,
    node.equalsGreaterThanToken,
    block,
  );
}

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
  if (typescript.isArrowFunction(node)) {
    return factory.updateArrowFunction(
      node,
      typescript.getModifiers(node),
      node.typeParameters,
      node.parameters,
      node.type,
      node.equalsGreaterThanToken,
      newBody,
    );
  }
  if (typescript.isFunctionExpression(node)) {
    return factory.updateFunctionExpression(
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

function buildTagInputs(
  classTags: ContractTag[],
  interfaceMethodContracts: InterfaceMethodContracts | undefined,
): { allPreInput: ContractTag[]; allPostInput: ContractTag[] } {
  return {
    allPreInput: [
      ...(interfaceMethodContracts?.preTags ?? []),
      ...classTags.filter((tag) => tag.kind === KIND_PRE),
    ],
    allPostInput: [
      ...(interfaceMethodContracts?.postTags ?? []),
      ...classTags.filter((tag) => tag.kind === KIND_POST),
    ],
  };
}

function shouldSkipRewrite(
  preTags: ContractTag[],
  postTags: ContractTag[],
  invariantCall: typescript.ExpressionStatement | null,
): boolean {
  return preTags.length === 0 && postTags.length === 0 && invariantCall === null;
}

function extractAndFilterTags(
  node: typescript.FunctionLikeDeclaration,
  reparsedNode: typescript.FunctionLikeDeclaration,
  interfaceMethodContracts: InterfaceMethodContracts | undefined,
  location: string,
  warn: (msg: string) => void,
  preKnown: Set<string>,
  postKnown: Set<string>,
  checker: typescript.TypeChecker | undefined,
  paramTypes: Map<string, TypeMapValue> | undefined,
  postParamTypes: Map<string, TypeMapValue> | undefined,
): {
  preTags: ContractTag[];
  postTags: ContractTag[];
  prevCapture: string | null;
} {
  const classTags = extractContractTags(reparsedNode);
  const { allPreInput, allPostInput } = buildTagInputs(classTags, interfaceMethodContracts);

  const preTags = filterValidTags(
    allPreInput, KIND_PRE, location, warn, preKnown, paramTypes, checker, node,
  );
  const postTagsWithResult = filterPostTagsWithResult(allPostInput, node, location, warn);

  const anyPostUsesPrev = postTagsWithResult.some((tag) => expressionUsesPrev(tag.expression));

  let prevCapture: string | null = null;
  if (anyPostUsesPrev) {
    prevCapture = resolvePrevCapture(
      node, reparsedNode, interfaceMethodContracts, location, warn,
    );
  }
  const postTagsFiltered = filterPostTagsRequiringPrev(
    postTagsWithResult, prevCapture, location, warn,
  );

  const postTags = filterValidTags(
    postTagsFiltered, KIND_POST, location, warn, postKnown, postParamTypes, checker, node,
  );

  return { preTags, postTags, prevCapture };
}

function rewriteFunction(
  factory: typescript.NodeFactory,
  node: typescript.FunctionLikeDeclaration,
  reparsedFunctions: Map<number, typescript.FunctionLikeDeclaration>,
  warn: (msg: string) => void,
  checker?: typescript.TypeChecker,
  invariantExpressions: string[] = [],
  interfaceMethodContracts?: InterfaceMethodContracts,
  allowIdentifiers: string[] = [],
  keepContracts: KeepContracts = false,
): typescript.FunctionLikeDeclaration | null {
  const originalBody = node.body;
  if (!originalBody || !typescript.isBlock(originalBody)) {
    return null;
  }

  const reparsedNode = reparsedFunctions.get(node.pos) ?? node;

  const location = buildLocationName(node);
  const preKnown = buildKnownIdentifiers(node, false);
  const postKnown = buildKnownIdentifiers(node, true);
  const exportedNames = mergeIdentifiers(preKnown, postKnown, checker, node, allowIdentifiers);
  const paramTypes = checker !== undefined ? buildParameterTypes(node, checker) : undefined;
  const postParamTypes = buildPostParamTypes(node, checker, paramTypes);

  const { preTags, postTags, prevCapture } = extractAndFilterTags(
    node, reparsedNode, interfaceMethodContracts, location, warn,
    preKnown, postKnown, checker, paramTypes, postParamTypes,
  );

  const invariantCall = buildInvariantCallIfNeeded(
    factory, node, location, invariantExpressions,
  );

  if (
    shouldSkipRewrite(preTags, postTags, invariantCall) ||
    allContractsFiltered(preTags, postTags, invariantCall, keepContracts)
  ) {
    return null;
  }

  const newStatements = buildGuardedStatements(
    factory, preTags, postTags, originalBody, location, invariantCall,
    prevCapture, exportedNames, keepContracts,
  );
  return applyNewBody(factory, node, factory.createBlock(newStatements, true));
}

export function tryRewriteFunction(
  factory: typescript.NodeFactory,
  node: typescript.FunctionLikeDeclaration,
  reparsedFunctions: Map<number, typescript.FunctionLikeDeclaration>,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker?: typescript.TypeChecker,
  invariantExpressions: string[] = [],
  interfaceMethodContracts?: InterfaceMethodContracts,
  allowIdentifiers: string[] = [],
  keepContracts: KeepContracts = false,
): typescript.FunctionLikeDeclaration {
  try {
    const rewritten = rewriteFunction(
      factory, node, reparsedFunctions, warn, checker,
      invariantExpressions, interfaceMethodContracts, allowIdentifiers, keepContracts,
    );
    if (rewritten === null) {
      return node;
    }
    transformed.value = true;
    return rewritten;
  } catch {
    return node;
  }
}

export { isPublicTarget };
