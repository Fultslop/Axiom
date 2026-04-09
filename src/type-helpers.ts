import typescript from 'typescript';

export type SimpleType = 'number' | 'string' | 'boolean';

export function simpleTypeFromFlags(flags: number): SimpleType | undefined {
  /* eslint-disable no-bitwise */
  if (flags & typescript.TypeFlags.NumberLike) {
    return 'number';
  }
  if (flags & typescript.TypeFlags.StringLike) {
    return 'string';
  }
  if (flags & typescript.TypeFlags.BooleanLike) {
    return 'boolean';
  }
  /* eslint-enable no-bitwise */
  return undefined;
}

export function buildParameterTypes(
  node: typescript.FunctionLikeDeclaration,
  checker: typescript.TypeChecker,
): Map<string, SimpleType> {
  const types = new Map<string, SimpleType>();
  for (const param of node.parameters) {
    if (typescript.isIdentifier(param.name)) {
      const paramType = checker.getTypeAtLocation(param);
      const simpleType = simpleTypeFromFlags(paramType.flags);
      if (simpleType !== undefined) {
        types.set(param.name.text, simpleType);
      }
    }
  }
  return types;
}

export function buildPostParamTypes(
  node: typescript.FunctionLikeDeclaration,
  checker: typescript.TypeChecker | undefined,
  base: Map<string, SimpleType> | undefined,
): Map<string, SimpleType> | undefined {
  if (checker === undefined || base === undefined) {
    return base;
  }
  const sig = checker.getSignatureFromDeclaration(node);
  if (sig === undefined) {
    return base;
  }
  const returnType = checker.getReturnTypeOfSignature(sig);
  const resultSimpleType = simpleTypeFromFlags(returnType.flags);
  if (resultSimpleType === undefined) {
    return base;
  }
  const extended = new Map(base);
  extended.set('result', resultSimpleType);
  return extended;
}
