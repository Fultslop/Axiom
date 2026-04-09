import typescript from 'typescript';
import {
  buildCheckInvariantsCall, buildCheckInvariantsMethod, parseContractExpression,
} from './ast-builder';
import { extractInvariantExpressions } from './jsdoc-parser';
import { validateExpression } from './contract-validator';
import { tryRewriteFunction, isPublicTarget } from './function-rewriter';
import type { ReparsedIndex } from './reparsed-index';

const CHECK_INVARIANTS_NAME = '#checkInvariants' as const;

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
          `[fsprepost] Invariant validation warning in ${className}:`
          + `\n  @invariant ${err.expression} — ${err.message}`,
        );
      });
      return false;
    }
    return true;
  });
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

export function tryRewriteClass(
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
