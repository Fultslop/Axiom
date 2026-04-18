# Closures — Task 3: Add nested rewriter and wire into `tryRewriteFunction`

> **Sequence:** This is step 3 of 9. Requires Tasks 1 and 2 to be complete.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

We are adding Phase 2 of the function rewriter: a single-level walk of the (possibly-already-rewritten)
outer function body that looks for tagged nested function-like nodes and rewrites each in place.

**What this task does:**

- Adds `rewriteNestedFunctionLike` (per-node rewriter) and `rewriteNestedFunctions` (body walker) to
  `src/function-rewriter.ts`.
- Wires Phase 2 into `tryRewriteFunction` so it runs after Phase 1 (outer function's own contracts).
- Validates Rules A, B, C:
  - **Rule A** — named `FunctionDeclaration` directly in the outer body.
  - **Rule B** — `const`-assigned arrow function or function expression.
  - **Rule C** — arrow function or function expression in a `ReturnStatement`.

**Files changed in this task:**

- `src/function-rewriter.ts`
- `test/transformer.test.ts`

### API note — `TransformerContext`

This plan was written before the `TransformerContext` refactor. `tryRewriteFunction` and
`rewriteFunction` now receive a `ctx: TransformerContext` object rather than individual params.
When implementing, use `ctx.factory`, `ctx.warn`, `ctx.checker`, `ctx.allowIdentifiers`,
`ctx.keepContracts`, `ctx.reparsedIndex.functions`, and `ctx.transformed` instead of the individual
parameters shown in the plan. Pass `ctx` through to `rewriteNestedFunctions` and
`rewriteNestedFunctionLike` rather than forwarding individual fields.

### API note — `mergeIdentifiers`

The plan references a function `mergeIdentifiers` that does not exist. For `exportedNames` inside
`rewriteNestedFunctionLike`, use:

```typescript
const sourceFile = node.getSourceFile();
const exportedNames = sourceFile ? collectExportedNames(sourceFile) : new Set<string>();
```

(`collectExportedNames` is a module-private helper already present in `function-rewriter.ts`.)

### API note — tag filtering helpers

`filterPostTagsWithResult`, `filterPostTagsRequiringPrev`, and `resolvePrevCapture` are currently
module-private in `src/tag-pipeline.ts`. You have two options:
- Export them from `tag-pipeline.ts` and import them in `function-rewriter.ts`.
- Refactor `rewriteNestedFunctionLike` to call `extractAndFilterTags` (already exported) and handle
  `prevCapture` through it.

Either approach is acceptable; prefer whichever keeps the complexity under the ESLint limit.

### API note — `buildGuardedStatements`

The current `buildGuardedStatements` signature includes `keepContracts` as its last parameter.
Pass `ctx.keepContracts` when calling it from `rewriteNestedFunctionLike`.

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
describe('nested function contract injection', () => {
  it('injects @pre into named inner FunctionDeclaration (Rule A)', () => {
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
    expect(output).toContain('item.length > 0');
  });

  it('injects @pre into const-assigned arrow function (Rule B)', () => {
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
    expect(output).toContain('x > 0');
  });

  it('injects @pre into const-assigned function expression (Rule B)', () => {
    const source = `
      export function outer(): void {
        /** @pre n > 0 */
        const square = function(n: number): number { return n * n; };
        square(4);
      }
    `;
    const output = typescript.transpileModule(source, {
      compilerOptions: { target: typescript.ScriptTarget.ES2019 },
      transformers: { before: [createTransformer()] },
    }).outputText;
    expect(output).toContain('outer > square');
    expect(output).toContain('n > 0');
  });

  it('injects @pre into returned arrow function capturing outer param (Rule C)', () => {
    const source = `
      export function makeAdder(base: number) {
        /**
         * @pre x > 0
         * @pre base >= 0
         */
        return (x: number): number => base + x;
      }
    `;
    const warnings: string[] = [];
    const output = typescript.transpileModule(source, {
      compilerOptions: { target: typescript.ScriptTarget.ES2019 },
      transformers: { before: [createTransformer(undefined, { warn: (msg) => warnings.push(msg) })] },
    }).outputText;
    expect(warnings).toHaveLength(0);
    expect(output).toContain('makeAdder > (anonymous)');
    expect(output).toContain('x > 0');
    expect(output).toContain('base >= 0');
  });

  it('injects both outer and inner contracts independently', () => {
    const source = `
      /** @pre items.length > 0 */
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
    expect(output).toContain('items.length > 0');
    expect(output).toContain('processItems > sanitise');
    expect(output).toContain('item.length > 0');
  });

  it('skips inner function with no tags — no injection, no warning', () => {
    const source = `
      export function outer(): void {
        function helper(x: number): number { return x; }
        helper(1);
      }
    `;
    const warnings: string[] = [];
    const output = typescript.transpileModule(source, {
      compilerOptions: { target: typescript.ScriptTarget.ES2019 },
      transformers: { before: [createTransformer(undefined, { warn: (msg) => warnings.push(msg) })] },
    }).outputText;
    expect(warnings).toHaveLength(0);
    expect(output).not.toContain("require('@fultslop/fs-axiom')");
  });

  it('require import injected only when at least one assertion is added', () => {
    const source = `
      export function outer(): void {
        /** @pre x > 0 */
        function inner(x: number): void { /* empty */ }
        inner(1);
      }
    `;
    const output = typescript.transpileModule(source, {
      compilerOptions: { target: typescript.ScriptTarget.ES2019 },
      transformers: { before: [createTransformer()] },
    }).outputText;
    expect(output).toContain("require('@fultslop/fs-axiom')");
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

```
npx jest --testPathPattern="transformer" -t "nested function contract injection" --no-coverage
```

Expected: all FAIL.

- [ ] **Step 3: Update imports in `src/function-rewriter.ts`**

Add `buildNestedLocationName` and `buildCapturedIdentifiers` to the `node-helpers` import line.

Add `extractContractTagsForFunctionLike` to the `jsdoc-parser` import (or verify it is already
imported via another path).

If choosing to export the tag filtering helpers from `tag-pipeline.ts`, add those exports and update
the import in `function-rewriter.ts` accordingly.

- [ ] **Step 4: Add `rewriteNestedFunctionLike` to `src/function-rewriter.ts`**

Add before `rewriteFunction`. This function takes the inner node, the outer node (for location and
captured identifiers), and `ctx: TransformerContext`. It:

1. Extracts contract tags from the inner node.
2. Returns `null` if there are no tags.
3. Builds the location string via `buildNestedLocationName`.
4. Builds `preKnown` / `postKnown` via `buildKnownIdentifiers`, then adds the captured identifiers
   from `buildCapturedIdentifiers(outerNode, statementIndex)`.
5. Computes `exportedNames` via `collectExportedNames(node.getSourceFile())`.
6. Filters and validates tags (pre, post with result check, prev handling).
7. Calls `buildGuardedStatements` and `applyNewBody`.

- [ ] **Step 5: Add `rewriteNestedFunctions` to `src/function-rewriter.ts`**

Add after `rewriteNestedFunctionLike`. This function iterates the statements of the outer body:

- **Rule A** — `isFunctionDeclaration(stmt)` with a body: call `rewriteNestedFunctionLike`.
- **Rule B** — `isVariableStatement(stmt)`: for each declarator whose initializer is
  `isArrowFunction` or `isFunctionExpression`, normalise and call `rewriteNestedFunctionLike`.
- **Rule C** — `isReturnStatement(stmt)` with an arrow/function-expression `expression`: normalise
  and call `rewriteNestedFunctionLike`.

When any node is rewritten, set `ctx.transformed.value = true` and replace the statement.

Return the original `body` unchanged if nothing was rewritten (reference equality check).

- [ ] **Step 6: Wire Phase 2 into `tryRewriteFunction`**

After Phase 1 completes (call to `rewriteFunction`), obtain the working node (rewritten or
original). If the working node has a `Block` body, call `rewriteNestedFunctions` on it. If the
returned block differs from the original, call `applyNewBody` and return the updated node.

- [ ] **Step 7: Run the failing tests**

```
npx jest --testPathPattern="transformer" -t "nested function contract injection" --no-coverage
```

Expected: all PASS.

- [ ] **Step 8: Run location-string and captured-identifier tests**

```
npx jest --testPathPattern="transformer" -t "nested location string format" --no-coverage
npx jest --testPathPattern="transformer" -t "buildCapturedIdentifiers" --no-coverage
```

Expected: all PASS.

- [ ] **Step 9: Run lint and typecheck**

```
npm run lint && npm run typecheck
```

Expected: no errors. If complexity violations appear, extract helpers.

- [ ] **Step 10: Run full suite**

```
npm test
```

Expected: all tests pass; no regressions.

---

## Done when

- `npm run lint && npm run typecheck` exit 0.
- `npm test` exits 0 with no regressions.
- All seven `nested function contract injection` tests PASS.
- All three `nested location string format` tests PASS.
- All three `buildCapturedIdentifiers` tests PASS.
- Phase 2 runs after Phase 1 in `tryRewriteFunction`; outer contracts and nested contracts are
  injected independently.
- `ctx.transformed.value` is set to `true` whenever a nested node is rewritten.
