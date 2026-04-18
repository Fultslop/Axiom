# Closures — Task 2: Add `buildNestedLocationName` to `node-helpers.ts`

> **Sequence:** This is step 2 of 9. No prior tasks required (can run in parallel with Task 1).
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

We are adding support for injecting `@pre`/`@post` contracts into nested function-like nodes inside
outer exported functions or public methods.

**What this task does:**

Adds `buildNestedLocationName` to `src/node-helpers.ts`. This helper produces location strings of
the form `OuterName > innerName` (or `OuterName > (anonymous)` for returned arrow functions without
a variable name). These strings appear in contract violation messages and warnings so users can
identify exactly which nested function failed.

**Files changed in this task:**

- `src/node-helpers.ts`
- `test/transformer.test.ts`

---

## ESLint constraints (read before touching any `src/` file)

- `id-length: min 3` — no identifiers shorter than 3 characters.
- `complexity: 10` — keep functions small; extract helpers.
- `max-len: 100` — lines under 100 chars.
- No `console` — use the injectable `warn` callback.

---

## Steps

- [ ] **Step 1: Write the failing tests**

Add to `test/transformer.test.ts`:

```typescript
describe('nested location string format', () => {
  it('uses OuterName > innerName for named inner function', () => {
    const source = `
      export function processItems(items: string[]): string[] {
        /** @pre item.length > 0 */
        function sanitise(item: string): string { return item.trim(); }
        return items.map(sanitise);
      }
    `;
    const output = typescript.transpileModule(source, {
      compilerOptions: { target: typescript.ScriptTarget.ES2019 },
      transformers: { before: [createTransformer()] },
    }).outputText;
    expect(output).toContain('processItems > sanitise');
  });

  it('uses OuterName > variableName for const-assigned arrow', () => {
    const source = `
      export function makeAdder(base: number) {
        /** @pre x > 0 */
        const add = (x: number): number => base + x;
        return add;
      }
    `;
    const output = typescript.transpileModule(source, {
      compilerOptions: { target: typescript.ScriptTarget.ES2019 },
      transformers: { before: [createTransformer()] },
    }).outputText;
    expect(output).toContain('makeAdder > add');
  });

  it('uses OuterName > (anonymous) for returned arrow', () => {
    const source = `
      export function makeAdder(base: number) {
        /** @pre x > 0 */
        return (x: number): number => base + x;
      }
    `;
    const output = typescript.transpileModule(source, {
      compilerOptions: { target: typescript.ScriptTarget.ES2019 },
      transformers: { before: [createTransformer()] },
    }).outputText;
    expect(output).toContain('makeAdder > (anonymous)');
  });
});
```

- [ ] **Step 2: Run to confirm all three fail**

```
npx jest --testPathPattern="transformer" -t "nested location string format" --no-coverage
```

Expected: all three FAIL (nested rewrite not yet wired up).

- [ ] **Step 3: Add `buildNestedLocationName` to `src/node-helpers.ts`**

Add after `buildLocationName`:

```typescript
export function buildNestedLocationName(
  outerNode: typescript.FunctionLikeDeclaration,
  innerNode: typescript.FunctionLikeDeclaration,
  variableName?: string,
): string {
  const outerName = buildLocationName(outerNode);

  let innerName: string;
  if (
    typescript.isFunctionDeclaration(innerNode) &&
    innerNode.name !== undefined &&
    typescript.isIdentifier(innerNode.name)
  ) {
    innerName = innerNode.name.text;
  } else if (variableName !== undefined) {
    innerName = variableName;
  } else {
    innerName = '(anonymous)';
  }

  return `${outerName} > ${innerName}`;
}
```

- [ ] **Step 4: Run lint and typecheck**

```
npm run lint && npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Run full suite**

```
npm test
```

Expected: all existing tests pass. The three `nested location string format` tests will still fail
until Phase 2 is wired in Task 3 — that is expected here.

---

## Done when

- `npm run lint && npm run typecheck` exit 0.
- `npm test` exits 0 with no regressions in existing tests.
- `buildNestedLocationName` is exported from `src/node-helpers.ts` and produces
  `OuterName > innerName`, `OuterName > variableName`, or `OuterName > (anonymous)` as appropriate.
