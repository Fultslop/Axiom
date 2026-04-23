# Document and Warn on `snapshot()` Shallow Spread Limitations — Design Doc

**Date:** 2026-04-22
**Covers:** Spec 004 finding #10 — `snapshot()` is a shallow spread that silently drops prototype chain and non-enumerable properties (Medium)

---

## 1. Problem

`assertions.ts` implements `snapshot()` as `{ ...obj }`. This silently drops:
- Methods and properties on the prototype chain
- Non-enumerable properties (e.g. `length` on arrays, built-in methods)
- Symbol-keyed properties
- Property descriptors (getters become evaluated values — snapshot reflects the value at call time, not the getter)

A user who writes `@prev` on a class with getter properties or inherited methods will get a snapshot that differs from the original in ways they don't expect. `@post` comparisons against `prev` then produce false positives or false negatives.

---

## 2. Goals

- Add a warning when `snapshot()` is called on an object that has getter properties (the most common source of unexpected behaviour).
- Document the limitation clearly in the `snapshot()` JSDoc and in the README.
- Do not change the default behaviour of `snapshot()` — the shallow spread is a documented trade-off, not a bug.
- Optionally: expose a `deepSnapshot`-backed variant that uses `Object.getOwnPropertyDescriptors` and `Object.create` to preserve the prototype chain.

---

## 3. Approach

### 3.1 Getter-property warning

**Location:** `src/assertions.ts`, `snapshot()` function.

After `{ ...obj }`, check whether the object has any own getter properties:

```typescript
const hasGetters = Object.getOwnPropertyNames(Object.getPrototypeOf(obj) ?? obj)
  .some((key) => {
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(obj), key);
    return desc?.get !== undefined;
  });
if (hasGetters) {
  warnFn(
    '[axiom] Warning: snapshot() uses a shallow spread — getter properties on the ' +
    'prototype chain are evaluated at snapshot time and not re-evaluated on access. ' +
    'Use deepSnapshot() for objects with getters.'
  );
}
```

The `warnFn` parameter follows the existing `warn` callback pattern. For the runtime assertion helpers (`pre`, `post`, `snapshot`), the warn callback is injected by the transformer — it is already available in context.

### 3.2 `snapshot()` JSDoc

Add a JSDoc comment to `snapshot()`:

```typescript
/**
 * Captures a shallow snapshot of an object's own enumerable properties.
 *
 * **Limitations:** prototype methods, non-enumerable properties, Symbol keys,
 * and getter property descriptors are NOT captured. For objects with getters,
 * use `deepSnapshot()`. A warning is emitted when getters are detected.
 */
```

### 3.3 `protoSnapshot()` helper (optional)

Add an opt-in `protoSnapshot(obj)` function that uses `Object.create(Object.getPrototypeOf(obj), Object.getOwnPropertyDescriptors(obj))` to preserve the prototype chain and property descriptors. This is not injected by `@prev` automatically — it must be called explicitly.

### 3.4 README documentation

Update the `@prev` section of the README to document the limitation and point to `deepSnapshot()` for complex objects.

---

## 4. Changes Summary

| File | Change |
|---|---|
| `src/assertions.ts` | Add getter-detection warning in `snapshot()`; add JSDoc comment; optionally add `protoSnapshot()` |
| `README.md` | Document `snapshot()` limitations in `@prev` section |

---

## 5. Testing Plan

- `snapshot()` on plain object `{ a: 1, b: 2 }` → returns `{ a: 1, b: 2 }`, no warning
- `snapshot()` on object with getter → warning emitted containing "getter properties"
- `snapshot()` on class instance with prototype method (no getter) → no warning (prototype methods are not getters)
- `snapshot()` on array → no warning; prototype's numeric-index accessors are not "getters" in the `get` descriptor sense
- Warning fires via the `warn` callback, not `console`

---

## 6. Out of Scope

- Changing the default behaviour of `snapshot()` to a deep clone — this is a breaking change.
- Automatically switching to `deepSnapshot()` when getters are detected — the warning is advisory only.
- Symbol-keyed property detection — the limitation is documented but not warned on (Symbol detection adds complexity for minimal user benefit).
