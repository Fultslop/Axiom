import typescript from 'typescript';
import {
  buildCheckInvariantsCall, buildCheckInvariantsMethod, parseContractExpression,
} from './ast-builder';
import { validateExpression } from './contract-validator';
import { extractInvariantExpressions } from './jsdoc-parser';
import { buildReparsedIndex, type ReparsedIndex } from './reparsed-index';
import { tryRewriteFunction, isPublicTarget } from './function-rewriter';

const CHECK_INVARIANTS_NAME = '#checkInvariants' as const;

// ---------------------------------------------------------------------------
// Tag validation
// ---------------------------------------------------------------------------

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
