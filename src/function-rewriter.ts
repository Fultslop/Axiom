import typescript from 'typescript';
import {
  buildPreCheck, buildPostCheck, buildBodyCapture, buildResultReturn,
  buildCheckInvariantsCall, buildPrevCapture,
} from './ast-builder';
import {
  buildLocationName, buildKnownIdentifiers, isPublicTarget,
  buildNestedLocationName, buildCapturedIdentifiers,
} from './node-helpers';
import { buildParameterTypes, buildPostParamTypes } from './type-helpers';
import { type ContractTag, extractContractTags } from './jsdoc-parser';
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

function rewriteNestedFunctionLike(
  innerNode: typescript.FunctionLikeDeclaration,
  outerNode: typescript.FunctionLikeDeclaration,
  statementIndex: number,
  ctx: TransformerContext,
  variableName?: string,
): typescript.FunctionLikeDeclaration | null {
  const { factory, warn, checker, allowIdentifiers, keepContracts } = ctx;
  const reparsedFunctions = ctx.reparsedIndex.functions;

  const reparsedNode = reparsedFunctions.get(innerNode.pos) ?? innerNode;
  const tags = extractContractTags(reparsedNode);
  if (tags.length === 0) {
    return null;
  }

  const location = buildNestedLocationName(
    outerNode, innerNode, variableName,
  );

  const preKnown = buildKnownIdentifiers(innerNode, false);
  const postKnown = buildKnownIdentifiers(innerNode, true);
  const captured = buildCapturedIdentifiers(outerNode, statementIndex);
  for (const name of captured) {
    preKnown.add(name);
    postKnown.add(name);
  }
  enrichKnownIdentifiers(preKnown, postKnown, checker, innerNode, allowIdentifiers);

  const sourceFile = innerNode.getSourceFile();
  const exportedNames = sourceFile
    ? collectExportedNames(sourceFile)
    : new Set<string>();

  const paramTypes = checker !== undefined
    ? buildParameterTypes(innerNode, checker)
    : undefined;
  const postParamTypes = buildPostParamTypes(innerNode, checker, paramTypes);

  const { preTags, postTags, prevCapture } = extractAndFilterTags(
    innerNode, reparsedNode, undefined, location, warn,
    preKnown, postKnown, checker, paramTypes, postParamTypes,
  );

  if (noContractsToEmit(preTags, postTags, null, keepContracts)) {
    return null;
  }

  const originalBody = innerNode.body;
  if (originalBody === undefined || !typescript.isBlock(originalBody)) {
    return null;
  }

  const asyncFlag = isAsyncFunction(innerNode);
  const newStatements = buildGuardedStatements(
    factory, preTags, postTags, originalBody, location,
    null, prevCapture, exportedNames, keepContracts, asyncFlag,
  );
  return applyNewBody(
    factory, innerNode, factory.createBlock(newStatements, true),
  );
}

function rewriteRuleA(
  stmt: typescript.FunctionDeclaration,
  outerNode: typescript.FunctionLikeDeclaration,
  stmtIndex: number,
  ctx: TransformerContext,
): typescript.FunctionDeclaration | null {
  if (stmt.body === undefined) {
    return null;
  }
  const rewritten = rewriteNestedFunctionLike(
    stmt, outerNode, stmtIndex, ctx,
  );
  return rewritten !== null
    ? rewritten as typescript.FunctionDeclaration
    : null;
}

function rewriteRuleB(
  decl: typescript.VariableDeclaration,
  outerNode: typescript.FunctionLikeDeclaration,
  stmtIndex: number,
  ctx: TransformerContext,
): typescript.VariableDeclaration | null {
  const init = decl.initializer;
  if (init === undefined) {
    return null;
  }
  if (!typescript.isArrowFunction(init) && !typescript.isFunctionExpression(init)) {
    return null;
  }
  const variableName = typescript.isIdentifier(decl.name)
    ? decl.name.text
    : undefined;
  let funcNode: typescript.FunctionLikeDeclaration = init;
  if (typescript.isArrowFunction(init)) {
    funcNode = normaliseArrowBody(ctx.factory, init);
  }
  const rewritten = rewriteNestedFunctionLike(
    funcNode, outerNode, stmtIndex, ctx, variableName,
  );
  if (rewritten === null) {
    return null;
  }
  return ctx.factory.updateVariableDeclaration(
    decl, decl.name, decl.exclamationToken, decl.type,
    rewritten as typescript.Expression,
  );
}

function rewriteRuleC(
  returnStmt: typescript.ReturnStatement,
  outerNode: typescript.FunctionLikeDeclaration,
  stmtIndex: number,
  ctx: TransformerContext,
): typescript.ReturnStatement | null {
  const expr = returnStmt.expression;
  if (expr === undefined) {
    return null;
  }
  if (!typescript.isArrowFunction(expr) && !typescript.isFunctionExpression(expr)) {
    return null;
  }
  let funcNode: typescript.FunctionLikeDeclaration = expr;
  if (typescript.isArrowFunction(expr)) {
    funcNode = normaliseArrowBody(ctx.factory, expr);
  }
  const rewritten = rewriteNestedFunctionLike(
    funcNode, outerNode, stmtIndex, ctx,
  );
  if (rewritten === null) {
    return null;
  }
  return ctx.factory.updateReturnStatement(
    returnStmt, rewritten as typescript.Expression,
  );
}

function tryRewriteVariableStatement(
  stmt: typescript.VariableStatement,
  outerNode: typescript.FunctionLikeDeclaration,
  stmtIndex: number,
  ctx: TransformerContext,
): typescript.VariableStatement | null {
  const { factory } = ctx;
  const newDecls: typescript.VariableDeclaration[] = [];
  let declChanged = false;
  for (const decl of stmt.declarationList.declarations) {
    const rewritten = rewriteRuleB(decl, outerNode, stmtIndex, ctx);
    if (rewritten !== null) {
      newDecls.push(rewritten);
      declChanged = true;
    } else {
      newDecls.push(decl);
    }
  }
  if (!declChanged) {
    return null;
  }
  const newDeclList = factory.updateVariableDeclarationList(
    stmt.declarationList, newDecls,
  );
  const modifiers = typescript.canHaveModifiers(stmt)
    ? typescript.getModifiers(stmt) ?? []
    : [];
  return factory.updateVariableStatement(stmt, modifiers, newDeclList);
}

function rewriteSingleStatement(
  stmt: typescript.Statement,
  outerNode: typescript.FunctionLikeDeclaration,
  stmtIndex: number,
  ctx: TransformerContext,
): typescript.Statement | null {
  if (typescript.isFunctionDeclaration(stmt) && stmt.body !== undefined) {
    return rewriteRuleA(stmt, outerNode, stmtIndex, ctx);
  }
  if (typescript.isVariableStatement(stmt)) {
    return tryRewriteVariableStatement(stmt, outerNode, stmtIndex, ctx);
  }
  if (typescript.isReturnStatement(stmt)) {
    return rewriteRuleC(stmt, outerNode, stmtIndex, ctx);
  }
  return null;
}

function rewriteNestedFunctions(
  outerNode: typescript.FunctionLikeDeclaration,
  body: typescript.Block,
  ctx: TransformerContext,
): typescript.Block {
  const { factory } = ctx;
  const newStatements: typescript.Statement[] = [];
  let anyRewritten = false;

  const statements = Array.from(body.statements);
  for (const [idx, stmt] of statements.entries()) {
    const rewritten = rewriteSingleStatement(stmt, outerNode, idx, ctx);
    if (rewritten !== null) {
      newStatements.push(rewritten);
      anyRewritten = true;
    } else {
      newStatements.push(stmt);
    }
  }

  if (!anyRewritten) {
    return body;
  }
  ctx.transformed.value = true;
  return factory.createBlock(newStatements, true);
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
    const workingNode = rewritten ?? node;
    if (rewritten !== null) {
      ctx.transformed.value = true;
    }

    // Phase 2: rewrite nested function-like nodes
    const workingBody = workingNode.body;
    if (workingBody !== undefined && typescript.isBlock(workingBody)) {
      const nestedBody = rewriteNestedFunctions(workingNode, workingBody, ctx);
      if (nestedBody !== workingBody) {
        const updated = applyNewBody(ctx.factory, workingNode, nestedBody);
        if (updated !== null) {
          return updated;
        }
      }
    }

    return workingNode;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    ctx.warn(
      `[axiom] Internal error in ${buildLocationName(node)}: ${errMsg}`,
    );
    return node;
  }
}

export { isPublicTarget };
