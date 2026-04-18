# Closures — Task 4: Verify `@post result` warning for nested function without return type

Status: Complete

> **Sequence:** This is step 4 of 9. Requires Task 3 to be complete.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

The existing `filterPostTagsWithResult` logic already drops `@post` tags that reference `result`
when the function has no declared return type (or is declared `void`/`never`), emitting a warning.
This task verifies that the same behaviour applies correctly to nested functions processed by Phase 2.

**What this task does:**

- Adds tests to confirm that a nested function with a `@post result` tag but no return type
  annotation emits the standard warning citing the nested location string
  (e.g. `outer > inner`), and that the `@post` is dropped.

**Files changed in this task:**

- `test/transformer.test.ts` only (no implementation changes expected).

---

## ESLint constraints (read before touching any `src/` file)

- `id-length: min 3` — no identifiers shorter than 3 characters.
- `complexity: 10` — keep functions small; extract helpers.
- `max-len: 100` — lines under 100 chars.
- No `console` — use the injectable `warn` callback.

---

## Steps

- [ ] **Step 1: Write the tests**

Add to `test/transformer.test.ts`:

```typescript
describe('nested function — @post result without return type annotation', () => {
  it('emits warning and drops @post when nested function lacks return type', () => {
    const source = `
      export function outer(): void {
        /** @post result.length > 0 */
        function inner(s: string) { return s.trim(); }
        inner('  ');
      }
    `;
    const warnings: string[] = [];
    typescript.transpileModule(source, {
      compilerOptions: { target: typescript.ScriptTarget.ES2019 },
      transformers: { before: [createTransformer(undefined, { warn: (msg) => warnings.push(msg) })] },
    });
    expect(
      warnings.some(
        (w) => w.includes("'result' used but no return type") && w.includes('outer > inner'),
      ),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests**

```
npx jest --testPathPattern="transformer" -t "nested function — @post result without return type" --no-coverage
```

Expected: PASS (covered by existing `filterPostTagsWithResult` logic, now invoked from the nested
rewriter added in Task 3).

If it FAILS, the nested rewriter is not correctly forwarding the warn callback or the location
string to the tag filtering helpers — investigate `rewriteNestedFunctionLike` in Task 3.

- [ ] **Step 3: Run full suite**

```
npm test
```

Expected: all tests pass.

---

## Done when

- `npm test` exits 0.
- The `@post result without return type` test for a nested function PASSES and the warning message
  includes the nested location string (`outer > inner`).
