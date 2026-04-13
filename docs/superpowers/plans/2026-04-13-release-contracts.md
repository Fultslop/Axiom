# Release Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `keepContracts` option to `TransformerOptions` that allows library authors to bake contract checks into their release builds. Supports granular selection by contract kind (`'pre'`, `'post'`, `'invariant'`, `'all'`). Also supports a file-level `// @axiom keepContracts` directive as a stretch goal.

**Architecture:** Three files change in `src/`. `src/transformer.ts` adds `keepContracts` to the options object, normalises `true` → `'all'`, and threads the resolved value through `visitNode` to `tryRewriteFunction` and `tryRewriteClass`. `src/function-rewriter.ts` accepts `keepContracts` in `tryRewriteFunction` / `rewriteFunction` and passes it to `buildGuardedStatements`, which filters out contract kinds not selected by the option. `src/class-rewriter.ts` threads `keepContracts` through to each `tryRewriteFunction` call. The stretch-goal file-level directive is detected in the per-file visitor in `transformer.ts` before the node walk, overriding the effective value for that file only. No changes are needed in `ast-builder.ts`, `contract-validator.ts`, `jsdoc-parser.ts`, `interface-resolver.ts`, or `require-injection.ts`.

**Tech Stack:** TypeScript, ts-patch transformer API, Jest.

---

## ESLint constraints (read before touching any `src/` file)

- `id-length: min 3` — no identifiers shorter than 3 characters.
- `complexity: 10` — keep functions small; extract helpers.
- `max-len: 100` — lines under 100 chars.
- No `console` — use the injectable `warn` callback.

---

## File Map

| File | Change |
|---|---|
| `src/transformer.ts` | Add `keepContracts` to options; normalise `true` → `'all'`; thread through `visitNode`; (stretch) detect file-level directive |
| `src/function-rewriter.ts` | Add `keepContracts` param to `tryRewriteFunction` / `rewriteFunction`; pass to `buildGuardedStatements`; filter contract kinds there |
| `src/class-rewriter.ts` | Add `keepContracts` param to `tryRewriteClass` / `rewriteClass` / `rewriteMembers` / `rewriteMember`; thread to `tryRewriteFunction` |
| `test/transformer.test.ts` | New describe blocks for `keepContracts` option and file-level directive |

---

## Task 1: Thread `keepContracts` through `buildGuardedStatements` in `function-rewriter.ts`

**Files:**
- Modify: `src/function-rewriter.ts`
- Test: `test/transformer.test.ts`

This task adds the core filtering logic. The option is threaded from `rewriteFunction` into `buildGuardedStatements`, which uses it to suppress contract kinds that are not selected.

- [ ] **Step 1: Write the failing tests**

Add to `test/transformer.test.ts` (use the existing `transform` helper that does not require a Program — `keepContracts` filtering does not depend on type information):

```typescript
describe('keepContracts option', () => {
  it('keepContracts: false (default) — existing behaviour unchanged', () => {
    const source = `
      /**
       * @pre x > 0
       * @post result > 0
       */
      export function double(x: number): number { return x * 2; }
    `;
    const result = transform(source);
    // No structural difference from running without the option
    const resultDefault = transform(source, { keepContracts: false });
    expect(result).toBe(resultDefault);
  });

  it('keepContracts: true — both pre and post checks are emitted', () => {
    const source = `
      /**
       * @pre x > 0
       * @post result > 0
       */
      export function double(x: number): number { return x * 2; }
    `;
    const result = transform(source, { keepContracts: true });
    expect(result).toContain('x > 0');
    expect(result).toContain('result > 0');
  });

  it('keepContracts: "all" — same as true', () => {
    const source = `
      /**
       * @pre x > 0
       * @post result > 0
       */
      export function double(x: number): number { return x * 2; }
    `;
    const resultTrue = transform(source, { keepContracts: true });
    const resultAll = transform(source, { keepContracts: 'all' });
    expect(resultTrue).toBe(resultAll);
  });

  it('keepContracts: "pre" — only pre check is emitted, post scaffolding absent', () => {
    const source = `
      /**
       * @pre x > 0
       * @post result > 0
       */
      export function double(x: number): number { return x * 2; }
    `;
    const result = transform(source, { keepContracts: 'pre' });
    expect(result).toContain('x > 0');
    expect(result).not.toContain('result > 0');
    // Body-capture scaffolding should be absent when only pre is kept
    expect(result).not.toContain('__body');
  });

  it('keepContracts: "post" — only post check and scaffolding are emitted, pre absent', () => {
    const source = `
      /**
       * @pre x > 0
       * @post result > 0
       */
      export function double(x: number): number { return x * 2; }
    `;
    const result = transform(source, { keepContracts: 'post' });
    expect(result).not.toContain('x > 0');
    expect(result).toContain('result > 0');
  });

  it('keepContracts: "all" on a function with no contract tags — no output change', () => {
    const source = `export function noop(): void {}`;
    const baseline = transform(source);
    const result = transform(source, { keepContracts: 'all' });
    expect(result).toBe(baseline);
  });
});
```

- [ ] **Step 2: Run to confirm the filtering tests fail**

```
npx jest --testPathPattern="transformer" -t "keepContracts option" --no-coverage
```

Expected: tests asserting `not.toContain` for the wrong kind fail because today the transformer emits both kinds regardless.

- [ ] **Step 3: Define the `KeepContracts` type and normalisation helper in `src/function-rewriter.ts`**

Add near the top of the file (below the existing `const` declarations):

```typescript
export type KeepContracts = false | 'pre' | 'post' | 'invariant' | 'all';

export function normaliseKeepContracts(
  raw: boolean | 'pre' | 'post' | 'invariant' | 'all' | undefined,
): KeepContracts {
  if (raw === true) return 'all';
  if (raw === false || raw === undefined) return false;
  return raw;
}
```

Keeping the type and normaliser in `function-rewriter.ts` avoids a new file. `transformer.ts` will re-export / import from here.

- [ ] **Step 4: Add filtering helpers in `src/function-rewriter.ts`**

Add after `normaliseKeepContracts`:

```typescript
function shouldEmitPre(keepContracts: KeepContracts): boolean {
  return keepContracts === false || keepContracts === 'pre' || keepContracts === 'all';
}

function shouldEmitPost(keepContracts: KeepContracts): boolean {
  return keepContracts === false || keepContracts === 'post' || keepContracts === 'all';
}

function shouldEmitInvariant(keepContracts: KeepContracts): boolean {
  return keepContracts === false || keepContracts === 'invariant' || keepContracts === 'all';
}
```

Note: when `keepContracts` is `false` all kinds are emitted (current behaviour). The option is about suppressing kinds that the author has opted out of retaining.

- [ ] **Step 5: Update `buildGuardedStatements` signature and body in `src/function-rewriter.ts`**

Add `keepContracts: KeepContracts` as the last parameter and apply the filtering:

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
): typescript.Statement[] {
  const statements: typescript.Statement[] = [];

  const activePre = shouldEmitPre(keepContracts) ? preTags : [];
  const activePost = shouldEmitPost(keepContracts) ? postTags : [];
  const activeInvariant = shouldEmitInvariant(keepContracts) ? invariantCall : null;

  for (const tag of activePre) {
    statements.push(buildPreCheck(tag.expression, location, factory, exportedNames));
  }

  if (activePost.length > 0 || activeInvariant !== null) {
    if (prevCapture !== null) {
      statements.push(buildPrevCapture(prevCapture, factory));
    }
    statements.push(buildBodyCapture(originalBody.statements, factory));
    for (const tag of activePost) {
      statements.push(buildPostCheck(tag.expression, location, factory, exportedNames));
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

- [ ] **Step 6: Update `shouldSkipRewrite` to account for filtering**

After the filtering step in `rewriteFunction`, the effective set of tags/call could become empty even if the raw tags were non-empty. Update `shouldSkipRewrite` usage by passing the resolved active sets. Alternatively, compute the active counts inside `rewriteFunction` before calling `shouldSkipRewrite`. The simplest approach: keep `shouldSkipRewrite` as-is and instead pass `keepContracts` down so `buildGuardedStatements` can short-circuit when all active sets are empty.

Add a helper:

```typescript
function allContractsFiltered(
  preTags: ContractTag[],
  postTags: ContractTag[],
  invariantCall: typescript.ExpressionStatement | null,
  keepContracts: KeepContracts,
): boolean {
  const activePre = shouldEmitPre(keepContracts) ? preTags.length : 0;
  const activePost = shouldEmitPost(keepContracts) ? postTags.length : 0;
  const activeInv = shouldEmitInvariant(keepContracts) && invariantCall !== null ? 1 : 0;
  return activePre === 0 && activePost === 0 && activeInv === 0;
}
```

In `rewriteFunction`, replace the `shouldSkipRewrite` call with:

```typescript
if (shouldSkipRewrite(preTags, postTags, invariantCall) ||
    allContractsFiltered(preTags, postTags, invariantCall, keepContracts)) {
  return null;
}
```

- [ ] **Step 7: Add `keepContracts` parameter to `rewriteFunction` and `tryRewriteFunction`**

Update `rewriteFunction` signature:

```typescript
function rewriteFunction(
  factory: typescript.NodeFactory,
  node: typescript.FunctionLikeDeclaration,
  reparsedFunctions: Map<number, typescript.FunctionLikeDeclaration>,
  warn: (msg: string) => void,
  checker?: typescript.TypeChecker,
  invariantExpressions: string[] = [],
  interfaceMethodContracts?: InterfaceMethodContracts,
  allowIdentifiers: string[] = [],
  keepContracts: KeepContracts = false,
): typescript.FunctionLikeDeclaration | null {
```

Pass `keepContracts` through to `buildGuardedStatements` at the call site.

Update `tryRewriteFunction` signature:

```typescript
export function tryRewriteFunction(
  factory: typescript.NodeFactory,
  node: typescript.FunctionLikeDeclaration,
  reparsedFunctions: Map<number, typescript.FunctionLikeDeclaration>,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker?: typescript.TypeChecker,
  invariantExpressions: string[] = [],
  interfaceMethodContracts?: InterfaceMethodContracts,
  allowIdentifiers: string[] = [],
  keepContracts: KeepContracts = false,
): typescript.FunctionLikeDeclaration {
```

Pass `keepContracts` through to `rewriteFunction`.

- [ ] **Step 8: Run the failing tests to confirm they now pass**

```
npx jest --testPathPattern="transformer" -t "keepContracts option" --no-coverage
```

Expected: all tests in the describe block pass.

- [ ] **Step 9: Run full suite**

```
npm test
```

Expected: all tests pass, coverage threshold met.

- [ ] **Step 10: Commit**

```
git add src/function-rewriter.ts test/transformer.test.ts
git commit -m "feat: add keepContracts filtering to buildGuardedStatements"
```

---

## Task 2: Thread `keepContracts` through `transformer.ts` and `class-rewriter.ts`

**Files:**
- Modify: `src/transformer.ts`
- Modify: `src/class-rewriter.ts`
- Test: `test/transformer.test.ts`

- [ ] **Step 1: Write the failing test for invariant filtering**

Add to `test/transformer.test.ts` (requires `transformWithProgram` for class invariants):

```typescript
describe('keepContracts with class invariants', () => {
  it('keepContracts: "invariant" — invariant call emitted, pre absent', () => {
    const source = `
      /**
       * @invariant this.value > 0
       */
      export class Counter {
        value = 1;
        /**
         * @pre amount > 0
         */
        increment(amount: number): void { this.value += amount; }
      }
    `;
    const warnings: string[] = [];
    const result = transformWithProgram(source, (msg) => warnings.push(msg), {
      keepContracts: 'invariant',
    });
    expect(result).toContain('checkInvariants');
    expect(result).not.toContain('amount > 0');
  });

  it('keepContracts: "pre" — pre emitted, invariant call absent', () => {
    const source = `
      /**
       * @invariant this.value > 0
       */
      export class Counter {
        value = 1;
        /**
         * @pre amount > 0
         */
        increment(amount: number): void { this.value += amount; }
      }
    `;
    const warnings: string[] = [];
    const result = transformWithProgram(source, (msg) => warnings.push(msg), {
      keepContracts: 'pre',
    });
    expect(result).toContain('amount > 0');
    expect(result).not.toContain('checkInvariants');
  });
});
```

- [ ] **Step 2: Run to confirm these tests fail**

```
npx jest --testPathPattern="transformer" -t "keepContracts with class invariants" --no-coverage
```

Expected: FAILs — `keepContracts` is not yet wired into `transformer.ts` or `class-rewriter.ts`.

- [ ] **Step 3: Update `src/transformer.ts` — add `keepContracts` to options and normalise**

Import `KeepContracts` and `normaliseKeepContracts` from `function-rewriter`:

```typescript
import {
  tryRewriteFunction, isPublicTarget,
  type KeepContracts, normaliseKeepContracts,
} from './function-rewriter';
```

Add `keepContracts` to the options object in `createTransformer`:

```typescript
export default function createTransformer(
  _program?: typescript.Program,
  options?: {
    warn?: (msg: string) => void;
    interfaceParamMismatch?: 'rename' | 'ignore';
    allowIdentifiers?: string[];
    keepContracts?: boolean | 'pre' | 'post' | 'invariant' | 'all';
  },
): typescript.TransformerFactory<typescript.SourceFile> {
```

After the existing option extractions, normalise the value:

```typescript
const keepContracts: KeepContracts = normaliseKeepContracts(options?.keepContracts);
```

- [ ] **Step 4: Thread `keepContracts` through `visitNode` in `src/transformer.ts`**

Add `keepContracts: KeepContracts` as the last parameter of `visitNode`. Pass it down in both the `tryRewriteFunction` call and the `tryRewriteClass` call, and in the recursive `visitEachChild` call.

Updated `visitNode` signature:

```typescript
function visitNode(
  factory: typescript.NodeFactory,
  node: typescript.Node,
  context: typescript.TransformationContext,
  reparsedIndex: ReparsedIndex,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker: typescript.TypeChecker | undefined,
  reparsedCache: Map<string, typescript.SourceFile>,
  paramMismatch: ParamMismatchMode,
  allowIdentifiers: string[],
  keepContracts: KeepContracts,
): typescript.Node {
```

Pass `keepContracts` as the final argument to `tryRewriteFunction` (add after `allowIdentifiers`):

```typescript
return tryRewriteFunction(
  factory,
  node as typescript.FunctionLikeDeclaration,
  reparsedIndex.functions,
  transformed,
  warn,
  checker,
  [],
  undefined,
  allowIdentifiers,
  keepContracts,
);
```

Pass `keepContracts` as the final argument to `tryRewriteClass`:

```typescript
return tryRewriteClass(
  factory, node, reparsedIndex, transformed, warn,
  checker, reparsedCache, paramMismatch, allowIdentifiers, keepContracts,
);
```

Pass it through the recursive call:

```typescript
return typescript.visitEachChild(
  node,
  (child) => visitNode(
    factory, child, context, reparsedIndex, transformed, warn,
    checker, reparsedCache, paramMismatch, allowIdentifiers, keepContracts,
  ),
  context,
);
```

And pass it in the outer visitor call site:

```typescript
(node) => visitNode(
  factory, node, context, reparsedIndex, transformed, warn,
  checker, reparsedCache, paramMismatch, allowIdentifiers, keepContracts,
),
```

- [ ] **Step 5: Thread `keepContracts` through `src/class-rewriter.ts`**

Import `KeepContracts` from `function-rewriter`:

```typescript
import {
  tryRewriteFunction, isPublicTarget, type KeepContracts,
} from './function-rewriter';
```

Add `keepContracts: KeepContracts = false` as the final parameter to `tryRewriteClass`, `rewriteClass`, `rewriteMembers`, and `rewriteMember`. Thread it through each layer to the `tryRewriteFunction` call in `rewriteMember`:

```typescript
const rewritten = tryRewriteFunction(
  factory, member, reparsedIndex.functions, transformed, warn,
  checker, effectiveInvariants, ifaceMethodContracts, allowIdentifiers, keepContracts,
);
```

Also thread `keepContracts` to `rewriteConstructor` if invariant filtering is needed there (see note below), or leave `rewriteConstructor` unchanged if the invariant call on the constructor is always governed by `effectiveInvariants` which are already filtered at the class level.

Note: The constructor receives the `#checkInvariants()` call only when `effectiveInvariants.length > 0`. When `keepContracts: 'pre'`, invariants should be suppressed. The cleanest approach is to pass `keepContracts` into `rewriteClass` and conditionally skip `rewriteConstructor` and `buildCheckInvariantsMethod` when `keepContracts` is set to a value that excludes invariants:

```typescript
function shouldEmitInvariantsForClass(keepContracts: KeepContracts): boolean {
  return keepContracts === false || keepContracts === 'invariant' || keepContracts === 'all';
}
```

In `rewriteClass`, gate both the constructor rewrite and the invariants method injection on this helper.

- [ ] **Step 6: Run the failing tests**

```
npx jest --testPathPattern="transformer" -t "keepContracts with class invariants" --no-coverage
```

Expected: both tests pass.

- [ ] **Step 7: Run full suite**

```
npm test
```

Expected: all tests pass, coverage threshold met.

- [ ] **Step 8: Commit**

```
git add src/transformer.ts src/class-rewriter.ts test/transformer.test.ts
git commit -m "feat: thread keepContracts through transformer and class-rewriter"
```

---

## Task 3: Verify `require` import is still injected when `keepContracts` is active

**Files:**
- Test: `test/transformer.test.ts`

This task adds a regression test confirming that the `require('fs-axiom/contracts')` import is present in the output when `keepContracts` is used and contracts are emitted.

- [ ] **Step 1: Write the tests**

Add to `test/transformer.test.ts`:

```typescript
describe('keepContracts — require injection', () => {
  it('emits the require import when keepContracts: "all" and contracts are present', () => {
    const source = `
      /**
       * @pre x > 0
       */
      export function inc(x: number): number { return x + 1; }
    `;
    const result = transform(source, { keepContracts: 'all' });
    expect(result).toContain("require('fs-axiom/contracts')");
  });

  it('does not emit the require import when keepContracts filters all contracts out', () => {
    const source = `
      /**
       * @pre x > 0
       */
      export function inc(x: number): number { return x + 1; }
    `;
    // keepContracts: 'post' — function has only @pre, so nothing is emitted
    const result = transform(source, { keepContracts: 'post' });
    expect(result).not.toContain("require('fs-axiom/contracts')");
  });
});
```

- [ ] **Step 2: Run to confirm tests pass (no implementation needed)**

```
npx jest --testPathPattern="transformer" -t "keepContracts — require injection" --no-coverage
```

Expected: both tests pass as a natural consequence of the `transformed.value` flag — the require import is only injected when `transformed.value` is set to `true`, which only happens when a rewrite actually occurred.

If the first test fails, debug the require injection path to ensure that filtering in `buildGuardedStatements` does not accidentally prevent `transformed.value` from being set when a rewrite did emit code.

- [ ] **Step 3: Run full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```
git add test/transformer.test.ts
git commit -m "test: verify require injection behaviour under keepContracts"
```

---

## Task 4: File-level directive `// @axiom keepContracts` (stretch goal)

**Files:**
- Modify: `src/transformer.ts`
- Test: `test/transformer.test.ts`

The directive is a line comment on the first line of the file. It overrides the global `keepContracts` value for that file's transformation pass. The comment is not stripped from the output.

- [ ] **Step 1: Write the failing tests**

Add to `test/transformer.test.ts`:

```typescript
describe('file-level @axiom keepContracts directive', () => {
  it('directive with no qualifier enables "all", overriding global false', () => {
    const source = `// @axiom keepContracts
      /**
       * @pre x > 0
       * @post result > 0
       */
      export function double(x: number): number { return x * 2; }
    `;
    const result = transform(source, { keepContracts: false });
    expect(result).toContain('x > 0');
    expect(result).toContain('result > 0');
  });

  it('directive "pre" enables only pre, overriding global false', () => {
    const source = `// @axiom keepContracts pre
      /**
       * @pre x > 0
       * @post result > 0
       */
      export function double(x: number): number { return x * 2; }
    `;
    const result = transform(source, { keepContracts: false });
    expect(result).toContain('x > 0');
    expect(result).not.toContain('result > 0');
  });

  it('directive "post" enables only post, overriding global false', () => {
    const source = `// @axiom keepContracts post
      /**
       * @pre x > 0
       * @post result > 0
       */
      export function double(x: number): number { return x * 2; }
    `;
    const result = transform(source, { keepContracts: false });
    expect(result).not.toContain('x > 0');
    expect(result).toContain('result > 0');
  });

  it('file without directive and global false — no checks emitted', () => {
    const source = `
      /**
       * @pre x > 0
       */
      export function inc(x: number): number { return x + 1; }
    `;
    const baseline = transform(source);
    const result = transform(source, { keepContracts: false });
    expect(result).toBe(baseline);
  });

  it('directive on a non-first line is ignored', () => {
    const source = `export const dummy = 1;
// @axiom keepContracts
      /**
       * @pre x > 0
       */
      export function inc(x: number): number { return x + 1; }
    `;
    const result = transform(source, { keepContracts: false });
    expect(result).not.toContain('x > 0');
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

```
npx jest --testPathPattern="transformer" -t "file-level @axiom keepContracts directive" --no-coverage
```

Expected: the tests asserting contracts are emitted fail (directive not yet detected).

- [ ] **Step 3: Add `readFileDirective` helper to `src/transformer.ts`**

Add before the `visitNode` function:

```typescript
const DIRECTIVE_PREFIX = '// @axiom keepContracts' as const;

function readFileDirective(
  sourceFile: typescript.SourceFile,
): KeepContracts | undefined {
  const firstStatement = sourceFile.statements[0];
  if (firstStatement === undefined) {
    return undefined;
  }
  const fullText = sourceFile.getFullText();
  const statementStart = firstStatement.getFullStart();
  const leading = fullText.slice(0, statementStart);
  const firstLine = leading.split('\n')[0].trim();
  if (!firstLine.startsWith(DIRECTIVE_PREFIX)) {
    return undefined;
  }
  const qualifier = firstLine.slice(DIRECTIVE_PREFIX.length).trim();
  if (qualifier === '') return 'all';
  if (qualifier === 'pre') return 'pre';
  if (qualifier === 'post') return 'post';
  if (qualifier === 'invariant') return 'invariant';
  if (qualifier === 'all') return 'all';
  return undefined;
}
```

- [ ] **Step 4: Apply the directive in the per-file visitor in `src/transformer.ts`**

In the inner `return (sourceFile: typescript.SourceFile)` function, before building `reparsedIndex`, read the directive and compute the effective value:

```typescript
return (sourceFile: typescript.SourceFile): typescript.SourceFile => {
  const fileDirective = readFileDirective(sourceFile);
  const effectiveKeepContracts: KeepContracts = fileDirective !== undefined
    ? fileDirective
    : keepContracts;
  const reparsedIndex = buildReparsedIndex(sourceFile);
  const transformed = { value: false };
  const visited = typescript.visitEachChild(
    sourceFile,
    (node) => visitNode(
      factory, node, context, reparsedIndex, transformed, warn,
      checker, reparsedCache, paramMismatch, allowIdentifiers, effectiveKeepContracts,
    ),
    context,
  );
  // ... rest unchanged
};
```

- [ ] **Step 5: Run the failing tests**

```
npx jest --testPathPattern="transformer" -t "file-level @axiom keepContracts directive" --no-coverage
```

Expected: all five tests pass.

- [ ] **Step 6: Run full suite**

```
npm test
```

Expected: all tests pass, coverage threshold met.

- [ ] **Step 7: Commit**

```
git add src/transformer.ts test/transformer.test.ts
git commit -m "feat: support file-level @axiom keepContracts directive"
```

---

## Task 5: Lint, typecheck, and final suite

- [ ] **Step 1: Lint**

```
npm run lint
```

Fix any `id-length`, `complexity`, or `max-len` violations before proceeding.

- [ ] **Step 2: Typecheck**

```
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Full test suite with coverage**

```
npm run test:coverage
```

Expected: all tests pass, all thresholds met (80% minimum).

- [ ] **Step 4: Knip (dead code check)**

```
npm run knip
```

Expected: no new unused exports. If `normaliseKeepContracts` is only used in `transformer.ts`, consider making it unexported (internal to `transformer.ts`) — unless the test file imports it directly.

- [ ] **Step 5: Commit any lint/typecheck fixes**

```
git add -p
git commit -m "chore: lint and typecheck fixes for keepContracts implementation"
```

---

## Acceptance Checklist

Human QA steps to verify the implementation is correct and complete:

- [ ] `keepContracts` is absent from the options object (default): transform output is byte-for-byte identical to the output produced before this change.
- [ ] `keepContracts: false` explicitly set: same as above — no regression.
- [ ] `keepContracts: true` and `keepContracts: 'all'` produce identical output, and that output contains both `@pre` and `@post` checks for a function that has both tags.
- [ ] `keepContracts: 'pre'`: a function with `@pre x > 0` and `@post result > 0` emits only the pre check; no body-capture scaffolding or result variable is present.
- [ ] `keepContracts: 'post'`: same function emits only the post check and its scaffolding; the pre assertion is absent.
- [ ] `keepContracts: 'invariant'`: a class with `@invariant` and a method with `@pre` emits the `#checkInvariants()` call but not the pre assertion.
- [ ] `keepContracts: 'all'` on a function with no contract tags: output is identical to the undecorated function (no spurious injection).
- [ ] When `keepContracts` filters all contract kinds out for a given function, the `require('fs-axiom/contracts')` import is **not** added to the file.
- [ ] When `keepContracts` results in at least one check being emitted, the `require('fs-axiom/contracts')` import **is** present.
- [ ] File-level `// @axiom keepContracts` (no qualifier) on line 1 enables `'all'` for that file, overriding global `keepContracts: false`.
- [ ] File-level `// @axiom keepContracts pre` enables only pre checks for that file.
- [ ] File-level `// @axiom keepContracts post` enables only post checks for that file.
- [ ] The same directive placed on any line other than the first line of the file is silently ignored.
- [ ] `npm run lint` passes with no errors.
- [ ] `npm run typecheck` passes with no errors.
- [ ] `npm run test:coverage` passes with all coverage thresholds met.
- [ ] `npm run knip` reports no new unused exports introduced by this change.
