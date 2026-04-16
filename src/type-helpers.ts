import typescript from 'typescript';

export type SimpleType = 'number' | 'string' | 'boolean';

const TYPE_NON_PRIMITIVE = 'non-primitive' as const;
export type TypeMapValue = SimpleType | typeof TYPE_NON_PRIMITIVE;

function simpleTypeFromFlags(flags: number): SimpleType | undefined {
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

function resolveSimpleType(
  paramType: typescript.Type,
  _checker: typescript.TypeChecker,
): TypeMapValue | undefined {
  const direct = simpleTypeFromFlags(paramType.flags);
  if (direct !== undefined) {
    return direct;
  }
  /* eslint-disable no-bitwise */
  if (paramType.flags & typescript.TypeFlags.Union) {
    const union = paramType as typescript.UnionType;
    const nonNullable = union.types.filter(
      (constituent) => !(
        constituent.flags & typescript.TypeFlags.Null ||
        constituent.flags & typescript.TypeFlags.Undefined
      ),
    );
    if (nonNullable.length === 0) {
      return undefined;
    }
    const resolved = nonNullable.map((constituent) => simpleTypeFromFlags(constituent.flags));
    const allSame = resolved.every((val) => val !== undefined && val === resolved[0]);
    if (allSame && resolved[0] !== undefined) {
      return resolved[0];
    }
    const anyPrimitive = resolved.some((val) => val !== undefined);
    if (!anyPrimitive) {
      return TYPE_NON_PRIMITIVE;
    }
    return undefined;
  }
  if (
    paramType.flags & typescript.TypeFlags.Object ||
    paramType.flags & typescript.TypeFlags.Intersection
  ) {
    return TYPE_NON_PRIMITIVE;
  }
  /* eslint-enable no-bitwise */
  return undefined;
}

export function buildParameterTypes(
  node: typescript.FunctionLikeDeclaration,
  checker: typescript.TypeChecker,
): Map<string, TypeMapValue> {
  const types = new Map<string, TypeMapValue>();
  for (const param of node.parameters) {
    if (typescript.isIdentifier(param.name)) {
      const paramType = checker.getTypeAtLocation(param);
      const simple = simpleTypeFromFlags(paramType.flags) ??
        resolveSimpleType(paramType, checker);
      if (simple !== undefined) {
        types.set(param.name.text, simple);
      }
    }
  }
  return types;
}

export function buildPostParamTypes(
  node: typescript.FunctionLikeDeclaration,
  checker: typescript.TypeChecker | undefined,
  base: Map<string, TypeMapValue> | undefined,
): Map<string, TypeMapValue> | undefined {
  if (checker === undefined || base === undefined) {
    return base;
  }
  const sig = checker.getSignatureFromDeclaration(node);
  if (sig === undefined) {
    return base;
  }
  const returnType = checker.getReturnTypeOfSignature(sig);
  const resultType = simpleTypeFromFlags(returnType.flags) ??
    resolveSimpleType(returnType, checker);
  if (resultType === undefined) {
    return base;
  }
  const extended = new Map(base);
  extended.set('result', resultType);
  return extended;
}
