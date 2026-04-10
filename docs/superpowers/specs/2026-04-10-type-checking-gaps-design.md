# Type Checking Gaps — Design Doc

**Date:** 2026-04-10
**Covers limitations:** #2 (non-primitive parameter types), #3 (union-typed parameters), #7 (non-primitive return types), #10 (unary operands), #11 (compound conditions / type narrowing — deferred)

---

## 1. Problem

Type mismatch detection in `contract-validator.ts` uses raw `TypeFlags` comparisons (`NumberLike`, `StringLike`, `BooleanLike`) and requires both sides of a binary expression to be direct `Identifier` nodes. This produces four gaps:

- **#2** — Array, object, and interface parameter types are not represented in the type map, so `items === 42` where `items: string[]` emits no mismatch warning.
- **#3** — Union types (`number | undefined`, `T | null`) carry `TypeFlags.Union` as their primary flag, which matches none of the simple type checks. The parameter's effective type is unknown to the validator.
- **#7** — `result` is only added to the type map when the return type is a primitive. Non-primitive return types (arrays, interfaces) get no mismatch detection.
- **#10** — In `-amount > 0`, `-amount` is a `PrefixUnaryExpression`. The validator checks only direct `Identifier` nodes on each side of a binary expression, so the negated operand's type is never resolved.
- **#11** — Type narrowing established by a sibling clause (`amount !== null && amount === "zero"`) is not taken into account. This gap is explicitly deferred.

---

## 2. Goals

- Non-primitive parameter types (arrays, interfaces, objects) participate in type mismatch detection.
- Union types are resolved to their constituent primitive type for mismatch checking when unambiguous (`number | undefined` → `number`).
- `result` participates in type mismatch detection for non-primitive return types.
- Unary operands (prefix `-`, `+`, `!`) are unwrapped before type-checking the inner identifier.
- #11 (compound conditions / type narrowing) is explicitly deferred — noted in this spec and left for a future design.

---

## 3. Approach

Replace the `simpleTypeFromFlags` raw-flag approach with TypeChecker-driven type resolution where a checker is available, falling back to the existing approach in transpileModule mode.

`SimpleType = 'number' | 'string' | 'boolean'` is preserved as the currency for mismatch comparisons — it represents the simple type a literal in a contract expression can be. The extension is that the TypeChecker resolves richer parameter types *back* to `SimpleType` (or marks them as non-primitive) so they can participate in mismatch detection.

---

## 4. New type resolution helper (`src/type-helpers.ts`)

```typescript
export function resolveSimpleType(
  paramType: typescript.Type,
  checker: typescript.TypeChecker,
): SimpleType | 'non-primitive' | undefined
```

Logic:

1. **Check raw flags first** (existing `simpleTypeFromFlags` — handles plain primitive types without a full checker round-trip).
2. **Union types** (`TypeFlags.Union`): iterate constituent types, filter out `Null` and `Undefined` constituents, then:
   - If all remaining constituents map to the same `SimpleType`, return that type.
   - If constituents span multiple simple types (e.g. `number | string`), return `undefined` — too ambiguous to check.
   - If the only constituent is a non-primitive (e.g. `Point | null`), return `'non-primitive'`.
3. **Non-primitive types** (`TypeFlags.Object`, `TypeFlags.Intersection`): return `'non-primitive'`. The call site uses this sentinel to emit a mismatch warning whenever the parameter is compared against a simple literal.

### Use in `buildParameterTypes`

When a checker is available and `simpleTypeFromFlags` returns `undefined`, call `resolveSimpleType`. Store both `SimpleType` results and `'non-primitive'` in the map. The map type becomes `Map<string, SimpleType | 'non-primitive'>`.

Contract validator callers: treat `'non-primitive'` as "always mismatches a simple literal" — emit a warning whenever a `'non-primitive'` parameter is directly compared with a numeric, string, or boolean literal.

### Use in `buildPostParamTypes`

Apply the same `resolveSimpleType` call to the function's return type when populating the `result` entry in the post-param type map.

---

## 5. Unary operand unwrapping (`src/contract-validator.ts`)

### 5.1 New helper

```typescript
function extractIdentifierOperand(
  node: typescript.Node,
): typescript.Identifier | undefined {
  if (typescript.isIdentifier(node)) return node;
  if (
    typescript.isPrefixUnaryExpression(node) &&
    (node.operator === typescript.SyntaxKind.MinusToken ||
     node.operator === typescript.SyntaxKind.PlusToken ||
     node.operator === typescript.SyntaxKind.ExclamationToken)
  ) {
    return typescript.isIdentifier(node.operand) ? node.operand : undefined;
  }
  return undefined;
}
```

### 5.2 Apply in `collectTypeMismatches`

Replace the direct `typescript.isIdentifier(node.left)` and `typescript.isIdentifier(node.right)` checks with `extractIdentifierOperand(node.left)` and `extractIdentifierOperand(node.right)`.

**Type note:** For `!flag === 1`, `flag` is boolean but the expression `-flag` is also boolean, while `flag` is used as the identifier. We use the inner identifier's declared type for the mismatch check. This is conservative — it catches the obvious wrong case (`-amount === "zero"` where `amount: number`) while potentially flagging `!flag` vs number comparisons (which are also wrong).

---

## 6. Changes Summary

| File | Change |
|---|---|
| `src/type-helpers.ts` | New `resolveSimpleType` helper; extend `buildParameterTypes` and `buildPostParamTypes` to use it |
| `src/contract-validator.ts` | New `extractIdentifierOperand` helper; update `collectTypeMismatches` to use it |
| Type map signature | `Map<string, SimpleType>` → `Map<string, SimpleType \| 'non-primitive'>` in internal usage |

The `'non-primitive'` sentinel is internal to the type-checking pipeline; it is not exported.

---

## 7. Warning Messages

Existing format preserved. New cases:

- **Union resolved to primitive**: same message as existing — `'amount' is number but compared to string literal`.
- **Non-primitive vs simple literal**: `'items' is not a primitive type but compared to number literal`.
- **Unary operand**: `'amount' is string but compared to number expression` (message unchanged; unwrapping is transparent).

---

## 8. Deferral: #11 Compound Conditions / Type Narrowing

Type narrowing from sibling conditions requires data-flow analysis — knowing that `amount !== null` in the left clause of `&&` narrows the type for the right clause. This is non-trivial to implement and is only meaningful once #3 (union types) is fixed (since the motivating example uses a union parameter).

#11 is explicitly deferred to a future spec.

---

## 9. Testing Plan

### #2 — non-primitive parameter types (requires checker)
- `@pre items === 42` where `items: string[]` → type-mismatch warning
- `@pre pt === "hello"` where `pt: Point` → type-mismatch warning
- `@pre items.length > 0` where `items: string[]` → no warning (left side is a property access, not an identifier literal comparison)

### #3 — union types (requires checker)
- `@pre amount === "zero"` where `amount: number | undefined` → type-mismatch warning (resolved to number)
- `@pre label === 42` where `label: string | null` → type-mismatch warning (resolved to string)
- `@pre x === 1` where `x: number | string` → no warning (ambiguous union, check skipped)

### #7 — non-primitive return types (requires checker)
- `@post result === 42` where return type is `string` → type-mismatch warning
- `@post result === "ok"` where return type is `Record<string, unknown>` → type-mismatch warning (non-primitive vs string literal)

### #10 — unary operands
- `@pre -amount > 0` where `amount: string` → type-mismatch warning
- `@pre !flag === 1` where `flag: boolean` → type-mismatch warning (boolean vs number literal)
- `@pre -amount > 0` where `amount: number` → no warning

---

## 10. Out of Scope

- **#11 compound conditions / type narrowing** — deferred; requires data-flow analysis.
- Type-checking object literal expressions in contracts (`@pre { x: 1 }`) — out of scope.
- Generic type parameters — `resolveSimpleType` returns `undefined` for unresolved generics; mismatch detection is skipped.
- Postfix unary expressions — not addressed; postfix `++`/`--` mutate state and are already an assignment-operator violation.
