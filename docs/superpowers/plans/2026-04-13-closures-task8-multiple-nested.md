# Closures — Task 8: Multiple nested functions at the same depth are all rewritten

> **Sequence:** This is step 8 of 9. Requires Task 3 to be complete.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

`rewriteNestedFunctions` iterates all statements in the outer body, so multiple tagged nested nodes
at the same depth should all be rewritten. This task verifies that behaviour with a test covering
both a named `FunctionDeclaration` and a `const`-assigned arrow function in the same outer body.

**What this task does:**

- Adds a test that places two tagged nested nodes in the same outer function and asserts both are
  rewritten.

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
describe('multiple nested functions in the same outer function body', () => {
  it('rewrites all tagged nested nodes at the same depth', () => {
    const source = `
      export function outer(): void {
        /** @pre x > 0 */
        function named(x: number): number { return x * 2; }
        /** @pre y > 0 */
        const arrow = (y: number): number => y * 3;
        named(2);
        arrow(3);
      }
    `;
    const output = typescript.transpileModule(source, {
      compilerOptions: { target: typescript.ScriptTarget.ES2019 },
      transformers: { before: [createTransformer()] },
    }).outputText;
    expect(output).toContain('outer > named');
    expect(output).toContain('x > 0');
    expect(output).toContain('outer > arrow');
    expect(output).toContain('y > 0');
  });
});
```

- [ ] **Step 2: Run the tests**

```
npx jest --testPathPattern="transformer" -t "multiple nested functions in the same outer function body" --no-coverage
```

Expected: PASS (Phase 2 iterates all statements).

If it FAILS, check whether `rewriteNestedFunctions` short-circuits after the first rewritten node
instead of continuing through all statements.

- [ ] **Step 3: Run full suite**

```
npm test
```

Expected: all tests pass.

---

## Done when

- `npm test` exits 0.
- The multiple-nested-functions test PASSES and both `outer > named` and `outer > arrow` appear in
  the emitted output.
