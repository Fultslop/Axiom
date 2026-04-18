import typescript from 'typescript';
import type { ContractTag } from './jsdoc-parser';
import { extractContractTags, extractPrevExpression } from './jsdoc-parser';
import { validateExpression } from './contract-validator';
import { parseContractExpression } from './ast-builder';
import type { InterfaceMethodContracts } from './interface-resolver';
import type { TypeMapValue } from './type-helpers';
import {
  expressionUsesResult, expressionUsesPrev,
  KIND_PRE, KIND_POST, PREV_ID,
} from './contract-utils';

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
