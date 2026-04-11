import typescript from 'typescript';

export type ValidationErrorKind =
  | 'assignment-in-expression'
  | 'unknown-identifier'
  | 'type-mismatch';

export type SimpleType = 'number' | 'string' | 'boolean';

const TYPE_NUMBER: SimpleType = 'number';
const TYPE_STRING: SimpleType = 'string';
const TYPE_BOOLEAN: SimpleType = 'boolean';

export interface ValidationError {
  kind: ValidationErrorKind;
  expression: string;
  location: string;
  message: string;
}

const ASSIGNMENT_OPERATORS = new Set([
  typescript.SyntaxKind.EqualsToken,
  typescript.SyntaxKind.PlusEqualsToken,
  typescript.SyntaxKind.MinusEqualsToken,
  typescript.SyntaxKind.AsteriskEqualsToken,
  typescript.SyntaxKind.SlashEqualsToken,
  typescript.SyntaxKind.PercentEqualsToken,
  typescript.SyntaxKind.AsteriskAsteriskEqualsToken,
  typescript.SyntaxKind.AmpersandEqualsToken,
  typescript.SyntaxKind.BarEqualsToken,
  typescript.SyntaxKind.CaretEqualsToken,
  typescript.SyntaxKind.LessThanLessThanEqualsToken,
  typescript.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  typescript.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
]);

// Identifiers that are valid in any contract expression regardless of parameters.
const GLOBAL_IDENTIFIERS = new Set([
  'undefined', 'NaN', 'Infinity', 'globalThis', 'arguments',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Math', 'JSON', 'Date', 'RegExp', 'Error',
  'Promise',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent',
  'console',
]);

function collectUnknownIdentifiers(
  node: typescript.Node,
  expression: string,
  location: string,
  known: Set<string>,
  errors: ValidationError[],
): void {
  if (typescript.isIdentifier(node)) {
    if (!known.has(node.text) && !GLOBAL_IDENTIFIERS.has(node.text)) {
      errors.push({
        kind: 'unknown-identifier',
        expression,
        location,
        message: `identifier '${node.text}' is not a known parameter in this contract expression`,
      });
    }
  } else if (typescript.isPropertyAccessExpression(node)) {
    // Check the base expression only — the property name is a member, not a variable.
    collectUnknownIdentifiers(node.expression, expression, location, known, errors);
  } else {
    typescript.forEachChild(node, (child) => {
      collectUnknownIdentifiers(child, expression, location, known, errors);
    });
  }
}

function getLiteralSimpleType(node: typescript.Node): SimpleType | undefined {
  if (typescript.isNumericLiteral(node)) {
    return TYPE_NUMBER;
  }
  if (typescript.isStringLiteral(node)) {
    return TYPE_STRING;
  }
  if (
    node.kind === typescript.SyntaxKind.TrueKeyword ||
    node.kind === typescript.SyntaxKind.FalseKeyword
  ) {
    return TYPE_BOOLEAN;
  }
  return undefined;
}

function checkSideMismatch(
  paramId: typescript.Identifier | undefined,
  paramType: SimpleType | undefined,
  litType: SimpleType | undefined,
  expression: string,
  location: string,
  errors: ValidationError[],
): void {
  if (paramType !== undefined && litType !== undefined && paramType !== litType) {
    const name = paramId!.text;
    errors.push({
      kind: 'type-mismatch',
      expression,
      location,
      message: `type mismatch: '${name}' is ${paramType} but compared to ${litType} literal`,
    });
  }
}

function collectTypeMismatches(
  node: typescript.Node,
  expression: string,
  location: string,
  paramTypes: Map<string, SimpleType>,
  errors: ValidationError[],
): void {
  if (typescript.isBinaryExpression(node)) {
    const leftId = typescript.isIdentifier(node.left) ? node.left : undefined;
    const rightId = typescript.isIdentifier(node.right) ? node.right : undefined;
    const leftParamType = leftId !== undefined ? paramTypes.get(leftId.text) : undefined;
    const rightParamType = rightId !== undefined ? paramTypes.get(rightId.text) : undefined;
    const leftLit = getLiteralSimpleType(node.left);
    const rightLit = getLiteralSimpleType(node.right);
    checkSideMismatch(leftId, leftParamType, rightLit, expression, location, errors);
    checkSideMismatch(rightId, rightParamType, leftLit, expression, location, errors);
  }
  typescript.forEachChild(node, (child) => {
    collectTypeMismatches(child, expression, location, paramTypes, errors);
  });
}

function collectAssignments(
  node: typescript.Node,
  expression: string,
  location: string,
  errors: ValidationError[],
): void {
  if (
    typescript.isBinaryExpression(node) &&
    ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)
  ) {
    const operator = node.operatorToken.getText();
    const hint = node.operatorToken.kind === typescript.SyntaxKind.EqualsToken
      ? ' (did you mean \'===\'?)'
      : '';
    errors.push({
      kind: 'assignment-in-expression',
      expression,
      location,
      message: `assignment operator '${operator}' is not allowed in contract expressions${hint}`,
    });
  }
  typescript.forEachChild(node, (child) => collectAssignments(child, expression, location, errors));
}

export function validateExpression(
  node: typescript.Expression,
  expression: string,
  location: string,
  knownIdentifiers?: Set<string>,
  paramTypes?: Map<string, SimpleType>,
): ValidationError[] {
  const errors: ValidationError[] = [];
  collectAssignments(node, expression, location, errors);
  if (knownIdentifiers !== undefined) {
    collectUnknownIdentifiers(node, expression, location, knownIdentifiers, errors);
  }
  if (paramTypes !== undefined) {
    collectTypeMismatches(node, expression, location, paramTypes, errors);
  }
  return errors;
}
