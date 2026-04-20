import typescript from 'typescript';
import {
  buildCheckInvariantsCall, buildCheckInvariantsMethod, parseContractExpression,
  buildPreCheck, buildPostCheck,
} from './ast-builder';
import {
  extractInvariantExpressions,
  extractContractTags,
  extractPrevExpression,
  extractContractTagsFromNode,
} from './jsdoc-parser';
import { validateExpression } from './contract-validator';
import {
  tryRewriteFunction, isPublicTarget,
} from './function-rewriter';
import { filterValidTags } from './tag-pipeline';
import {
  shouldEmitPre,
  shouldEmitPost,
  shouldEmitInvariant,
} from './keep-contracts';
import { buildKnownIdentifiers } from './node-helpers';
import { buildParameterTypes } from './type-helpers';
import type { ContractTag } from './jsdoc-parser';
import {
  resolveInterfaceContracts,
  resolveBaseClassContracts,
  type InterfaceContracts,
  type InterfaceMethodContracts,
  type BaseClassContracts,
} from './interface-resolver';
import {
  KIND_PRE, KIND_POST, expressionUsesResult, expressionUsesPrev,
} from './contract-utils';
import type { TransformerContext } from './transformer-context';

const CHECK_INVARIANTS_NAME = '#checkInvariants' as const;

function filterConstructorPostTags(
  postTags: ContractTag[],
  className: string,
  warn: (msg: string) => void,
): ContractTag[] {
  return postTags.filter((tag) => {
    if (expressionUsesResult(tag.expression)) {
      warn(
        `[axiom] Contract validation warning in ${className}:`
        + `\n  @post ${tag.expression}`
        + ` — 'result' used in constructor @post; @post dropped`,
      );
      return false;
    }
    if (expressionUsesPrev(tag.expression)) {
      warn(
        `[axiom] Contract validation warning in ${className}:`
        + `\n  @post ${tag.expression}`
        + ` — 'prev' used in constructor @post; @post dropped`,
      );
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
          `[axiom] Invariant validation warning in ${className}:`
          + `\n  @invariant ${err.expression} — ${err.message}`,
        );
      });
      return false;
    }
    return true;
  });
}

function hasResolvableHeritageClauses(node: typescript.ClassDeclaration): boolean {
  if (node.heritageClauses === undefined) {
    return false;
  }
  return node.heritageClauses.some(
    (clause) =>
      clause.token === typescript.SyntaxKind.ImplementsKeyword ||
      clause.token === typescript.SyntaxKind.ExtendsKeyword,
  );
}

function mergeContractSets(
  primary: InterfaceContracts,
  secondary: BaseClassContracts,
): InterfaceContracts {
  const merged: InterfaceContracts = {
    methods: new Map(primary.methods),
    invariants: primary.invariants,
  };
  secondary.methods.forEach((contracts, methodName) => {
    const existing = merged.methods.get(methodName);
    if (existing === undefined) {
      merged.methods.set(methodName, contracts);
    } else {
      const mergedPrev = existing.prevExpression ?? contracts.prevExpression;
      const mergedMethod: InterfaceMethodContracts = {
        preTags: [...existing.preTags, ...contracts.preTags],
        postTags: [...existing.postTags, ...contracts.postTags],
        sourceInterface: existing.sourceInterface,
      };
      if (mergedPrev !== undefined) {
        mergedMethod.prevExpression = mergedPrev;
      }
      merged.methods.set(methodName, mergedMethod);
    }
  });
  return merged;
}

function emitMethodMergeWarnings(
  ifaceContracts: InterfaceMethodContracts,
  reparsedNode: typescript.FunctionLikeDeclaration,
  location: string,
  className: string,
  warn: (msg: string) => void,
): void {
  const classTags = extractContractTags(reparsedNode);
  const ifaceName = ifaceContracts.sourceInterface;
  if (
    ifaceContracts.preTags.length > 0 &&
    classTags.some((tag) => tag.kind === KIND_PRE)
  ) {
    warn(
      `[axiom] Contract merge warning in ${location}:`
      + `\n  both ${ifaceName} and ${className} define @pre tags`
      + ' — additive merge applied',
    );
  }
  if (
    ifaceContracts.postTags.length > 0 &&
    classTags.some((tag) => tag.kind === KIND_POST)
  ) {
    warn(
      `[axiom] Contract merge warning in ${location}:`
      + `\n  both ${ifaceName} and ${className} define @post tags`
      + ' — additive merge applied',
    );
  }
  const ifacePrev = ifaceContracts.prevExpression;
  const classPrev = extractPrevExpression(reparsedNode);
  if (ifacePrev !== undefined && classPrev !== undefined) {
    warn(
      `[axiom] Contract merge warning in ${location}:`
      + `\n  both ${ifaceName} and ${className} define @prev — class-level takes precedence`,
    );
  }
}

function hasClashingMember(node: typescript.ClassDeclaration): boolean {
  return node.members.some(
    (member) =>
      (typescript.isMethodDeclaration(member) || typescript.isPropertyDeclaration(member)) &&
      typescript.isPrivateIdentifier(member.name) &&
      member.name.text === CHECK_INVARIANTS_NAME,
  );
}

function buildConstructorKnown(
  node: typescript.ConstructorDeclaration,
  ctx: TransformerContext,
): {
  preKnown: Set<string>;
  postKnown: Set<string>;
  paramTypes: ReturnType<typeof buildParameterTypes> | undefined;
} {
  const { checker, allowIdentifiers } = ctx;
  const preKnown = buildKnownIdentifiers(node, false);
  const postKnown = buildKnownIdentifiers(node, false);
  const paramTypes = checker !== undefined ? buildParameterTypes(node, checker) : undefined;
  for (const allowedId of allowIdentifiers) {
    preKnown.add(allowedId);
    postKnown.add(allowedId);
  }
  return { preKnown, postKnown, paramTypes };
}

function buildConstructorBodyStatements(
  originalBody: typescript.Block,
  activePre: ContractTag[],
  activePost: ContractTag[],
  hasInvariants: boolean,
  location: string,
  factory: typescript.NodeFactory,
  exportedNames: Set<string>,
): typescript.Statement[] {
  const statements: typescript.Statement[] = [];
  for (const tag of activePre) {
    statements.push(buildPreCheck(tag.expression, location, factory, exportedNames));
  }
  statements.push(...Array.from(originalBody.statements));
  for (const tag of activePost) {
    statements.push(buildPostCheck(tag.expression, location, factory, exportedNames));
  }
  if (hasInvariants) {
    statements.push(buildCheckInvariantsCall(location, factory));
  }
  return statements;
}

function rewriteConstructor(
  node: typescript.ConstructorDeclaration,
  className: string,
  ctx: TransformerContext,
  effectiveInvariants: string[],
): typescript.ConstructorDeclaration {
  const { factory, warn, checker, keepContracts } = ctx;
  const originalBody = node.body;
  if (!originalBody) {
    return node;
  }
  const location = className;
  const reparsedNode = ctx.reparsedIndex.functions.get(node.pos) ?? node;
  const allTags = extractContractTags(reparsedNode);
  const allPreInput = allTags.filter((tag) => tag.kind === KIND_PRE);
  const allPostInput = allTags.filter((tag) => tag.kind === KIND_POST);

  const filteredPost = filterConstructorPostTags(allPostInput, className, warn);

  const { preKnown, postKnown, paramTypes } = buildConstructorKnown(node, ctx);

  const preTags = filterValidTags(
    allPreInput, KIND_PRE, location, warn, preKnown, paramTypes, checker, node,
  );
  const postTags = filterValidTags(
    filteredPost, KIND_POST, location, warn, postKnown, paramTypes, checker, node,
  );

  const hasInvariants = effectiveInvariants.length > 0
    && shouldEmitInvariant(keepContracts);
  const activePre = shouldEmitPre(keepContracts) ? preTags : [];
  const activePost = shouldEmitPost(keepContracts) ? postTags : [];
  const exportedNames = new Set<string>();

  if (
    activePre.length === 0 &&
    activePost.length === 0 &&
    !hasInvariants
  ) {
    return node;
  }

  const statements = buildConstructorBodyStatements(
    originalBody, activePre, activePost, hasInvariants, location, factory, exportedNames,
  );

  return factory.updateConstructorDeclaration(
    node,
    typescript.getModifiers(node),
    node.parameters,
    factory.createBlock(statements, true),
  );
}

function lookupIfaceMethodContracts(
  member: typescript.MethodDeclaration,
  ctx: TransformerContext,
  interfaceContracts: InterfaceContracts,
  className: string,
): InterfaceMethodContracts | undefined {
  const { warn } = ctx;
  if (!typescript.isIdentifier(member.name)) {
    return undefined;
  }
  const methodName = member.name.text;
  const ifaceContracts = interfaceContracts.methods.get(methodName);
  if (ifaceContracts === undefined) {
    return undefined;
  }
  const reparsedNode = ctx.reparsedIndex.functions.get(member.pos) ?? member;
  const location = `${className}.${methodName}`;
  emitMethodMergeWarnings(
    ifaceContracts, reparsedNode, location, className, warn,
  );
  return ifaceContracts;
}

function rewriteMember(
  member: typescript.ClassElement,
  ctx: TransformerContext,
  effectiveInvariants: string[],
  className: string,
  interfaceContracts: InterfaceContracts,
): { element: typescript.ClassElement; changed: boolean } {
  if (typescript.isMethodDeclaration(member) && isPublicTarget(member)) {
    const ifaceMethodContracts = lookupIfaceMethodContracts(
      member, ctx, interfaceContracts, className,
    );
    const rewritten = tryRewriteFunction(
      member, ctx, effectiveInvariants, ifaceMethodContracts,
    );
    return {
      element: rewritten as typescript.MethodDeclaration,
      changed: rewritten !== member,
    };
  }
  if (typescript.isConstructorDeclaration(member)) {
    const rewritten = rewriteConstructor(member, className, ctx, effectiveInvariants);
    return { element: rewritten, changed: rewritten !== member };
  }
  return { element: member, changed: false };
}

function getBaseClassName(node: typescript.ClassDeclaration): string {
  const extendsClause = node.heritageClauses?.find(
    (clause) => clause.token === typescript.SyntaxKind.ExtendsKeyword,
  );
  const expr = extendsClause?.types[0]?.expression;
  return expr !== undefined && typescript.isIdentifier(expr) ? expr.text : 'base class';
}

function resolveEffectiveInvariants(
  node: typescript.ClassDeclaration,
  reparsedClass: typescript.ClassDeclaration | typescript.Node,
  className: string,
  warn: (msg: string) => void,
  interfaceInvariants: string[],
  baseClassInvariants: string[] = [],
  baseClassName: string = 'base class',
): string[] {
  const classRaw = extractInvariantExpressions(reparsedClass);
  const sources: string[] = [];
  if (interfaceInvariants.length > 0) {
    sources.push('interface');
  }
  if (baseClassInvariants.length > 0) {
    sources.push(baseClassName);
  }
  if (classRaw.length > 0) {
    sources.push(className);
  }
  if (sources.length > 1) {
    warn(
      `[axiom] Contract merge warning in ${className}:`
      + `\n  ${sources.join(', ')} all define @invariant tags`
      + ' — additive merge applied',
    );
  }

  const allRaw = [...interfaceInvariants, ...baseClassInvariants, ...classRaw];
  const valid = filterValidInvariants(allRaw, className, warn);

  if (valid.length > 0 && hasClashingMember(node)) {
    warn(
      `[axiom] Cannot inject invariants into`
      + ` ${className}: ${CHECK_INVARIANTS_NAME} already defined`,
    );
    return [];
  }
  return valid;
}

function rewriteMembers(
  members: readonly typescript.ClassElement[],
  ctx: TransformerContext,
  effectiveInvariants: string[],
  className: string,
  interfaceContracts: InterfaceContracts,
): { elements: typescript.ClassElement[]; changed: boolean } {
  let classTransformed = false;
  const newMembers: typescript.ClassElement[] = [];

  members.forEach((member) => {
    const result = rewriteMember(member, ctx, effectiveInvariants, className, interfaceContracts);
    if (result.changed) {
      classTransformed = true;
    }
    newMembers.push(result.element);
  });

  return { elements: newMembers, changed: classTransformed };
}

function emitClassBodyWarning(
  node: typescript.ClassDeclaration,
  ctx: TransformerContext,
  className: string,
): void {
  const { warn } = ctx;
  const classContractTags = extractContractTagsFromNode(node);
  const reparsedClass = ctx.reparsedIndex.classes.get(node.pos) ?? node;
  const reparsedClassContractTags = extractContractTagsFromNode(reparsedClass);
  if (classContractTags.length > 0 || reparsedClassContractTags.length > 0) {
    warn(
      `[axiom] Warning: @pre/@post on a class declaration is not supported`
      + ` — annotate individual methods instead (in ${className})`,
    );
  }
}

function resolveClassContracts(
  node: typescript.ClassDeclaration,
  ctx: TransformerContext,
  className: string,
): { interfaceContracts: InterfaceContracts; effectiveInvariants: string[] } {
  const { warn, checker } = ctx;
  if (checker === undefined && hasResolvableHeritageClauses(node)) {
    warn(
      `[axiom] Interface contract resolution skipped in ${node.getSourceFile().fileName}:`
      + '\n  no TypeChecker available (transpileModule mode)'
      + ' — class-level contracts unaffected',
    );
  }
  const ifaceOnly: InterfaceContracts = checker !== undefined
    ? resolveInterfaceContracts(node, checker, ctx.reparsedCache, warn, ctx.paramMismatch)
    : { methods: new Map(), invariants: [] };
  const baseContracts: BaseClassContracts = checker !== undefined
    ? resolveBaseClassContracts(node, checker, ctx.reparsedCache, warn, ctx.paramMismatch)
    : { methods: new Map(), invariants: [] };
  const interfaceContracts = mergeContractSets(ifaceOnly, baseContracts);
  const reparsedClass = ctx.reparsedIndex.classes.get(node.pos) ?? node;
  const effectiveInvariants = resolveEffectiveInvariants(
    node, reparsedClass, className, warn,
    ifaceOnly.invariants, baseContracts.invariants, getBaseClassName(node),
  );
  return { interfaceContracts, effectiveInvariants };
}

function rewriteClass(
  node: typescript.ClassDeclaration,
  ctx: TransformerContext,
): typescript.ClassDeclaration {
  const { factory, keepContracts } = ctx;
  const className = node.name?.text ?? 'UnknownClass';

  emitClassBodyWarning(node, ctx, className);

  const { interfaceContracts, effectiveInvariants } = resolveClassContracts(node, ctx, className);

  const invariantsForMembers = shouldEmitInvariant(keepContracts) ? effectiveInvariants : [];
  const { elements: newMembers, changed: classTransformed } = rewriteMembers(
    node.members, ctx, invariantsForMembers, className, interfaceContracts,
  );

  const finalMembers = [...newMembers];
  let finalTransformed = classTransformed;

  if (effectiveInvariants.length > 0 && shouldEmitInvariant(keepContracts)) {
    finalMembers.push(buildCheckInvariantsMethod(effectiveInvariants, factory));
    finalTransformed = true;
  }

  if (!finalTransformed) {
    return node;
  }

  ctx.transformed.value = true;
  return factory.updateClassDeclaration(
    node,
    typescript.getModifiers(node),
    node.name,
    node.typeParameters,
    node.heritageClauses,
    finalMembers,
  );
}

export function tryRewriteClass(
  node: typescript.ClassDeclaration,
  ctx: TransformerContext,
): typescript.ClassDeclaration {
  try {
    return rewriteClass(node, ctx);
  } catch (err) {
    const className = node.name?.text ?? 'UnknownClass';
    const errMsg = err instanceof Error ? err.message : String(err);
    ctx.warn(
      `[axiom] Internal error in ${className}: ${errMsg}`,
    );
    return node;
  }
}
