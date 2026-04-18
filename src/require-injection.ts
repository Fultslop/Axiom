import typescript from 'typescript';

const AXIOM_PACKAGE = '@fultslop/axiom';
const IMPORTED_NAMES = [
  'ContractViolationError',
  'InvariantViolationError',
  'snapshot',
  'deepSnapshot',
];

function isEsmModuleKind(moduleKind: typescript.ModuleKind | undefined): boolean {
  if (moduleKind === undefined) {
    return false;
  }
  const { ModuleKind } = typescript;
  return (
    moduleKind === ModuleKind.ES2015 ||
    moduleKind === ModuleKind.ES2020 ||
    moduleKind === ModuleKind.ES2022 ||
    moduleKind === ModuleKind.ESNext ||
    moduleKind === ModuleKind.Node16 ||
    moduleKind === ModuleKind.NodeNext
  );
}

function buildEsmImportStatement(
  factory: typescript.NodeFactory,
): typescript.ImportDeclaration {
  return factory.createImportDeclaration(
    undefined,
    factory.createImportClause(
      undefined,
      undefined,
      factory.createNamedImports(
        IMPORTED_NAMES.map(name =>
          factory.createImportSpecifier(
            false,
            undefined,
            factory.createIdentifier(name),
          ),
        ),
      ),
    ),
    factory.createStringLiteral(AXIOM_PACKAGE),
  );
}

/**
 * Builds a require() binding for CJS targets, or an ESM import declaration
 * for ESM targets (NodeNext, Node16, ESNext, ES2015+).
 *
 * require() is used for CJS to prevent TypeScript's import elision from
 * dropping the synthetic import (elision skips imports with no parse-time
 * value usage; synthetic usages are invisible). ESM targets don't elide
 * value imports, so a proper import declaration is safe and required.
 */
export function buildRequireStatement(
  factory: typescript.NodeFactory,
  moduleKind?: typescript.ModuleKind,
): typescript.VariableStatement | typescript.ImportDeclaration {
  if (isEsmModuleKind(moduleKind)) {
    return buildEsmImportStatement(factory);
  }

  return factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [factory.createVariableDeclaration(
        factory.createObjectBindingPattern(
          IMPORTED_NAMES.map(name =>
            factory.createBindingElement(
              undefined,
              undefined,
              factory.createIdentifier(name),
            ),
          ),
        ),
        undefined,
        undefined,
        factory.createCallExpression(
          factory.createIdentifier('require'),
          undefined,
          [factory.createStringLiteral(AXIOM_PACKAGE)],
        ),
      )],
      typescript.NodeFlags.Const,
    ),
  );
}
