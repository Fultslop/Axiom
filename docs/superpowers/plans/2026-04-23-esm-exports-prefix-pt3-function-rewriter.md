# ESM Exports Prefix — Part 3: Function Rewriter & Integration Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thread `ctx.isEsm` through `buildGuardedStatements` in `function-rewriter.ts` so the guard builders receive the ESM flag at runtime, and add end-to-end integration tests that verify CJS still emits `exports.` while ESM targets emit bare identifiers.

**Architecture:** `buildGuardedStatements` gains an `isEsm` parameter and passes it down to `buildPreCheck`/`buildPostCheck`. Both call sites in `rewriteFunction` and `rewriteNestedFunctionLike` pass `ctx.isEsm`. Integration tests use `typescript.transpileModule` with explicit `ModuleKind` values to confirm the full pipeline.

**Tech Stack:** TypeScript AST transformer API, Jest

**Depends on:** Part 1 (`isEsm` on `TransformerContext`) and Part 2 (`isEsm` parameter on `buildPreCheck`/`buildPostCheck`) must both be merged first.

---

### Task 3: Thread `isEsm` through `function-rewriter.ts` and add integration tests

**Files:**
- Modify: `src/function-rewriter.ts`
- Create: `test/transformer.esm-exports.test.ts`

- [ ] **Step 1: Write failing integration tests**

Create `test/transformer.esm-exports.test.ts`:

```typescript
import typescript from 'typescript';
import createTransformer from '@src/transformer';

function transformWithModuleKind(source: string, moduleKind: typescript.ModuleKind): string {
  const result = typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2020,
      module: moduleKind,
    },
    transformers: {
      before: [createTransformer()],
    },
  });
  return result.outputText;
}

describe('transformer — ESM exports prefix', () => {
  describe('CJS target regression', () => {
    it('emits exports. prefix for exported const in @pre with CommonJS output', () => {
      const source = `
        export const MAX_LIMIT = 100;
        /**
         * @pre n <= MAX_LIMIT
         */
        export function cap(n: number): number { return n; }
      `;
      const output = transformWithModuleKind(source, typescript.ModuleKind.CommonJS);
      expect(output).toContain('exports.MAX_LIMIT');
      expect(output).toContain('!(n <= exports.MAX_LIMIT)');
    });

    it('emits exports. prefix for exported enum in @pre with CommonJS output', () => {
      const source = `
        export enum Mode { Fast = 0, Slow = 1 }
        /**
         * @pre mode === Mode.Fast
         */
        export function checkMode(mode: number): void {}
      `;
      const output = transformWithModuleKind(source, typescript.ModuleKind.CommonJS);
      expect(output).toContain('!(mode === exports.Mode.Fast)');
    });
  });

  describe('ESM targets — ESNext', () => {
    it('emits bare identifier for exported const in @pre with ESNext output', () => {
      const source = `
        export const MAX_LIMIT = 100;
        /**
         * @pre n <= MAX_LIMIT
         */
        export function cap(n: number): number { return n; }
      `;
      const output = transformWithModuleKind(source, typescript.ModuleKind.ESNext);
      expect(output).toContain('!(n <= MAX_LIMIT)');
      expect(output).not.toContain('!(n <= exports.MAX_LIMIT)');
    });

    it('emits bare identifier for exported const in @post with ESNext output', () => {
      const source = `
        export const MAX = 50;
        /**
         * @post result <= MAX
         */
        export function clamp(n: number): number { return Math.min(n, MAX); }
      `;
      const output = transformWithModuleKind(source, typescript.ModuleKind.ESNext);
      expect(output).toContain('!(result <= MAX)');
      expect(output).not.toContain('!(result <= exports.MAX)');
    });

    it('does not emit exports. in guard for parameter-only @pre with ESNext output', () => {
      const source = `
        /**
         * @pre n > 0
         */
        export function positive(n: number): number { return n; }
      `;
      const output = transformWithModuleKind(source, typescript.ModuleKind.ESNext);
      expect(output).toContain('!(n > 0)');
    });
  });

  describe('ESM targets — ES2022', () => {
    it('emits bare identifier for exported const in @pre with ES2022 output', () => {
      const source = `
        export const CAP = 200;
        /**
         * @pre x < CAP
         */
        export function limit(x: number): number { return x; }
      `;
      const output = transformWithModuleKind(source, typescript.ModuleKind.ES2022);
      expect(output).toContain('!(x < CAP)');
      expect(output).not.toContain('!(x < exports.CAP)');
    });
  });

  describe('ESM targets — Node16', () => {
    it('emits bare identifier in guard for exported enum in @post with Node16', () => {
      const source = `
        export enum Status { Ok = 0, Fail = 1 }
        /**
         * @post result === Status.Ok
         */
        export function run(): number { return 0; }
      `;
      const output = transformWithModuleKind(source, typescript.ModuleKind.Node16);
      expect(output).toContain('!(result === Status.Ok)');
      expect(output).not.toContain('!(result === exports.Status.Ok)');
    });
  });
});
```

- [ ] **Step 2: Run the new tests to confirm the ESM tests fail**

Run: `npm test -- --testPathPattern=transformer.esm-exports`
Expected: The CJS regression tests pass; the ESM tests fail because `buildGuardedStatements` still calls `buildPreCheck`/`buildPostCheck` without `isEsm`, defaulting to `false` (CJS behaviour).

- [ ] **Step 3: Add `isEsm` parameter to `buildGuardedStatements` and thread through calls**

In `src/function-rewriter.ts`, replace the `buildGuardedStatements` function signature and its two call sites for `buildPreCheck`/`buildPostCheck` (lines 100–139):

```typescript
function buildGuardedStatements(
  factory: typescript.NodeFactory,
  preTags: ContractTag[],
  postTags: ContractTag[],
  originalBody: typescript.Block,
  location: string,
  invariantCall: typescript.ExpressionStatement | null,
  prevCapture: string | null,
  exportedNames: Set<string>,
  keepContracts: KeepContracts,
  isAsync: boolean,
  isEsm: boolean,
): typescript.Statement[] {
  const statements: typescript.Statement[] = [];

  const activePre = shouldEmitPre(keepContracts) ? preTags : [];
  const activePost = shouldEmitPost(keepContracts) ? postTags : [];
  const activeInvariant = shouldEmitInvariant(keepContracts) ? invariantCall : null;

  for (const tag of activePre) {
    statements.push(buildPreCheck(tag.expression, location, factory, exportedNames, isEsm));
  }

  if (activePost.length > 0 || activeInvariant !== null) {
    if (prevCapture !== null) {
      statements.push(buildPrevCapture(prevCapture, factory));
    }
    statements.push(buildBodyCapture(originalBody.statements, factory, isAsync));
    for (const tag of activePost) {
      statements.push(buildPostCheck(tag.expression, location, factory, exportedNames, isEsm));
    }
    if (activeInvariant !== null) {
      statements.push(activeInvariant);
    }
    statements.push(buildResultReturn(factory));
  } else {
    statements.push(...Array.from(originalBody.statements));
  }

  return statements;
}
```

- [ ] **Step 4: Pass `ctx.isEsm` to `buildGuardedStatements` in `rewriteFunction`**

In `src/function-rewriter.ts`, in the `rewriteFunction` function (around line 525), replace the call:

```typescript
  const newStatements = buildGuardedStatements(
    factory, preTags, postTags, originalBody, location, invariantCall,
    prevCapture, exportedNames, keepContracts, asyncFlag,
  );
```

With:

```typescript
  const newStatements = buildGuardedStatements(
    factory, preTags, postTags, originalBody, location, invariantCall,
    prevCapture, exportedNames, keepContracts, asyncFlag, ctx.isEsm,
  );
```

- [ ] **Step 5: Pass `ctx.isEsm` to `buildGuardedStatements` in `rewriteNestedFunctionLike`**

In `src/function-rewriter.ts`, in the `rewriteNestedFunctionLike` function (around line 321), replace the call:

```typescript
  const newStatements = buildGuardedStatements(
    factory, preTags, postTags, originalBody, location,
    null, prevCapture, exportedNames, keepContracts, asyncFlag,
  );
```

With:

```typescript
  const newStatements = buildGuardedStatements(
    factory, preTags, postTags, originalBody, location,
    null, prevCapture, exportedNames, keepContracts, asyncFlag, ctx.isEsm,
  );
```

- [ ] **Step 6: Run the integration tests to confirm they all pass**

Run: `npm test -- --testPathPattern=transformer.esm-exports`
Expected: PASS — all 7 tests pass

- [ ] **Step 7: Run all tests to confirm no regressions**

Run: `npm test`
Expected: All tests pass (including existing `exports.` tests in `test/transformer.identifier-scoping.test.ts`)

- [ ] **Step 8: Commit**

```bash
git add src/function-rewriter.ts test/transformer.esm-exports.test.ts
git commit -m "feat: thread isEsm through function-rewriter, skip exports. prefix for ESM targets"
```
