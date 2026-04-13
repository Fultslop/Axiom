# Optional Chaining in Contract Expressions — Design Doc

**Date:** 2026-04-13
**Covers issue:** #12 (optional chaining produces false-positive property warning)

---

## 1. Problem

When a contract expression uses optional chaining (`obj?.value`), the property chain validator in `collectDeepPropertyErrors` emits a false-positive "property does not exist" warning and drops the contract.

For a parameter declared as `obj: ValueCarrier | null`, `checker.getTypeAtLocation(param)` returns the full union type `ValueCarrier | null`. When `collectDeepPropertyErrors` walks the chain and reaches `value`, it calls:

```typescript
checker.getPropertyOfType(ValueCarrier | null, 'value')
```

`getPropertyOfType` only returns a symbol when **all** union members have the property. `null` has no properties, so the call returns `undefined`. This triggers the warning even though the expression `obj?.value` is perfectly valid TypeScript — the optional chain operator is precisely the programmer's acknowledgement that `obj` may be `null`.

The contract expression injects and evaluates correctly at runtime. The false positive is entirely in the validation phase.

Example that currently fails:

```typescript
/** @pre obj?.value > 0 */
export function doOptionalFn(obj: ValueCarrier | null): number | null { … }
```

---

## 2. Goal

Suppress the false-positive warning so that `obj?.value` (and equivalent chains such as `obj?.a?.b`) in contract expressions validate correctly when a TypeChecker is available.

The fix must not weaken real validation — property access on a non-nullable type that genuinely lacks the property must still produce a warning.

In transpileModule mode (no checker), behaviour is unchanged.

---

## 3. Approach

Two issues combine to produce the false positive:

1. **Union root type includes `null`/`undefined`**: The type resolved for `obj` is `ValueCarrier | null`. `getPropertyOfType` requires the property on every union member, including `null`, which never has properties.

2. **`PropertyAccessChain` is a subtype of `PropertyAccessExpression`**: TypeScript's `isPropertyAccessExpression` guard returns `true` for both plain property access and optional-chain property access. Chain extraction already works. The bug is in the type resolution step only.

The fix is a single change in `collectDeepPropertyErrors`: before walking the property chain, strip nullable constituents from the root type with `checker.getNonNullableType(rootType)`. This makes property lookup on `ValueCarrier | null` behave the same as lookup on `ValueCarrier`.

No changes are needed to `extractPropertyChain`, `resolveRootType`, or `validateExpression`.

---

## 4. Architecture

### 4.1 Change to `collectDeepPropertyErrors` (`src/contract-validator.ts`)

The only change is on the line that initialises `currentType`. After resolving the root type, strip `null` and `undefined` constituents before the property walk:

```typescript
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
        let currentType: typescript.Type = checker.getNonNullableType(rootType); // <-- changed
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
          currentType = checker.getTypeOfSymbol(symbol);
        }
      }
    }
  }
  typescript.forEachChild(node, (child) =>
    collectDeepPropertyErrors(child, expression, location, checker, contextNode, errors));
}
```

The only diff from the current implementation is replacing:

```typescript
let currentType: typescript.Type = rootType;
```

with:

```typescript
let currentType: typescript.Type = checker.getNonNullableType(rootType);
```

### 4.2 Why `getNonNullableType` is correct here

`checker.getNonNullableType(T)` removes `null` and `undefined` constituents from a union type and returns the remaining type. For `ValueCarrier | null` it returns `ValueCarrier`. For a non-nullable type like `ValueCarrier` it is a no-op. This is exactly the semantic of optional chaining: `obj?.value` asserts the programmer knows `obj` may be nullish and has guarded it with `?.`; the property `value` is expected to exist on the non-null part of the type.

Stripping nullability at the root only affects chain resolution in the validator. The runtime behaviour and the emitted code are not touched.

### 4.3 Multi-step nullable chains

For a chain like `obj?.a?.b` where `obj: ValueCarrier | null` and `a: Inner | undefined`, the fix as stated only strips nullability from the root type. Each subsequent `currentType` is derived from `checker.getTypeOfSymbol(symbol)`, which may also be a nullable union. To handle deep optional chains fully, nullability should be stripped at each step:

```typescript
currentType = checker.getNonNullableType(checker.getTypeOfSymbol(symbol));
```

This spec includes this extension since the cost is identical and it makes validation consistent with the semantics of `?.` at any chain position.

Updated inner loop:

```typescript
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
  currentType = checker.getNonNullableType(checker.getTypeOfSymbol(symbol)); // <-- strip at each step
}
```

### 4.4 No changes outside `collectDeepPropertyErrors`

- `extractPropertyChain`: `isPropertyAccessExpression` already matches `PropertyAccessChain` (optional-chain nodes are a subtype), so extraction is correct as-is.
- `resolveRootType`: unchanged.
- `validateExpression`: unchanged.
- `function-rewriter.ts`: unchanged.

---

## 5. Checker Availability

This change only affects the code path guarded by `checker !== undefined && contextNode !== undefined`. In transpileModule mode the checker is absent, `collectDeepPropertyErrors` is not called, and contracts with optional chaining are injected without validation — the same as any other contract in that mode.

---

## 6. Testing Plan

All tests should be integration-style tests that pass a real TypeChecker (not transpileModule mode) unless noted.

**False-positive fix (the primary case)**

- `@pre obj?.value > 0` on `doOptionalFn(obj: ValueCarrier | null)` where `ValueCarrier` has `value: number` → contract injected, no warning

**Existing valid-property behaviour preserved**

- `@pre obj.value > 0` on `doFn(obj: ValueCarrier)` (non-nullable, correct property) → contract injected, no warning
- `@pre this.balance > 0` on a class method where `balance` exists on the class → contract injected, no warning

**Real missing property still warns**

- `@pre obj?.missing > 0` on `doOptionalFn(obj: ValueCarrier | null)` where `ValueCarrier` does not have `missing` → unknown-identifier warning, contract dropped
- `@pre obj.missing > 0` on `doFn(obj: ValueCarrier)` where `ValueCarrier` does not have `missing` → unknown-identifier warning, contract dropped

**Multi-step optional chain**

- `@pre obj?.a?.b > 0` on `fn(obj: Outer | null)` where `Outer` has `a: Inner | undefined` and `Inner` has `b: number` → contract injected, no warning
- `@pre obj?.a?.missing > 0` on same signature where `Inner` does not have `missing` → warning on `missing`, contract dropped

**Non-nullable union (no `null`/`undefined`)**

- `@pre obj.value > 0` on `fn(obj: TypeA | TypeB)` where both `TypeA` and `TypeB` have `value: number` → contract injected, no warning
- `@pre obj.value > 0` on `fn(obj: TypeA | TypeB)` where only `TypeA` has `value` → warning, contract dropped (existing behaviour, not regressed)

**transpileModule mode (no checker)**

- `@pre obj?.value > 0` on `doOptionalFn(obj: ValueCarrier | null)` in transpileModule mode → contract injected, no warning (unchanged behaviour)

---

## 7. Out of Scope

- Optional element access (`obj?.[key]`) — `ElementAccessExpression` is not handled by `extractPropertyChain` and is out of scope for this fix.
- Optional call expressions (`fn?.()`) — not a property access; no change needed or implied.
- Nullability stripping for non-union nullable types (e.g. TypeScript's strict null enabled — same mechanism, but edge cases around `strictNullChecks` off are not tested here).
- `@invariant` expressions — optional chaining in invariants will benefit from the same fix if the validator is threaded through correctly, but that threading is not verified by this spec.
