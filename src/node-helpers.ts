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

export function buildLocationName(node: typescript.FunctionLikeDeclaration): string {
  if (typescript.isMethodDeclaration(node)) {
    const className =
      typescript.isClassDeclaration(node.parent) && node.parent.name
        ? node.parent.name.text
        : 'UnknownClass';
    const methodName =
      typescript.isIdentifier(node.name) ? node.name.text : 'unknownMethod';
    return `${className}.${methodName}`;
  }
  if (typescript.isFunctionDeclaration(node) && node.name) {
    return node.name.text;
  }
  return 'anonymous';
}

export function buildKnownIdentifiers(
  node: typescript.FunctionLikeDeclaration,
  includeResult: boolean,
): Set<string> {
  const names = new Set<string>(['this']);
  for (const param of node.parameters) {
    if (typescript.isIdentifier(param.name)) {
      names.add(param.name.text);
    }
  }
  if (includeResult) {
    names.add('result');
    names.add('prev');
  }
  return names;
}
