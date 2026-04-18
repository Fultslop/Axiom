# Closures — Task 7: Out-of-scope patterns — grandchild functions and IIFEs still warn

> **Sequence:** This is step 7 of 9. Requires Task 3 to be complete.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

Phase 2 only rewrites nested functions **one level deep** inside an outer exported function or
public method. Grandchild functions (nested inside an already-nested function) and IIFEs (immediately
invoked function expressions that are not assigned to a variable or returned) are out of scope and
must continue to trigger the `#13` misuse warning.

However, the three supported nested forms (named `FunctionDeclaration`, `const`-assigned
arrow/function expression, returned arrow) **must not** trigger the `#13` warning after Phase 2
has processed them — previously the top-level `visitNode` would fire `#13` before Phase 2 ran.

**What this task does:**

- Adds tests for all three cases: grandchild (no injection, #13 fires), IIFE (no injection, warns),
  and supported forms (no #13 warning after Phase 2 handles them).
- Narrows the `#13` check in `src/transformer.ts` so it no longer fires for nodes that Phase 2
  will handle.

**Files changed in this task:**

- `test/transformer.test.ts`
- `src/transformer.ts`

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
describe('out-of-scope nested patterns', () => {
  it('does not inject grandchild function — #13 warning still fires', () => {
    const source = `
      export function outer(): void {
        function middle(): void {
          /** @pre x > 0 */
          function inner(x: number): void { /* empty */ }
          inner(1);
        }
        middle();
      }
    `;
    const warnings: string[] = [];
    const output = typescript.transpileModule(source, {
      compilerOptions: { target: typescript.ScriptTarget.ES2019 },
      transformers: { before: [createTransformer(undefined, { warn: (msg) => warnings.push(msg) })] },
    }).outputText;
    expect(output).not.toContain('x > 0');
    expect(warnings.some((w) => w.includes('inner'))).toBe(true);
  });

  it('does not inject IIFE — warns', () => {
    const source = `
      export function outer(): void {
        /** @pre x > 0 */
        ((x: number) => { /* empty */ })(-1);
      }
    `;
    const warnings: string[] = [];
    const output = typescript.transpileModule(source, {
      compilerOptions: { target: typescript.ScriptTarget.ES2019 },
      transformers: { before: [createTransformer(undefined, { warn: (msg) => warnings.push(msg) })] },
    }).outputText;
    expect(output).not.toContain('x > 0');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('supported nested forms no longer trigger #13 warning', () => {
    const source = `
      export function outer(): void {
        /** @pre x > 0 */
        function supported(x: number): void { /* empty */ }
        supported(1);
      }
    `;
    const warnings: string[] = [];
    typescript.transpileModule(source, {
      compilerOptions: { target: typescript.ScriptTarget.ES2019 },
      transformers: { before: [createTransformer(undefined, { warn: (msg) => warnings.push(msg) })] },
    });
    expect(warnings).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to see current state**

```
npx jest --testPathPattern="transformer" -t "out-of-scope nested patterns" --no-coverage
```

The third test (supported forms no longer warn) is likely to FAIL if the `#13` check in
`visitNode` fires before Phase 2 processes the node.

- [ ] **Step 3: Narrow the `#13` check in `src/transformer.ts`**

Locate the `#13` misuse-detection block in `visitNode`. It currently fires a warning when a tagged
`FunctionDeclaration` (or similar node) is visited but is not a public target.

Update the check so that nodes matching any of the three supported nested forms are excluded:

- **Rule A** — a `FunctionDeclaration` whose immediate parent is a `Block` whose grandparent is a
  `FunctionLikeDeclaration` that is itself a public target.
- **Rule B** — an arrow function or function expression that is the initializer of a `const`
  declaration whose parent `VariableStatement` is inside such a `Block`.
- **Rule C** — an arrow function or function expression that is the expression of a
  `ReturnStatement` inside such a `Block`.

For all three cases: if the outer function-like is a public target, skip the `#13` warning — Phase
2 will handle the node.

- [ ] **Step 4: Run the tests**

```
npx jest --testPathPattern="transformer" -t "out-of-scope nested patterns" --no-coverage
```

Expected: all three PASS.

- [ ] **Step 5: Run lint and typecheck**

```
npm run lint && npm run typecheck
```

Expected: no errors.

- [ ] **Step 6: Run full suite**

```
npm test
```

Expected: all tests pass; no regressions.

---

## Done when

- `npm run lint && npm run typecheck` exit 0.
- `npm test` exits 0 with no regressions.
- All three `out-of-scope nested patterns` tests PASS.
- Grandchild functions and IIFEs continue to trigger `#13` warnings.
- Supported nested forms (Rule A, B, C) no longer trigger `#13` warnings when the outer function is
  a public target.
