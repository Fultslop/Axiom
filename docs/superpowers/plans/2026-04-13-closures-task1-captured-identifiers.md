# Closures — Task 1: Export `extractBindingNames` and add `buildCapturedIdentifiers`

Status: Complete

> **Sequence:** This is step 1 of 9. No prior tasks required.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

We are adding support for injecting `@pre`/`@post` contracts into nested function-like nodes (named
inner `FunctionDeclaration`, `const`-assigned arrow/function expression, and returned arrow function)
that appear inside an outer exported function or public method body.

**What this task does:**

- Exports the existing private helper `extractBindingNames` from `src/node-helpers.ts` so it can be
  reused in subsequent tasks.
- Adds `buildCapturedIdentifiers` to `src/node-helpers.ts`, which collects the outer function's
  parameters and all variable bindings that precede a given statement index into a `Set<string>`.
  This set is passed to the nested rewriter so that outer-scope names (e.g. `limit`, `MAX`) are not
  flagged as unknown identifiers in inner-function contracts.

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

Add to `test/transformer.test.ts` inside the outermost `describe('transformer', ...)` block:

```typescript
describe('buildCapturedIdentifiers — outer param and preceding const in known set', () => {
  it('does not warn when @pre references outer parameter by name', () => {
    // Without buildCapturedIdentifiers, 'limit' would be unknown.
    const source = `
      export function outer(limit: number): void {
        /** @pre x < limit */
        function check(x: number): void { /* empty */ }
        check(5);
      }
    `;
    const warnings: string[] = [];
    typescript.transpileModule(source, {
      compilerOptions: { target: typescript.ScriptTarget.ES2019 },
      transformers: { before: [createTransformer(undefined, { warn: (msg) => warnings.push(msg) })] },
    });
    expect(warnings).toHaveLength(0);
  });

  it('does not warn when @pre references a preceding const binding', () => {
    const source = `
      export function outer(): void {
        const MAX = 100;
        /** @pre x <= MAX */
        function check(x: number): void { /* empty */ }
        check(50);
      }
    `;
    const warnings: string[] = [];
    typescript.transpileModule(source, {
      compilerOptions: { target: typescript.ScriptTarget.ES2019 },
      transformers: { before: [createTransformer(undefined, { warn: (msg) => warnings.push(msg) })] },
    });
    expect(warnings).toHaveLength(0);
  });

  it('still warns when @pre references a truly unknown identifier', () => {
    const source = `
      export function outer(): void {
        /** @pre ghost > 0 */
        function inner(x: number): number { return x; }
        inner(1);
      }
    `;
    const warnings: string[] = [];
    typescript.transpileModule(source, {
      compilerOptions: { target: typescript.ScriptTarget.ES2019 },
      transformers: { before: [createTransformer(undefined, { warn: (msg) => warnings.push(msg) })] },
    });
    expect(warnings.some((w) => w.includes('ghost'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm first two fail**

```
npx jest --testPathPattern="transformer" -t "buildCapturedIdentifiers" --no-coverage
```

Expected: first two FAIL (warning about unknown identifier), third PASS.

- [ ] **Step 3: Export `extractBindingNames` in `src/node-helpers.ts`**

Change the `function extractBindingNames(` declaration from a module-private function to an
exported one:

```typescript
export function extractBindingNames(
  name: typescript.BindingName,
  names: Set<string>,
): void {
```

No other changes to `extractBindingNames`.

- [ ] **Step 4: Add `buildCapturedIdentifiers` to `src/node-helpers.ts`**

Add after `buildKnownIdentifiers`:

```typescript
export function buildCapturedIdentifiers(
  outerNode: typescript.FunctionLikeDeclaration,
  innerStatementIndex: number,
): Set<string> {
  const captured = new Set<string>();

  for (const param of outerNode.parameters) {
    extractBindingNames(param.name, captured);
  }

  const outerBody = outerNode.body;
  if (outerBody === undefined || !typescript.isBlock(outerBody)) {
    return captured;
  }
  for (let idx = 0; idx < innerStatementIndex; idx++) {
    const stmt = outerBody.statements[idx];
    if (typescript.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        extractBindingNames(decl.name, captured);
      }
    }
  }
  return captured;
}
```

- [ ] **Step 5: Run lint and typecheck**

```
npm run lint && npm run typecheck
```

Expected: no errors.

- [ ] **Step 6: Run full suite**

```
npm test
```

Expected: all tests pass; no regressions. The first two `buildCapturedIdentifiers` tests may still
fail until Phase 2 wiring in Task 3 connects the helper — if so, that is expected at this stage.

---

## Done when

- `npm run lint && npm run typecheck` exit 0.
- `npm test` exits 0 with no regressions in existing tests.
- `extractBindingNames` is exported from `src/node-helpers.ts`.
- `buildCapturedIdentifiers` is exported from `src/node-helpers.ts` and collects outer parameters
  and preceding variable declarations into a `Set<string>`.
