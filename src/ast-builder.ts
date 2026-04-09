import typescript from 'typescript';

const PRE_CONTRACT = 'PRE' as const;
const POST_CONTRACT = 'POST' as const;

/**
 * Rebuilds keyword / literal expression nodes using factory calls, producing
 * fully synthesized AST nodes. Returns undefined when the node is not a
 * keyword or literal handled here.
 */
function reifyLiteralOrKeyword(
  factory: typescript.NodeFactory,
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

/* eslint-disable @typescript-eslint/no-use-before-define */
function reifyCompositeExpression(
  factory: typescript.NodeFactory,
  node: typescript.Expression,
): typescript.Expression | undefined {
  if (typescript.isConditionalExpression(node)) {
    return factory.createConditionalExpression(
      reifyExpression(factory, node.condition),
      factory.createToken(typescript.SyntaxKind.QuestionToken),
      reifyExpression(factory, node.whenTrue),
      factory.createToken(typescript.SyntaxKind.ColonToken),
      reifyExpression(factory, node.whenFalse),
    );
  }
  if (typescript.isCallExpression(node)) {
    return factory.createCallExpression(
      reifyExpression(factory, node.expression),
      undefined,
      Array.from(node.arguments).map((arg) => reifyExpression(factory, arg)),
    );
  }
  if (typescript.isElementAccessExpression(node)) {
    return factory.createElementAccessExpression(
      reifyExpression(factory, node.expression),
      reifyExpression(factory, node.argumentExpression),
    );
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
function reifyExpression(
  factory: typescript.NodeFactory,
  node: typescript.Expression,
): typescript.Expression {
  const literalResult = reifyLiteralOrKeyword(factory, node);
  if (literalResult !== undefined) {
    return literalResult;
  }

  if (typescript.isBinaryExpression(node)) {
    return factory.createBinaryExpression(
      reifyExpression(factory, node.left),
      node.operatorToken.kind,
      reifyExpression(factory, node.right),
    );
  }

  if (typescript.isPrefixUnaryExpression(node)) {
    return factory.createPrefixUnaryExpression(
      node.operator,
      reifyExpression(factory, node.operand),
    );
  }

  if (typescript.isPostfixUnaryExpression(node)) {
    return factory.createPostfixUnaryExpression(
      reifyExpression(factory, node.operand),
      node.operator,
    );
  }

  if (typescript.isParenthesizedExpression(node)) {
    return factory.createParenthesizedExpression(reifyExpression(factory, node.expression));
  }

  if (typescript.isPropertyAccessExpression(node)) {
    return factory.createPropertyAccessExpression(
      reifyExpression(factory, node.expression),
      factory.createIdentifier(node.name.text),
    );
  }

  if (typescript.isTypeOfExpression(node)) {
    return factory.createTypeOfExpression(reifyExpression(factory, node.expression));
  }

  const compositeResult = reifyCompositeExpression(factory, node);
  if (compositeResult !== undefined) {
    return compositeResult;
  }

  throw new Error(`Unsupported expression node kind: ${typescript.SyntaxKind[node.kind]}`);
}

function reifyForInitializer(
  factory: typescript.NodeFactory,
  node: typescript.ForInitializer,
): typescript.ForInitializer {
  if (typescript.isVariableDeclarationList(node)) {
    return factory.createVariableDeclarationList(
      Array.from(node.declarations).map((decl) =>
        factory.createVariableDeclaration(
          typescript.isIdentifier(decl.name)
            ? factory.createIdentifier(decl.name.text)
            : decl.name,
          undefined,
          undefined,
          decl.initializer ? reifyExpression(factory, decl.initializer) : undefined,
        ),
      ),
      node.flags,
    );
  }
  return reifyExpression(factory, node);
}

function reifyIfStatement(
  factory: typescript.NodeFactory,
  node: typescript.IfStatement,
): typescript.IfStatement {
  return factory.createIfStatement(
    reifyExpression(factory, node.expression),
    reifyStatement(factory, node.thenStatement),
    node.elseStatement !== undefined ? reifyStatement(factory, node.elseStatement) : undefined,
  );
}

function reifyLoopStatement(
  factory: typescript.NodeFactory,
  node: typescript.Statement,
): typescript.Statement | undefined {
  if (typescript.isForOfStatement(node)) {
    return factory.createForOfStatement(
      node.awaitModifier,
      reifyForInitializer(factory, node.initializer),
      reifyExpression(factory, node.expression),
      reifyStatement(factory, node.statement),
    );
  }
  if (typescript.isForInStatement(node)) {
    return factory.createForInStatement(
      reifyForInitializer(factory, node.initializer),
      reifyExpression(factory, node.expression),
      reifyStatement(factory, node.statement),
    );
  }
  if (typescript.isForStatement(node)) {
    return factory.createForStatement(
      node.initializer ? reifyForInitializer(factory, node.initializer) : undefined,
      node.condition ? reifyExpression(factory, node.condition) : undefined,
      node.incrementor ? reifyExpression(factory, node.incrementor) : undefined,
      reifyStatement(factory, node.statement),
    );
  }
  if (typescript.isWhileStatement(node)) {
    return factory.createWhileStatement(
      reifyExpression(factory, node.expression),
      reifyStatement(factory, node.statement),
    );
  }
  if (typescript.isDoStatement(node)) {
    return factory.createDoStatement(
      reifyStatement(factory, node.statement),
      reifyExpression(factory, node.expression),
    );
  }
  if (typescript.isSwitchStatement(node)) {
    return factory.createSwitchStatement(
      reifyExpression(factory, node.expression),
      factory.createCaseBlock(
        Array.from(node.caseBlock.clauses).map((clause) => reifyCaseClause(factory, clause)),
      ),
    );
  }
  return undefined;
}

function reifyCaseClause(
  factory: typescript.NodeFactory,
  clause: typescript.CaseOrDefaultClause,
): typescript.CaseOrDefaultClause {
  const stmts = Array.from(clause.statements).map((stmt) => reifyStatement(factory, stmt));
  if (typescript.isCaseClause(clause)) {
    return factory.createCaseClause(reifyExpression(factory, clause.expression), stmts);
  }
  return factory.createDefaultClause(stmts);
}

/* eslint-enable @typescript-eslint/no-use-before-define */

/**
 * Rebuilds a statement node using factory calls, producing a fully synthesized
 * AST for printing against any SourceFile.
 */
function reifyStatement(
  factory: typescript.NodeFactory,
  node: typescript.Statement,
): typescript.Statement {
  if (typescript.isExpressionStatement(node)) {
    return factory.createExpressionStatement(reifyExpression(factory, node.expression));
  }

  if (typescript.isReturnStatement(node)) {
    return factory.createReturnStatement(
      node.expression !== undefined ? reifyExpression(factory, node.expression) : undefined,
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
              ? reifyExpression(factory, decl.initializer)
              : undefined,
          ),
        ),
        node.declarationList.flags,
      ),
    );
  }

  if (typescript.isIfStatement(node)) {
    return reifyIfStatement(factory, node);
  }

  if (typescript.isBlock(node)) {
    return factory.createBlock(
      Array.from(node.statements).map((stmt) => reifyStatement(factory, stmt)),
      true,
    );
  }

  if (typescript.isBreakStatement(node)) {
    return factory.createBreakStatement(node.label);
  }

  if (typescript.isContinueStatement(node)) {
    return factory.createContinueStatement(node.label);
  }

  const loopResult = reifyLoopStatement(factory, node);
  if (loopResult !== undefined) {
    return loopResult;
  }

  throw new Error(`Unsupported statement node kind: ${typescript.SyntaxKind[node.kind]}`);
}

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

  const synthesizedCondition = reifyExpression(factory, parsedCondition.expression);

  return factory.createIfStatement(synthesizedCondition, body);
}

export function buildPreCheck(
  expression: string,
  location: string,
  factory: typescript.NodeFactory = typescript.factory,
): typescript.IfStatement {
  return buildGuardIf(
    factory,
    expression,
    buildThrowContractViolation(factory, PRE_CONTRACT, expression, location),
  );
}

export function buildPostCheck(
  expression: string,
  location: string,
  factory: typescript.NodeFactory = typescript.factory,
): typescript.IfStatement {
  return buildGuardIf(
    factory,
    expression,
    buildThrowContractViolation(factory, POST_CONTRACT, expression, location),
  );
}

export function buildBodyCapture(
  originalStatements: typescript.NodeArray<typescript.Statement>,
  factory: typescript.NodeFactory = typescript.factory,
): typescript.VariableStatement {
  const reifiedStatements = Array.from(originalStatements).map(
    (stmt) => reifyStatement(factory, stmt),
  );

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
  return factory.createReturnStatement(factory.createIdentifier('result'));
}
