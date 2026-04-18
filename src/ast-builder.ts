import typescript from 'typescript';
import { reifyExpression, reifyStatement } from './reifier';

const PRE_CONTRACT = 'PRE' as const;
const POST_CONTRACT = 'POST' as const;

export const AXIOM_RESULT_VAR = '__axiom_result__';
export const AXIOM_PREV_VAR = '__axiom_prev__';

type ContractIdentifier = 'result' | 'prev';
const IDENTIFIER_RESULT: ContractIdentifier = 'result';
const IDENTIFIER_PREV: ContractIdentifier = 'prev';

export function parseContractExpression(expression: string): typescript.Expression {
  const tempSourceFile = typescript.createSourceFile(
    'expr.ts',
    expression,
    typescript.ScriptTarget.ES2020,
    true,
  );
  const stmt = tempSourceFile.statements[0];
  if (!stmt || !typescript.isExpressionStatement(stmt)) {
    throw new Error(`Failed to parse contract expression: ${expression}`);
  }
  return stmt.expression;
}

function substituteContractIdentifiers(
  factory: typescript.NodeFactory,
  node: typescript.Expression,
  exportedNames: Set<string> = new Set(),
): typescript.Expression {
  const visitor = (child: typescript.Node): typescript.Node => {
    if (typescript.isIdentifier(child)) {
      if (child.text === IDENTIFIER_RESULT) {
        return factory.createIdentifier(AXIOM_RESULT_VAR);
      }
      if (child.text === IDENTIFIER_PREV) {
        return factory.createIdentifier(AXIOM_PREV_VAR);
      }
      if (exportedNames.has(child.text)) {
        return factory.createPropertyAccessExpression(
          factory.createIdentifier('exports'),
          factory.createIdentifier(child.text),
        );
      }
    }
    return typescript.visitEachChild(child, visitor, undefined);
  };
  return typescript.visitNode(node, visitor) as typescript.Expression;
}

function buildThrowContractViolation(
  factory: typescript.NodeFactory,
  contractType: 'PRE' | 'POST',
  expression: string,
  location: string,
): typescript.ThrowStatement {
  return factory.createThrowStatement(
    factory.createNewExpression(
      factory.createIdentifier('ContractViolationError'),
      undefined,
      [
        factory.createStringLiteral(contractType),
        factory.createStringLiteral(expression),
        factory.createStringLiteral(location),
      ],
    ),
  );
}

function buildGuardIf(
  factory: typescript.NodeFactory,
  expression: string,
  body: typescript.ThrowStatement,
  substituteIdentifiers = false,
  exportedNames: Set<string> = new Set(),
): typescript.IfStatement {
  const tempSourceFile = typescript.createSourceFile(
    'expr.ts',
    `!(${expression})`,
    typescript.ScriptTarget.ES2020,
    true,
  );

  const parsedCondition = tempSourceFile.statements[0];

  if (!parsedCondition || !typescript.isExpressionStatement(parsedCondition)) {
    throw new Error(`Failed to parse contract expression: ${expression}`);
  }

  let expressionToReify = parsedCondition.expression;
  if (substituteIdentifiers || exportedNames.size > 0) {
    expressionToReify = substituteContractIdentifiers(
      factory, parsedCondition.expression, exportedNames,
    );
  }
  const synthesizedCondition = reifyExpression(factory, expressionToReify);

  return factory.createIfStatement(synthesizedCondition, body);
}

export function buildPreCheck(
  expression: string,
  location: string,
  factory: typescript.NodeFactory = typescript.factory,
  exportedNames: Set<string> = new Set(),
): typescript.IfStatement {
  return buildGuardIf(
    factory,
    expression,
    buildThrowContractViolation(factory, PRE_CONTRACT, expression, location),
    false,
    exportedNames,
  );
}

export function buildPostCheck(
  expression: string,
  location: string,
  factory: typescript.NodeFactory = typescript.factory,
  exportedNames: Set<string> = new Set(),
): typescript.IfStatement {
  return buildGuardIf(
    factory,
    expression,
    buildThrowContractViolation(factory, POST_CONTRACT, expression, location),
    true,
    exportedNames,
  );
}

export function buildBodyCapture(
  originalStatements: typescript.NodeArray<typescript.Statement>,
  factory: typescript.NodeFactory = typescript.factory,
  isAsync: boolean = false,
): typescript.VariableStatement {
  const reifiedStatements = Array.from(originalStatements).map(
    (stmt) => reifyStatement(factory, stmt),
  );

  const asyncModifiers = isAsync
    ? [factory.createModifier(typescript.SyntaxKind.AsyncKeyword)]
    : undefined;

  const iife = factory.createCallExpression(
    factory.createArrowFunction(
      asyncModifiers,
      undefined,
      [],
      undefined,
      factory.createToken(typescript.SyntaxKind.EqualsGreaterThanToken),
      factory.createBlock(reifiedStatements, true),
    ),
    undefined,
    [],
  );

  const initialiser: typescript.Expression = isAsync
    ? factory.createAwaitExpression(iife)
    : iife;

  return factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [factory.createVariableDeclaration(
        factory.createIdentifier(AXIOM_RESULT_VAR),
        undefined,
        undefined,
        initialiser,
      )],
      typescript.NodeFlags.Const,
    ),
  );
}

function buildThrowInvariantViolation(
  factory: typescript.NodeFactory,
  expression: string,
  locationExpr: typescript.Expression,
): typescript.ThrowStatement {
  return factory.createThrowStatement(
    factory.createNewExpression(
      factory.createIdentifier('InvariantViolationError'),
      undefined,
      [factory.createStringLiteral(expression), locationExpr],
    ),
  );
}

export function buildCheckInvariantsCall(
  location: string,
  factory: typescript.NodeFactory = typescript.factory,
): typescript.ExpressionStatement {
  return factory.createExpressionStatement(
    factory.createCallExpression(
      factory.createPropertyAccessExpression(
        factory.createThis(),
        factory.createPrivateIdentifier('#checkInvariants'),
      ),
      undefined,
      [factory.createStringLiteral(location)],
    ),
  );
}

export function buildCheckInvariantsMethod(
  invariantExpressions: string[],
  factory: typescript.NodeFactory = typescript.factory,
): typescript.MethodDeclaration {
  const locationRef = factory.createIdentifier('location');
  const checks = invariantExpressions.map((expr) =>
    buildGuardIf(factory, expr, buildThrowInvariantViolation(factory, expr, locationRef)),
  );
  return factory.createMethodDeclaration(
    undefined,
    undefined,
    factory.createPrivateIdentifier('#checkInvariants'),
    undefined,
    undefined,
    [
      factory.createParameterDeclaration(
        undefined,
        undefined,
        factory.createIdentifier('location'),
        undefined,
        factory.createKeywordTypeNode(typescript.SyntaxKind.StringKeyword),
        undefined,
      ),
    ],
    factory.createKeywordTypeNode(typescript.SyntaxKind.VoidKeyword),
    factory.createBlock(checks, true),
  );
}

export function buildResultReturn(
  factory: typescript.NodeFactory = typescript.factory,
): typescript.ReturnStatement {
  return factory.createReturnStatement(factory.createIdentifier(AXIOM_RESULT_VAR));
}

export function buildPrevCapture(
  expression: string,
  factory: typescript.NodeFactory = typescript.factory,
): typescript.VariableStatement {
  // Object literals like `{ ...this }` are ambiguous in expression position
  // (they parse as blocks). Wrap in parens to force expression parsing.
  const wrapped = expression.trimStart().startsWith('{')
    ? `(${expression})`
    : expression;
  const parsed = parseContractExpression(wrapped);
  const reified = reifyExpression(factory, parsed);

  return factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [factory.createVariableDeclaration(
        factory.createIdentifier(AXIOM_PREV_VAR),
        undefined,
        undefined,
        reified,
      )],
      typescript.NodeFlags.Const,
    ),
  );
}
