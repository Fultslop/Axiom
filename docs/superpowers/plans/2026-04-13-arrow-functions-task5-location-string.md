# Arrow Functions — Task 5: Assert location string uses variable name

> **Sequence:** This is step 5 of 6. Tasks 1–4 must be complete before starting this task.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

We are adding `@pre`/`@post` contract injection support for exported `const` arrow functions and
function expressions.

**What previous tasks added (already in the codebase):**
- Task 1: `isExportedVariableInitialiser` + extended `buildLocationName` in `src/node-helpers.ts`
- Task 2: JSDoc fallback in `src/jsdoc-parser.ts`
- Task 3: `normaliseArrowBody` + extended `applyNewBody` in `src/function-rewriter.ts`
- Task 4: `VariableStatement` dispatch wired in `src/transformer.ts`; all three arrow tests pass

**What this task does:**
Adds an explicit assertion that `ContractError` messages use the variable name (e.g. `"validate"`)
and never `"anonymous"`. The `buildLocationName` change in Task 1 should make this pass
immediately. If it does not, see the troubleshooting note below.

**Only `test/transformer.test.ts` changes in this task.**

---

## Steps

- [ ] **Step 1: Add the location-string test to `test/transformer.test.ts`**

Tests assert on compiled string output — this is the existing pattern in this codebase.
There is no `loadFunction` helper; do not invent one.

The location name is embedded in the injected `ContractViolationError` call as a string literal.
Assert that the compiled output contains `'validate'` and does not contain `'anonymous'`.

```typescript
describe('location string for arrow function', () => {
  it('uses the variable name in the ContractError message', () => {
    const source = `
      export const validate = /** @pre x > 0 */ (x: number): boolean => x > 0;
    `;
    const compiled = transform(source);
    expect(compiled).toContain('ContractViolationError');
    expect(compiled).toContain('"validate"');
    expect(compiled).not.toContain('"anonymous"');
  });
});
```

- [ ] **Step 2: Run the new test**

```
npx jest --testPathPattern="transformer" -t "location string for arrow function" --no-coverage
```

Expected: PASS.

**If it fails:** `normaliseArrowBody` returns a new synthesised `ArrowFunction` node whose parent
pointers are not set. Fix `rewriteVariableDeclaration` in `src/transformer.ts` (Task 4 file) to
pass the **original** `init` node to `tryRewriteFunction` for location resolution while using the
normalised node for body rewriting only. Adjust the helper signature accordingly.

- [ ] **Step 3: Run full test suite**

```
npm test
```

Expected: all tests pass.

---

## Done when

- `npm test` exits 0 — all tests green.
- The new test asserts `compiled.toContain('"validate"')` and `not.toContain('"anonymous"')` — both pass.
