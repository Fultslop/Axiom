# ESM Exports Prefix — Part 1: TransformerContext Implementation Plan

Status: complete

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `isEsm: boolean` to `TransformerContext`, computed from `compilerOptions.module` in the transformer factory, so later tasks can read `ctx.isEsm` to skip the `exports.` prefix in ESM mode.

**Architecture:** `isEsm` is a plain boolean field on the context — no new plumbing. It flows from `tsContext.getCompilerOptions().module` → computed `isEsm` → `baseCtx`. All existing behaviour is unchanged; this task only threads the wire.

**Tech Stack:** TypeScript, Jest

**Depends on:** nothing — this is the foundation for Parts 2 and 3.

**Unlocks (can run in parallel after this merges):**
- Part 2: `ast-builder.ts` guard changes
- Part 3: `function-rewriter.ts` threading and integration tests

---

### Task 1: Add `isEsm` to `TransformerContext` and compute it in `transformer.ts`

**Files:**
- Modify: `src/transformer-context.ts`
- Modify: `src/transformer.ts`

- [ ] **Step 1: Verify baseline typecheck passes**

Run: `npm run typecheck`
Expected: PASS (confirms clean starting state)

- [ ] **Step 2: Add `isEsm` to `TransformerContext`**

In `src/transformer-context.ts`, replace the full file content with:

```typescript
import type typescript from 'typescript';
import type { KeepContracts } from './keep-contracts';
import type { ParamMismatchMode } from './interface-resolver';
import type { ReparsedIndex } from './reparsed-index';

export type TransformerContext = {
  factory: typescript.NodeFactory;
  warn: (msg: string) => void;
  checker: typescript.TypeChecker | undefined;
  allowIdentifiers: string[];
  keepContracts: KeepContracts;
  paramMismatch: ParamMismatchMode;
  reparsedIndex: ReparsedIndex;
  reparsedCache: Map<string, typescript.SourceFile>;
  transformed: { value: boolean };
  isEsm: boolean;
};
```

- [ ] **Step 3: Verify typecheck reports the expected error**

Run: `npm run typecheck`
Expected: FAIL — `src/transformer.ts` reports `baseCtx` is missing property `isEsm`

- [ ] **Step 4: Compute `isEsm` and add it to `baseCtx` in `transformer.ts`**

In `src/transformer.ts`, find the factory closure (the `return (tsContext: typescript.TransformationContext) => {` block at line ~459) and replace it with:

```typescript
  return (tsContext: typescript.TransformationContext) => {
    const { module: moduleKind = typescript.ModuleKind.CommonJS } = tsContext.getCompilerOptions();
    const isEsm =
      moduleKind === typescript.ModuleKind.ES2015 ||
      moduleKind === typescript.ModuleKind.ES2020 ||
      moduleKind === typescript.ModuleKind.ES2022 ||
      moduleKind === typescript.ModuleKind.ESNext ||
      moduleKind === typescript.ModuleKind.Node16 ||
      moduleKind === typescript.ModuleKind.NodeNext;
    const baseCtx: TransformerContext = {
      factory: tsContext.factory,
      warn,
      checker,
      allowIdentifiers,
      keepContracts,
      paramMismatch,
      reparsedIndex: { functions: new Map(), classes: new Map() }, // replaced per file
      reparsedCache,
      transformed: { value: false },                               // replaced per file
      isEsm,
    };
    return (sourceFile: typescript.SourceFile): typescript.SourceFile =>
      transformSourceFile(sourceFile, tsContext, baseCtx);
  };
```

- [ ] **Step 5: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Run tests to confirm no regressions**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/transformer-context.ts src/transformer.ts
git commit -m "feat: add isEsm to TransformerContext, compute from compilerOptions.module"
```
