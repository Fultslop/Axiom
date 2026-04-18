import typescript from 'typescript';
import {
  buildPreCheck, buildPostCheck, buildBodyCapture, buildResultReturn,
  buildCheckInvariantsCall, buildPrevCapture,
} from './ast-builder';
import { buildLocationName, buildKnownIdentifiers, isPublicTarget } from './node-helpers';
import { buildParameterTypes, buildPostParamTypes } from './type-helpers';
import type { ContractTag } from './jsdoc-parser';
import type { InterfaceMethodContracts } from './interface-resolver';
import {
  type KeepContracts,
  shouldEmitPre,
  shouldEmitPost,
  shouldEmitInvariant,
} from './keep-contracts';
import { extractAndFilterTags } from './tag-pipeline';
import type { TransformerContext } from './transformer-context';

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

function enrichKnownIdentifiers(
  preKnown: Set<string>,
  postKnown: Set<string>,
  checker: typescript.TypeChecker | undefined,
  node: typescript.FunctionLikeDeclaration,
  allowIdentifiers: string[],
): void {
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
  isAsync: boolean,
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
    statements.push(buildBodyCapture(originalBody.statements, factory, isAsync));
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

function isAsyncFunction(node: typescript.FunctionLikeDeclaration): boolean {
  const modifiers = typescript.canHaveModifiers(node)
    ? typescript.getModifiers(node) ?? []
    : [];
  return modifiers.some((mod) => mod.kind === typescript.SyntaxKind.AsyncKeyword);
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

function shouldSkipRewrite(
  preTags: ContractTag[],
  postTags: ContractTag[],
  invariantCall: typescript.ExpressionStatement | null,
): boolean {
  return preTags.length === 0 && postTags.length === 0 && invariantCall === null;
}

function noContractsToEmit(
  preTags: ContractTag[],
  postTags: ContractTag[],
  invariantCall: typescript.ExpressionStatement | null,
  keepContracts: KeepContracts,
): boolean {
  return (
    shouldSkipRewrite(preTags, postTags, invariantCall) ||
    allContractsFiltered(preTags, postTags, invariantCall, keepContracts)
  );
}

function rewriteFunction(
  node: typescript.FunctionLikeDeclaration,
  ctx: TransformerContext,
  invariantExpressions: string[] = [],
  interfaceMethodContracts?: InterfaceMethodContracts,
  locationNode: typescript.FunctionLikeDeclaration = node,
): typescript.FunctionLikeDeclaration | null {
  const { factory, warn, checker, allowIdentifiers, keepContracts } = ctx;
  const reparsedFunctions = ctx.reparsedIndex.functions;

  const originalBody = node.body;
  if (!originalBody || !typescript.isBlock(originalBody)) {
    return null;
  }

  const reparsedNode = reparsedFunctions.get(node.pos) ?? node;

  const location = buildLocationName(locationNode);
  const preKnown = buildKnownIdentifiers(node, false);
  const postKnown = buildKnownIdentifiers(node, true);
  enrichKnownIdentifiers(preKnown, postKnown, checker, node, allowIdentifiers);
  const sourceFile = node.getSourceFile();
  const exportedNames = sourceFile ? collectExportedNames(sourceFile) : new Set<string>();
  const paramTypes = checker !== undefined ? buildParameterTypes(node, checker) : undefined;
  const postParamTypes = buildPostParamTypes(node, checker, paramTypes);

  const { preTags, postTags, prevCapture } = extractAndFilterTags(
    node, reparsedNode, interfaceMethodContracts, location, warn,
    preKnown, postKnown, checker, paramTypes, postParamTypes,
  );

  const invariantCall = buildInvariantCallIfNeeded(
    factory, node, location, invariantExpressions,
  );

  if (noContractsToEmit(preTags, postTags, invariantCall, keepContracts)) {
    return null;
  }

  const asyncFlag = isAsyncFunction(node);

  const newStatements = buildGuardedStatements(
    factory, preTags, postTags, originalBody, location, invariantCall,
    prevCapture, exportedNames, keepContracts, asyncFlag,
  );
  return applyNewBody(factory, node, factory.createBlock(newStatements, true));
}

export function tryRewriteFunction(
  node: typescript.FunctionLikeDeclaration,
  ctx: TransformerContext,
  invariantExpressions?: string[],
  interfaceMethodContracts?: InterfaceMethodContracts,
  locationNode?: typescript.FunctionLikeDeclaration,
): typescript.FunctionLikeDeclaration {
  try {
    const rewritten = rewriteFunction(
      node, ctx, invariantExpressions, interfaceMethodContracts, locationNode,
    );
    if (rewritten === null) {
      return node;
    }
    ctx.transformed.value = true;
    return rewritten;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    ctx.warn(
      `[axiom] Internal error in ${buildLocationName(node)}: ${errMsg}`,
    );
    return node;
  }
}

export { isPublicTarget };
