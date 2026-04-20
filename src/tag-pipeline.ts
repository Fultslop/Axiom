import typescript from 'typescript';
import type { ContractTag } from './jsdoc-parser';
import { extractContractTags, extractPrevExpression } from './jsdoc-parser';
import { validateExpression } from './contract-validator';
import { parseContractExpression } from './ast-builder';
import { findUnsupportedExpressionNode } from './reifier';
import type { InterfaceMethodContracts } from './interface-resolver';
import type { TypeMapValue } from './type-helpers';
import {
  expressionUsesResult, expressionUsesPrev,
  KIND_PRE, KIND_POST, PREV_ID,
} from './contract-utils';
import { isPublicTarget } from './node-helpers';

const RETURN_TYPE_OK = 'ok' as const;
const PROMISE_TYPE = 'Promise' as const;

function resolvePromiseTypeArg(
  typeNode: typescript.TypeNode,
): typescript.SyntaxKind | undefined {
  if (!typescript.isTypeReferenceNode(typeNode)) {
    return undefined;
  }
  const typeName = typescript.isIdentifier(typeNode.typeName)
    ? typeNode.typeName.text
    : undefined;
  if (typeName !== PROMISE_TYPE) {
    return undefined;
  }
  const args = typeNode.typeArguments;
  if (args === undefined || args.length !== 1) {
    return undefined;
  }
  const inner = args[0]!.kind;
  if (
    inner === typescript.SyntaxKind.VoidKeyword ||
    inner === typescript.SyntaxKind.NeverKeyword ||
    inner === typescript.SyntaxKind.UndefinedKeyword
  ) {
    return inner;
  }
  return undefined;
}

function returnTypeDescription(node: typescript.FunctionLikeDeclaration): string | undefined {
  const typeNode = node.type;
  if (typeNode === undefined) {
    return undefined;
  }
  if (
    typeNode.kind === typescript.SyntaxKind.VoidKeyword ||
    typeNode.kind === typescript.SyntaxKind.NeverKeyword ||
    typeNode.kind === typescript.SyntaxKind.UndefinedKeyword
  ) {
    return typescript.tokenToString(typeNode.kind) ?? 'void';
  }
  const innerKind = resolvePromiseTypeArg(typeNode);
  if (innerKind !== undefined) {
    return typescript.tokenToString(innerKind) ?? 'void';
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
    const parsed = parseContractExpression(tag.expression);
    const unsupported = findUnsupportedExpressionNode(parsed);
    if (unsupported !== undefined) {
      warn(
        `[axiom] Warning: @${kind} ${tag.expression} — ${unsupported}`
        + ` (in ${location}); tag dropped`,
      );
      return false;
    }
    const errors = validateExpression(
      parsed,
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

export function extractAndFilterTags(
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

// ---------------------------------------------------------------------------
// Nested supported-form detection
// ---------------------------------------------------------------------------

/**
 * Returns true for nodes that Phase 2 (tryRewriteFunction) will handle, so
 * that the `#13` misuse warning should be suppressed in visitNode.
 *
 * Rule A — FunctionDeclaration whose grandparent is a public target Block.
 * Rule B — Arrow/function expression in a `const` whose VariableStatement is
 *          inside a public-target Block.
 * Rule C — Arrow/function expression that is the expression of a ReturnStatement
 *          inside a public-target Block.
 */
function isPublicTargetLike(candidate: typescript.Node): boolean {
  return (
    (typescript.isFunctionDeclaration(candidate) ||
      typescript.isMethodDeclaration(candidate) ||
      typescript.isArrowFunction(candidate)) &&
    isPublicTarget(candidate)
  );
}

function isNestedSupportedFormRuleA(node: typescript.FunctionDeclaration): boolean {
  const { parent } = node;
  if (!typescript.isBlock(parent)) {
    return false;
  }
  const grandparent = parent.parent;
  return (
    typescript.isFunctionLike(grandparent) &&
    (typescript.isFunctionDeclaration(grandparent) ||
      typescript.isMethodDeclaration(grandparent) ||
      typescript.isArrowFunction(grandparent)) &&
    isPublicTarget(grandparent)
  );
}

function isNestedSupportedFormRuleB(parent: typescript.Node): boolean {
  if (
    !typescript.isVariableDeclaration(parent) ||
    !typescript.isIdentifier(parent.name)
  ) {
    return false;
  }
  const varDeclList = parent.parent;
  if (!typescript.isVariableDeclarationList(varDeclList)) {
    return false;
  }
  const varStmt = varDeclList.parent;
  if (!typescript.isVariableStatement(varStmt)) {
    return false;
  }
  const varStmtParent = varStmt.parent;
  if (!typescript.isBlock(varStmtParent)) {
    return false;
  }
  const blockParent = varStmtParent.parent;
  return typescript.isFunctionLike(blockParent) && isPublicTargetLike(blockParent);
}

function isNestedSupportedFormRuleC(parent: typescript.Node): boolean {
  if (!typescript.isReturnStatement(parent)) {
    return false;
  }
  const returnParent = parent.parent;
  if (!typescript.isBlock(returnParent)) {
    return false;
  }
  const blockParent = returnParent.parent;
  return typescript.isFunctionLike(blockParent) && isPublicTargetLike(blockParent);
}

export function isNestedSupportedForm(node: typescript.Node): boolean {
  if (typescript.isFunctionDeclaration(node)) {
    return isNestedSupportedFormRuleA(node);
  }
  if (!typescript.isArrowFunction(node) && !typescript.isFunctionExpression(node)) {
    return false;
  }
  const { parent } = node;
  if (parent === undefined) {
    return false;
  }
  return isNestedSupportedFormRuleB(parent) || isNestedSupportedFormRuleC(parent);
}

/**
 * Returns true if node is an IIFE -- an arrow/function expression used as the
 * callee of a CallExpression that is not assigned to a variable.
 *
 * Example: a block-comment pre-condition annotation above an IIFE call:
 *   `((x) => { })(-1)` where the contract comment precedes the call expression.
 * The JSDoc comment sits above the call expression, not on the arrow itself,
 * so getJSDocTags(CallExpression) returns nothing. This function provides a
 * structural shortcut so that the #13 warning can fire for IIFEs correctly.
 */
export function isIIFEPattern(node: typescript.Node): boolean {
  if (!typescript.isCallExpression(node)) {
    return false;
  }
  let callee: typescript.Node = node.expression;
  // Unwrap parenthesized expressions: ((x) => {})(1) -> callee is ParenExpr -> inner is Arrow
  while (typescript.isParenthesizedExpression(callee)) {
    callee = callee.expression;
  }
  return (
    typescript.isArrowFunction(callee) ||
    typescript.isFunctionExpression(callee)
  );
}

/**
 * Returns true if the callee of an IIFE is a supported nested form (Rule C returned
 * arrow/function expression). This is used to suppress the IIFE warning when the
 * IIFE is part of a supported pattern.
 */
export function isIIFECalleeSupportedForm(node: typescript.CallExpression): boolean {
  let callee: typescript.Node = node.expression;
  while (typescript.isParenthesizedExpression(callee)) {
    callee = callee.expression;
  }
  if (
    typescript.isArrowFunction(callee) ||
    typescript.isFunctionExpression(callee)
  ) {
    return isNestedSupportedForm(callee);
  }
  return false;
}

/**
 * Returns true if the given node (a CallExpression that is an IIFE) should NOT
 * trigger a warning -- i.e., its callee is a supported nested form (Rule C).
 * This is a convenience wrapper around isIIFECalleeSupportedForm.
 */
export function isIIFESupportedForm(node: typescript.Node): boolean {
  return typescript.isCallExpression(node) && isIIFECalleeSupportedForm(node);
}
