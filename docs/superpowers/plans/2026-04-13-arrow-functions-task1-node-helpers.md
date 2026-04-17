# Arrow Functions — Task 1: `node-helpers.ts` extensions

> **Sequence:** This is step 1 of 6. Run tasks in order; each builds on the previous.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

We are adding `@pre`/`@post` contract injection support for exported `const` arrow functions and
function expressions. This task adds two helpers to `src/node-helpers.ts` that later tasks depend on:

1. `isExportedVariableInitialiser` — predicate that returns `true` when a function-like node is
   assigned to an exported `const`.
2. `buildLocationName` extension — makes error messages use the variable name (`validate`) instead
   of `"anonymous"` when the function is an arrow/expression assigned to a `const`.

**No other files change in this task.**

---

## ESLint constraints (read before touching any `src/` file)

- `id-length: min 3` — no identifiers shorter than 3 characters.
- `complexity: 10` — keep functions small; extract helpers.
- `max-len: 100` — lines under 100 chars.
- No `console` — use the injectable `warn` callback.

---

## Steps

- [ ] **Step 1: Write a smoke-test in `test/transformer.test.ts`**

Add inside a new `describe` block (or alongside existing ones). This test verifies the new
exports compile and the existing suite still passes — the real location-string assertion comes in
Task 5.

```typescript
describe('buildLocationName for arrow and function expressions', () => {
  it('returns variable name for arrow function assigned to exported const', () => {
    const source = `
      export const validate = /** @pre x > 0 */ (x: number): boolean => x > 0;
    `;
    // Full injection is wired in Task 4. Here we just confirm no throw on valid input
    // and that the helpers compile correctly.
    expect(() => transform(source)).not.toThrow();
  });
});
```

- [ ] **Step 2: Extend `buildLocationName` in `src/node-helpers.ts`**

Add two new cases **before** the final `return 'anonymous'` fallback:

```typescript
  if (
    (typescript.isArrowFunction(node) || typescript.isFunctionExpression(node)) &&
    typescript.isVariableDeclaration(node.parent) &&
    typescript.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  if (typescript.isFunctionExpression(node) && node.name !== undefined) {
    return node.name.text;
  }
```

- [ ] **Step 3: Run lint and typecheck**

```
npm run lint && npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Run full test suite**

```
npm test
```

Expected: all existing tests pass; no regressions. The smoke-test from Step 1 also passes.

---

## Done when

- `npm run lint && npm run typecheck` exit 0.
- `npm test` exits 0 with no regressions.
- `buildLocationName` returns the variable name for arrow/function-expression nodes whose parent
  is a `VariableDeclaration` with an identifier name.

> **Note:** `isExportedVariableInitialiser` is intentionally deferred to Task 4. knip rejects
> unused exports, and this function has no caller until `transformer.ts` imports it in Task 4.