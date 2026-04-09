import typescript from 'typescript';
import {
  buildPreCheck, buildPostCheck, buildBodyCapture, buildResultReturn,
  parseContractExpression, buildCheckInvariantsCall,
} from './ast-builder';
import { validateExpression } from './contract-validator';
import { buildLocationName, buildKnownIdentifiers, isPublicTarget } from './node-helpers';
import { buildParameterTypes, buildPostParamTypes, type SimpleType } from './type-helpers';
import type { ContractTag } from './jsdoc-parser';
import { extractContractTags } from './jsdoc-parser';
import type { InterfaceMethodContracts } from './interface-resolver';

const KIND_PRE = 'pre' as const;
const KIND_POST = 'post' as const;
const RESULT_ID = 'result' as const;
const RETURN_TYPE_OK = 'ok' as const;

function expressionUsesResult(expression: string): boolean {
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
        `[fsprepost] Contract validation warning in ${location}:`
        + `\n  @post ${tag.expression}`
        + ` — 'result' used but no return type is declared; @post dropped`,
      );
      return false;
    }
    if (desc !== RETURN_TYPE_OK) {
      warn(
        `[fsprepost] Contract validation warning in ${location}:`
        + `\n  @post ${tag.expression}`
        + ` — 'result' used but return type is '${desc}'; @post dropped`,
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

export function applyNewBody(
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

function rewriteFunction(
  factory: typescript.NodeFactory,
  node: typescript.FunctionLikeDeclaration,
  reparsedFunctions: Map<number, typescript.FunctionLikeDeclaration>,
  warn: (msg: string) => void,
  checker?: typescript.TypeChecker,
  invariantExpressions: string[] = [],
  interfaceMethodContracts?: InterfaceMethodContracts,
): typescript.FunctionLikeDeclaration | null {
  const originalBody = node.body;
  if (!originalBody || !typescript.isBlock(originalBody)) {
    return null;
  }

  const reparsedNode = reparsedFunctions.get(node.pos) ?? node;
  const classTags = extractContractTags(reparsedNode);

  const location = buildLocationName(node);
  const preKnown = buildKnownIdentifiers(node, false);
  const postKnown = buildKnownIdentifiers(node, true);
  const paramTypes = checker !== undefined ? buildParameterTypes(node, checker) : undefined;
  const postParamTypes = buildPostParamTypes(node, checker, paramTypes);

  const { allPreInput, allPostInput } = buildTagInputs(classTags, interfaceMethodContracts);

  const preTags = filterValidTags(
    allPreInput, KIND_PRE, location, warn, preKnown, paramTypes,
  );
  const postTagsFiltered = filterPostTagsWithResult(allPostInput, node, location, warn);
  const postTags = filterValidTags(
    postTagsFiltered, KIND_POST, location, warn, postKnown, postParamTypes,
  );

  const invariantCall = buildInvariantCallIfNeeded(
    factory, node, location, invariantExpressions,
  );

  if (shouldSkipRewrite(preTags, postTags, invariantCall)) {
    return null;
  }

  const newStatements = buildGuardedStatements(
    factory, preTags, postTags, originalBody, location, invariantCall,
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
): typescript.FunctionLikeDeclaration {
  try {
    const rewritten = rewriteFunction(
      factory, node, reparsedFunctions, warn, checker,
      invariantExpressions, interfaceMethodContracts,
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
