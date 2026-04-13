import typescript from 'typescript';
import {
  buildCheckInvariantsCall, buildCheckInvariantsMethod, parseContractExpression,
} from './ast-builder';
import {
  extractInvariantExpressions,
  extractContractTags,
  extractPrevExpression,
  extractContractTagsFromNode,
} from './jsdoc-parser';
import { validateExpression } from './contract-validator';
import { tryRewriteFunction, isPublicTarget } from './function-rewriter';
import {
  resolveInterfaceContracts,
  type InterfaceContracts,
  type InterfaceMethodContracts,
  type ParamMismatchMode,
} from './interface-resolver';
import type { ReparsedIndex } from './reparsed-index';

const CHECK_INVARIANTS_NAME = '#checkInvariants' as const;
const KIND_PRE = 'pre' as const;
const KIND_POST = 'post' as const;

export function filterValidInvariants(
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

function hasImplementsClauses(node: typescript.ClassDeclaration): boolean {
  return node.heritageClauses !== undefined && node.heritageClauses.some(
    (clause) => clause.token === typescript.SyntaxKind.ImplementsKeyword,
  );
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

function lookupIfaceMethodContracts(
  member: typescript.MethodDeclaration,
  reparsedIndex: ReparsedIndex,
  interfaceContracts: InterfaceContracts,
  className: string,
  warn: (msg: string) => void,
): InterfaceMethodContracts | undefined {
  if (!typescript.isIdentifier(member.name)) {
    return undefined;
  }
  const methodName = member.name.text;
  const ifaceContracts = interfaceContracts.methods.get(methodName);
  if (ifaceContracts === undefined) {
    return undefined;
  }
  const reparsedNode = reparsedIndex.functions.get(member.pos) ?? member;
  const location = `${className}.${methodName}`;
  emitMethodMergeWarnings(
    ifaceContracts, reparsedNode, location, className, warn,
  );
  return ifaceContracts;
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
  interfaceContracts: InterfaceContracts,
  allowIdentifiers: string[] = [],
): { element: typescript.ClassElement; changed: boolean } {
  if (typescript.isMethodDeclaration(member) && isPublicTarget(member)) {
    const ifaceMethodContracts = lookupIfaceMethodContracts(
      member, reparsedIndex, interfaceContracts, className, warn,
    );
    const rewritten = tryRewriteFunction(
      factory, member, reparsedIndex.functions, transformed, warn,
      checker, effectiveInvariants, ifaceMethodContracts, allowIdentifiers,
    );
    return {
      element: rewritten as typescript.MethodDeclaration,
      changed: rewritten !== member,
    };
  }
  if (typescript.isConstructorDeclaration(member)) {
    const constructorTags = extractContractTagsFromNode(member);
    if (constructorTags.length > 0) {
      warn(
        `[axiom] Warning: @pre/@post on constructors is not supported`
        + ` — use @invariant on the class or call pre()/post() manually`
        + ` inside the constructor body (in ${className}.constructor)`,
      );
    }
    if (effectiveInvariants.length > 0) {
      return { element: rewriteConstructor(factory, member, className), changed: true };
    }
    return { element: member, changed: false };
  }
  return { element: member, changed: false };
}

function resolveEffectiveInvariants(
  node: typescript.ClassDeclaration,
  reparsedClass: typescript.ClassDeclaration | typescript.Node,
  className: string,
  warn: (msg: string) => void,
  interfaceInvariants: string[],
): string[] {
  const classRaw = extractInvariantExpressions(reparsedClass);

  if (interfaceInvariants.length > 0 && classRaw.length > 0) {
    warn(
      `[axiom] Contract merge warning in ${className}:`
      + '\n  both interface and class define @invariant tags'
      + ' — additive merge applied',
    );
  }

  const allRaw = [...interfaceInvariants, ...classRaw];
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
  factory: typescript.NodeFactory,
  members: readonly typescript.ClassElement[],
  reparsedIndex: ReparsedIndex,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker: typescript.TypeChecker | undefined,
  effectiveInvariants: string[],
  className: string,
  interfaceContracts: InterfaceContracts,
  allowIdentifiers: string[] = [],
): { elements: typescript.ClassElement[]; changed: boolean } {
  let classTransformed = false;
  const newMembers: typescript.ClassElement[] = [];

  members.forEach((member) => {
    const result = rewriteMember(
      factory, member, reparsedIndex, transformed, warn, checker,
      effectiveInvariants, className, interfaceContracts, allowIdentifiers,
    );
    if (result.changed) {
      classTransformed = true;
    }
    newMembers.push(result.element);
  });

  return { elements: newMembers, changed: classTransformed };
}

function emitClassBodyWarning(
  node: typescript.ClassDeclaration,
  reparsedIndex: ReparsedIndex,
  className: string,
  warn: (msg: string) => void,
): void {
  const classContractTags = extractContractTagsFromNode(node);
  const reparsedClass = reparsedIndex.classes.get(node.pos) ?? node;
  const reparsedClassContractTags = extractContractTagsFromNode(reparsedClass);
  if (classContractTags.length > 0 || reparsedClassContractTags.length > 0) {
    warn(
      `[axiom] Warning: @pre/@post on a class declaration is not supported`
      + ` — annotate individual methods instead (in ${className})`,
    );
  }
}

function rewriteClass(
  factory: typescript.NodeFactory,
  node: typescript.ClassDeclaration,
  reparsedIndex: ReparsedIndex,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker: typescript.TypeChecker | undefined,
  cache: Map<string, typescript.SourceFile>,
  mode: ParamMismatchMode,
  allowIdentifiers: string[] = [],
): typescript.ClassDeclaration {
  const className = node.name?.text ?? 'UnknownClass';

  emitClassBodyWarning(node, reparsedIndex, className, warn);

  if (checker === undefined && hasImplementsClauses(node)) {
    warn(
      `[axiom] Interface contract resolution skipped in ${node.getSourceFile().fileName}:`
      + '\n  no TypeChecker available (transpileModule mode)'
      + ' — class-level contracts unaffected',
    );
  }

  const interfaceContracts: InterfaceContracts = checker !== undefined
    ? resolveInterfaceContracts(node, checker, cache, warn, mode)
    : { methods: new Map(), invariants: [] };

  const reparsedClass = reparsedIndex.classes.get(node.pos) ?? node;
  const effectiveInvariants = resolveEffectiveInvariants(
    node, reparsedClass, className, warn, interfaceContracts.invariants,
  );

  const { elements: newMembers, changed: classTransformed } = rewriteMembers(
    factory, node.members, reparsedIndex, transformed, warn, checker,
    effectiveInvariants, className, interfaceContracts, allowIdentifiers,
  );

  const finalMembers = [...newMembers];
  let finalTransformed = classTransformed;

  if (effectiveInvariants.length > 0) {
    finalMembers.push(buildCheckInvariantsMethod(effectiveInvariants, factory));
    finalTransformed = true;
  }

  if (!finalTransformed) {
    return node;
  }

  transformed.value = true;
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
  factory: typescript.NodeFactory,
  node: typescript.ClassDeclaration,
  reparsedIndex: ReparsedIndex,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker?: typescript.TypeChecker,
  cache: Map<string, typescript.SourceFile> = new Map(),
  mode: ParamMismatchMode = 'rename',
  allowIdentifiers: string[] = [],
): typescript.ClassDeclaration {
  try {
    return rewriteClass(
      factory, node, reparsedIndex, transformed, warn, checker, cache, mode, allowIdentifiers,
    );
  } catch {
    return node;
  }
}
