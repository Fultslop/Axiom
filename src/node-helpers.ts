import typescript from 'typescript';

export function isPublicTarget(node: typescript.FunctionLikeDeclaration): boolean {
  const modifiers = typescript.canHaveModifiers(node)
    ? typescript.getModifiers(node) ?? []
    : [];

  const isPrivateOrProtected = modifiers.some(
    (mod) =>
      mod.kind === typescript.SyntaxKind.PrivateKeyword ||
      mod.kind === typescript.SyntaxKind.ProtectedKeyword,
  );

  const isExportedFunction =
    typescript.isFunctionDeclaration(node) &&
    modifiers.some((mod) => mod.kind === typescript.SyntaxKind.ExportKeyword);

  const isPublicMethod = typescript.isMethodDeclaration(node) && !isPrivateOrProtected;

  return isExportedFunction || isPublicMethod;
}

export function isExportedVariableInitialiser(
  node: typescript.FunctionLikeDeclaration,
): boolean {
  if (
    !typescript.isArrowFunction(node) &&
    !typescript.isFunctionExpression(node)
  ) {
    return false;
  }
  const varDecl = node.parent;
  if (varDecl === undefined || !typescript.isVariableDeclaration(varDecl)) {
    return false;
  }
  const varDeclList = varDecl.parent;
  if (!typescript.isVariableDeclarationList(varDeclList)) {
    return false;
  }
  const varStmt = varDeclList.parent;
  if (!typescript.isVariableStatement(varStmt)) {
    return false;
  }
  const modifiers = typescript.canHaveModifiers(varStmt)
    ? typescript.getModifiers(varStmt) ?? []
    : [];
  return modifiers.some((mod) => mod.kind === typescript.SyntaxKind.ExportKeyword);
}

function buildMethodLocationName(node: typescript.MethodDeclaration): string {
  const className =
    typescript.isClassDeclaration(node.parent) && node.parent.name
      ? node.parent.name.text
      : 'UnknownClass';
  const methodName =
    typescript.isIdentifier(node.name) ? node.name.text : 'unknownMethod';
  return `${className}.${methodName}`;
}

function buildArrowExpressionName(
  node: typescript.ArrowFunction | typescript.FunctionExpression,
): string {
  if (
    node.parent !== undefined &&
    typescript.isVariableDeclaration(node.parent) &&
    typescript.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  if (typescript.isFunctionExpression(node) && node.name !== undefined) {
    return node.name.text;
  }
  return 'anonymous';
}

export function buildLocationName(node: typescript.FunctionLikeDeclaration): string {
  if (typescript.isMethodDeclaration(node)) {
    return buildMethodLocationName(node);
  }
  if (typescript.isFunctionDeclaration(node) && node.name) {
    return node.name.text;
  }
  if (typescript.isArrowFunction(node) || typescript.isFunctionExpression(node)) {
    return buildArrowExpressionName(node);
  }
  return 'anonymous';
}

function extractBindingNames(
  name: typescript.BindingName,
  names: Set<string>,
): void {
  if (typescript.isIdentifier(name)) {
    names.add(name.text);
  } else if (typescript.isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      extractBindingNames(element.name, names);
    }
  } else if (typescript.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (!typescript.isOmittedExpression(element)) {
        extractBindingNames(element.name, names);
      }
    }
  }
}

export function buildKnownIdentifiers(
  node: typescript.FunctionLikeDeclaration,
  includeResult: boolean,
): Set<string> {
  const names = new Set<string>(['this']);
  for (const param of node.parameters) {
    extractBindingNames(param.name, names);
  }
  if (includeResult) {
    names.add('result');
    names.add('prev');
  }
  return names;
}
