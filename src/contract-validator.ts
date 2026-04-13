import typescript from 'typescript';

export type ValidationErrorKind =
  | 'assignment-in-expression'
  | 'unknown-identifier'
  | 'type-mismatch';

export type SimpleType = 'number' | 'string' | 'boolean';
export type TypeMapValue = SimpleType | 'non-primitive';

const TYPE_NUMBER: SimpleType = 'number';
const TYPE_STRING: SimpleType = 'string';
const TYPE_BOOLEAN: SimpleType = 'boolean';
const TYPE_NON_PRIMITIVE: TypeMapValue = 'non-primitive';
const ROOT_THIS = 'this';

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

interface PropertyChain {
  root: string;
  properties: string[];
}

function extractPropertyChain(
  node: typescript.Node,
): PropertyChain | undefined {
  if (typescript.isPropertyAccessExpression(node)) {
    const inner = extractPropertyChain(node.expression);
    if (inner === undefined) {
      return undefined;
    }
    return { root: inner.root, properties: [...inner.properties, node.name.text] };
  }
  if (typescript.isIdentifier(node)) {
    return { root: node.text, properties: [] };
  }
  if (node.kind === typescript.SyntaxKind.ThisKeyword) {
    return { root: ROOT_THIS, properties: [] };
  }
  return undefined;
}

function resolveRootType(
  rootName: string,
  checker: typescript.TypeChecker,
  contextNode: typescript.FunctionLikeDeclaration,
): typescript.Type | undefined {
  if (rootName === ROOT_THIS) {
    if (typescript.isClassDeclaration(contextNode.parent)) {
      const classType = checker.getTypeAtLocation(contextNode.parent);
      if (classType !== undefined) {
        return classType;
      }
    }
    return undefined;
  }
  for (const param of contextNode.parameters) {
    if (typescript.isIdentifier(param.name) && param.name.text === rootName) {
      return checker.getTypeAtLocation(param);
    }
  }
  return undefined;
}

function collectDeepPropertyErrors(
  node: typescript.Node,
  expression: string,
  location: string,
  checker: typescript.TypeChecker,
  contextNode: typescript.FunctionLikeDeclaration,
  errors: ValidationError[],
): void {
  if (typescript.isPropertyAccessExpression(node)) {
    const chain = extractPropertyChain(node);
    if (chain !== undefined && chain.properties.length > 0) {
      const rootType = resolveRootType(chain.root, checker, contextNode);
      if (rootType !== undefined) {
        let currentType: typescript.Type = checker.getNonNullableType(rootType);
        for (const prop of chain.properties) {
          const symbol = checker.getPropertyOfType(currentType, prop);
          if (symbol === undefined) {
            errors.push({
              kind: 'unknown-identifier',
              expression,
              location,
              message: `property '${prop}' does not exist`
                + ` on type '${checker.typeToString(currentType)}'`,
            });
            break;
          }
          currentType = checker.getNonNullableType(checker.getTypeOfSymbol(symbol));
        }
      }
    }
    // Don't recursively check child PropertyAccessExpressions - we already validated the full chain
  } else {
    typescript.forEachChild(node, (child) =>
      collectDeepPropertyErrors(child, expression, location, checker, contextNode, errors));
  }
}

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
  if (typescript.isNoSubstitutionTemplateLiteral(node)) {
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
  paramType: TypeMapValue | undefined,
  litType: SimpleType | undefined,
  expression: string,
  location: string,
  errors: ValidationError[],
): void {
  if (paramId !== undefined && paramType !== undefined && litType !== undefined) {
    if (paramType === TYPE_NON_PRIMITIVE) {
      errors.push({
        kind: 'type-mismatch',
        expression,
        location,
        message: `type mismatch: '${paramId.text}' is not a primitive type`
          + ` but compared to ${litType} literal`,
      });
    } else if (paramType !== litType) {
      errors.push({
        kind: 'type-mismatch',
        expression,
        location,
        message: `type mismatch: '${paramId.text}' is ${paramType}`
          + ` but compared to ${litType} literal`,
      });
    }
  }
}

function extractIdentifierOperand(
  node: typescript.Node,
): typescript.Identifier | undefined {
  let result: typescript.Identifier | undefined;
  if (typescript.isIdentifier(node)) {
    result = node;
  } else if (
    typescript.isPrefixUnaryExpression(node) &&
    (
      node.operator === typescript.SyntaxKind.MinusToken ||
      node.operator === typescript.SyntaxKind.PlusToken ||
      node.operator === typescript.SyntaxKind.ExclamationToken
    ) &&
    typescript.isIdentifier(node.operand)
  ) {
    result = node.operand;
  }
  return result;
}

function collectTypeMismatches(
  node: typescript.Node,
  expression: string,
  location: string,
  paramTypes: Map<string, TypeMapValue>,
  errors: ValidationError[],
): void {
  if (typescript.isBinaryExpression(node)) {
    const leftId = extractIdentifierOperand(node.left);
    const rightId = extractIdentifierOperand(node.right);
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
  paramTypes?: Map<string, TypeMapValue>,
  checker?: typescript.TypeChecker,
  contextNode?: typescript.FunctionLikeDeclaration,
): ValidationError[] {
  const errors: ValidationError[] = [];
  collectAssignments(node, expression, location, errors);
  if (knownIdentifiers !== undefined) {
    collectUnknownIdentifiers(node, expression, location, knownIdentifiers, errors);
  }
  if (paramTypes !== undefined) {
    collectTypeMismatches(node, expression, location, paramTypes, errors);
  }
  if (checker !== undefined && contextNode !== undefined) {
    collectDeepPropertyErrors(node, expression, location, checker, contextNode, errors);
  }
  return errors;
}
