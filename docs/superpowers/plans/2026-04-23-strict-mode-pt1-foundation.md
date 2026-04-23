# Strict Mode — Part 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `strict: boolean` to `TransformerContext` and `TransformOptions`, computed from the plugin options, so later tasks can read `ctx.strict` in catch blocks.

**Architecture:** `strict` is a plain boolean field on the context — no new plumbing. It flows from `TransformOptions.strict` → `resolveTransformerOptions` → `baseCtx`. All existing behaviour is unchanged; this task only threads the wire.

**Tech Stack:** TypeScript, Jest

**Depends on:** nothing — this is the foundation for Parts 2 and 3.

**Unlocks (can run in parallel after this merges):**
- Part 2: catch block changes in `function-rewriter.ts` / `class-rewriter.ts`
- Part 3: README documentation

---

### Task 1: Add `strict` to `TransformerContext` and wire it through `transformer.ts`

**Files:**
- Modify: `src/transformer-context.ts`
- Modify: `src/transformer.ts`

- [ ] **Step 1: Verify baseline typecheck passes**

Run: `npm run typecheck`
Expected: PASS (confirms clean starting state)

- [ ] **Step 2: Add `strict: boolean` to `TransformerContext`**

In `src/transformer-context.ts`, add `strict: boolean` as the last field of the type (before the closing `}`):

```typescript
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
  // NOTE: isEsm may already be present if the ESM exports-prefix plan was applied first.
  // If so, keep it and just add strict below it.
  strict: boolean;
};
```

Make the edit by adding only `strict: boolean;` to the end of the existing type, before the closing `}`. Do NOT remove any fields that are already there.

- [ ] **Step 3: Verify typecheck reports the expected error**

Run: `npm run typecheck`
Expected: FAIL — every object literal that constructs a `TransformerContext` is now missing `strict`

- [ ] **Step 4: Add `strict` to `TransformOptions`**

In `src/transformer.ts`, find the `export type TransformerOptions` declaration and add `strict?: boolean` after `keepContracts?`:

```typescript
  /**
   * Causes the transformer to throw a compile-level error on internal
   * transformer errors instead of silently dropping the contract.
   * Recommended for CI. Default: `false`.
   */
  strict?: boolean;
```

The full updated `TransformerOptions` type should look like:

```typescript
export type TransformerOptions = {
  warn?: (msg: string) => void;
  paramMismatch?: 'rename' | 'ignore';
  /** @deprecated Use `paramMismatch` instead. */
  interfaceParamMismatch?: 'rename' | 'ignore';
  allowIdentifiers?: string[];
  keepContracts?: boolean | 'pre' | 'post' | 'invariant' | 'all';
  /**
   * Causes the transformer to throw a compile-level error on internal
   * transformer errors instead of silently dropping the contract.
   * Recommended for CI. Default: `false`.
   */
  strict?: boolean;
};
```

- [ ] **Step 5: Add `strict` to `ResolvedOptions` and `resolveTransformerOptions`**

In `src/transformer.ts`, find `type ResolvedOptions` and add `strict: boolean`:

```typescript
type ResolvedOptions = {
  warn: (msg: string) => void;
  paramMismatch: ParamMismatchMode;
  allowIdentifiers: string[];
  keepContracts: KeepContracts;
  strict: boolean;
};
```

Then in `resolveTransformerOptions`, add the `strict` line and include it in the return:

```typescript
function resolveTransformerOptions(
  options: TransformerOptions | undefined,
): ResolvedOptions {
  const warn = options?.warn ?? ((msg: string): void => {
    process.stderr.write(`${msg}\n`);
  });
  const rawMode = options?.paramMismatch ?? options?.interfaceParamMismatch;
  const paramMismatch: ParamMismatchMode = rawMode === MODE_IGNORE ? 'ignore' : 'rename';
  const allowIdentifiers = options?.allowIdentifiers ?? [];
  const keepContracts = resolveKeepContracts(options?.keepContracts);
  const strict = options?.strict ?? false;
  return { warn, paramMismatch, allowIdentifiers, keepContracts, strict };
}
```

- [ ] **Step 6: Destructure `strict` and add it to `baseCtx` in `createTransformer`**

In `src/transformer.ts`, find the line:
```typescript
  const { warn, paramMismatch, allowIdentifiers, keepContracts } =
    resolveTransformerOptions(options);
```

Replace it with:
```typescript
  const { warn, paramMismatch, allowIdentifiers, keepContracts, strict } =
    resolveTransformerOptions(options);
```

Then find `baseCtx` inside the returned factory closure and add `strict` to it. The `baseCtx` object currently looks like:

```typescript
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
    };
```

Add `strict,` as the last property (before the closing `}`):

```typescript
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
      strict,
    };
```

> **Note:** If `isEsm` is already present in `baseCtx` (because the ESM exports-prefix plan was applied first), keep it and add `strict` after it.

- [ ] **Step 7: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 8: Run all tests to confirm no regressions**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 9: Commit**

```bash
git add src/transformer-context.ts src/transformer.ts
git commit -m "feat: add strict to TransformerContext and TransformOptions"
```
