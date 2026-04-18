# Closures — Task 6: Verify nested function inside a class method

Status: Complete

> **Sequence:** This is step 6 of 9. Requires Task 3 to be complete.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

`tryRewriteFunction` is already called per method by `tryRewriteClass`, so Phase 2 fires
automatically for method bodies without any additional wiring. This task verifies that behaviour
and confirms the location string format for nested functions inside class methods.

**What this task does:**

- Confirms that a named inner `FunctionDeclaration` inside a public class method is rewritten by
  Phase 2, and that the location string uses the `ClassName.methodName > innerName` format.

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
describe('nested function inside class method', () => {
  it('injects @pre with location ClassName.methodName > innerName', () => {
    const source = `
      class Processor {
        public process(items: string[]): string[] {
          /** @pre item.length > 0 */
          function sanitise(item: string): string { return item.trim(); }
          return items.map(sanitise);
        }
      }
    `;
    const output = typescript.transpileModule(source, {
      compilerOptions: { target: typescript.ScriptTarget.ES2019 },
      transformers: { before: [createTransformer()] },
    }).outputText;
    expect(output).toContain('Processor.process > sanitise');
    expect(output).toContain('item.length > 0');
  });
});
```

- [ ] **Step 2: Run the tests**

```
npx jest --testPathPattern="transformer" -t "nested function inside class method" --no-coverage
```

Expected: PASS (class methods already delegate to `tryRewriteFunction`; Phase 2 fires automatically).

If it FAILS, verify that `tryRewriteClass` passes through to `tryRewriteFunction` per method and
that `buildNestedLocationName` correctly uses `buildLocationName` (which already handles class
method location strings).

- [ ] **Step 3: Run full suite**

```
npm test
```

Expected: all tests pass.

---

## Done when

- `npm test` exits 0.
- The class-method nested function test PASSES.
- Location string in emitted output is `Processor.process > sanitise`.
