import typescript from 'typescript';

/**
 * Builds a require() binding statement for contract error classes.
 * Injected as require() rather than import to prevent TypeScript's CJS
 * emit from eliding the import (import elision skips imports with no
 * parse-time value usage; synthetic usages are invisible).
 */
export function buildRequireStatement(
  factory: typescript.NodeFactory,
): typescript.VariableStatement {
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
