# Closures — Task 5: Verify `@prev` behaviour for nested closures

> **Sequence:** This is step 5 of 9. Requires Task 3 to be complete.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

`resolvePrevCapture` already returns `null` for non-method nodes, and `filterPostTagsRequiringPrev`
already emits a warning when `prev` is used in a `@post` but no `@prev` capture is available. This
task verifies that both behaviours work correctly for the nested/closure case through Phase 2.

**What this task does:**

- Confirms that a nested closure with an explicit `@prev` tag correctly captures state and injects
  the `@post` guard.
- Confirms that a nested closure that uses `prev` in `@post` without a `@prev` tag emits the
  standard warning citing the nested location string.

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
describe('nested closure — @prev behaviour', () => {
  it('injects @post with explicit @prev capturing outer state', () => {
    const source = `
      export function outer(state: { count: number }): () => number {
        /**
         * @prev { count: state.count }
         * @post result >= prev.count
         */
        return (): number => ++state.count;
      }
    `;
    const warnings: string[] = [];
    const output = typescript.transpileModule(source, {
      compilerOptions: { target: typescript.ScriptTarget.ES2019 },
      transformers: { before: [createTransformer(undefined, { warn: (msg) => warnings.push(msg) })] },
    }).outputText;
    expect(warnings).toHaveLength(0);
    expect(output).toContain('prev.count');
  });

  it('emits warning and drops @post when @prev is absent but prev is used', () => {
    const source = `
      export function outer(state: { count: number }): () => number {
        /** @post result >= prev.count */
        return (): number => ++state.count;
      }
    `;
    const warnings: string[] = [];
    typescript.transpileModule(source, {
      compilerOptions: { target: typescript.ScriptTarget.ES2019 },
      transformers: { before: [createTransformer(undefined, { warn: (msg) => warnings.push(msg) })] },
    });
    expect(
      warnings.some(
        (w) =>
          w.includes("'prev' used but no @prev capture available") &&
          w.includes('outer > (anonymous)'),
      ),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests**

```
npx jest --testPathPattern="transformer" -t "nested closure — @prev behaviour" --no-coverage
```

Expected: both PASS (the machinery is in place from `rewriteNestedFunctionLike` after Task 3).

If either FAILS, investigate whether `resolvePrevCapture` and `filterPostTagsRequiringPrev` are
being called correctly from `rewriteNestedFunctionLike`.

- [ ] **Step 3: Run full suite**

```
npm test
```

Expected: all tests pass.

---

## Done when

- `npm test` exits 0.
- Both `nested closure — @prev behaviour` tests PASS.
- Warning message for the missing-`@prev` case includes the nested location string
  (`outer > (anonymous)`).
