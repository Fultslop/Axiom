import typescript from 'typescript';

const { factory } = typescript;

const PRE_CONTRACT = 'PRE' as const;
const POST_CONTRACT = 'POST' as const;

/**
 * Rebuilds keyword / literal expression nodes using factory calls, producing
 * fully synthesized AST nodes. Returns undefined when the node is not a
 * keyword or literal handled here.
 */
function reifyLiteralOrKeyword(
  node: typescript.Expression,
): typescript.Expression | undefined {
  if (typescript.isIdentifier(node)) {
    return factory.createIdentifier(node.text);
  }
  if (typescript.isNumericLiteral(node)) {
    return factory.createNumericLiteral(node.text);
  }
  if (typescript.isStringLiteral(node)) {
    return factory.createStringLiteral(node.text);
  }
  if (node.kind === typescript.SyntaxKind.NullKeyword) {
    return factory.createNull();
  }
  if (node.kind === typescript.SyntaxKind.TrueKeyword) {
    return factory.createTrue();
  }
  if (node.kind === typescript.SyntaxKind.FalseKeyword) {
    return factory.createFalse();
  }
  if (node.kind === typescript.SyntaxKind.ThisKeyword) {
    return factory.createThis();
  }
  return undefined;
}

/**
 * Rebuilds an expression node entirely using factory calls, producing a fully
 * synthesized AST (no source-file text positions) so the printer can emit it
 * against any SourceFile — including a dummy empty one.
 *
 * Supports the subset of expression node types that appear in typical
 * design-by-contract assertions.
 */
function reifyExpression(node: typescript.Expression): typescript.Expression {
  const literalResult = reifyLiteralOrKeyword(node);
  if (literalResult !== undefined) {
    return literalResult;
  }

  if (typescript.isBinaryExpression(node)) {
    return factory.createBinaryExpression(
      reifyExpression(node.left),
      node.operatorToken.kind,
      reifyExpression(node.right),
    );
  }

  if (typescript.isPrefixUnaryExpression(node)) {
    return factory.createPrefixUnaryExpression(
      node.operator,
      reifyExpression(node.operand),
    );
  }

  if (typescript.isParenthesizedExpression(node)) {
    return factory.createParenthesizedExpression(reifyExpression(node.expression));
  }

  if (typescript.isPropertyAccessExpression(node)) {
    return factory.createPropertyAccessExpression(
      reifyExpression(node.expression),
      factory.createIdentifier(node.name.text),
    );
  }

  if (typescript.isTypeOfExpression(node)) {
    return factory.createTypeOfExpression(reifyExpression(node.expression));
  }

  throw new Error(`Unsupported expression node kind: ${typescript.SyntaxKind[node.kind]}`);
}

/**
 * Rebuilds a statement node using factory calls, producing a fully synthesized
 * AST for printing against any SourceFile.
 */
function reifyStatement(node: typescript.Statement): typescript.Statement {
  if (typescript.isExpressionStatement(node)) {
    return factory.createExpressionStatement(reifyExpression(node.expression));
  }

  if (typescript.isReturnStatement(node)) {
    return factory.createReturnStatement(
      node.expression !== undefined ? reifyExpression(node.expression) : undefined,
    );
  }

  if (typescript.isVariableStatement(node)) {
    return factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        Array.from(node.declarationList.declarations).map((decl) =>
          factory.createVariableDeclaration(
            typescript.isIdentifier(decl.name)
              ? factory.createIdentifier(decl.name.text)
              : decl.name,
            undefined,
            undefined,
            decl.initializer !== undefined
              ? reifyExpression(decl.initializer)
              : undefined,
          ),
        ),
        node.declarationList.flags,
      ),
    );
  }

  if (typescript.isIfStatement(node)) {
    return factory.createIfStatement(
      reifyExpression(node.expression),
      reifyStatement(node.thenStatement),
      node.elseStatement !== undefined
        ? reifyStatement(node.elseStatement)
        : undefined,
    );
  }

  if (typescript.isBlock(node)) {
    return factory.createBlock(Array.from(node.statements).map(reifyStatement), true);
  }

  throw new Error(`Unsupported statement node kind: ${typescript.SyntaxKind[node.kind]}`);
}

function buildThrowContractViolation(
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
  expression: string,
  body: typescript.ThrowStatement,
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

  const synthesizedCondition = reifyExpression(parsedCondition.expression);

  return factory.createIfStatement(synthesizedCondition, body);
}

export function buildPreCheck(expression: string, location: string): typescript.IfStatement {
  return buildGuardIf(
    expression,
    buildThrowContractViolation(PRE_CONTRACT, expression, location),
  );
}

export function buildPostCheck(expression: string, location: string): typescript.IfStatement {
  return buildGuardIf(
    expression,
    buildThrowContractViolation(POST_CONTRACT, expression, location),
  );
}

export function buildBodyCapture(
  originalStatements: typescript.NodeArray<typescript.Statement>,
): typescript.VariableStatement {
  const reifiedStatements = Array.from(originalStatements).map(reifyStatement);

  const iife = factory.createCallExpression(
    factory.createArrowFunction(
      undefined,
      undefined,
      [],
      undefined,
      factory.createToken(typescript.SyntaxKind.EqualsGreaterThanToken),
      factory.createBlock(reifiedStatements, true),
    ),
    undefined,
    [],
  );

  return factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [factory.createVariableDeclaration(
        factory.createIdentifier('result'),
        undefined,
        undefined,
        iife,
      )],
      typescript.NodeFlags.Const,
    ),
  );
}

export function buildResultReturn(): typescript.ReturnStatement {
  return factory.createReturnStatement(factory.createIdentifier('result'));
}
