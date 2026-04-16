# keepContracts Step 1 — Type, Normalisation & `buildGuardedStatements` Filtering

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define the `KeepContracts` type and normalisation helper in `src/function-rewriter.ts`, add filtering helpers, and update `buildGuardedStatements` (and the `rewriteFunction` / `tryRewriteFunction` call chain) to suppress contract kinds not selected by the option.

**Architecture:** All filtering logic lives in `function-rewriter.ts`. The type and normaliser are exported so later steps can import them. `tryRewriteFunction` gains a final optional `keepContracts` param (default `false`). `buildGuardedStatements` receives the value and filters `preTags`, `postTags`, and `invariantCall` before building the statement list.

**Tech Stack:** TypeScript, Jest (`npm test`), ESLint (`npm run lint`).

**Prerequisite:** None. This is the first step.

**ESLint constraints:**
- `id-length: min 3` — no identifiers shorter than 3 chars.
- `complexity: 10` — keep functions small, extract helpers.
- `max-len: 100` — lines under 100 chars.

---

## File Map

| File | Change |
|---|---|
| `src/function-rewriter.ts` | Add `KeepContracts` type, `normaliseKeepContracts`, filtering helpers; update `buildGuardedStatements`, `rewriteFunction`, `tryRewriteFunction` |
| `test/transformer.test.ts` | New `describe('keepContracts option', ...)` block |

---

### Task 1: Write the failing tests

**Files:**
- Modify: `test/transformer.test.ts`

The existing `transform` helper in `test/helpers.ts` has this signature:

```typescript
export function transform(source: string, warn?: (msg: string) => void): string
```

`keepContracts` is not yet wired up anywhere, so passing it does nothing yet.
You need to first extend the `transform` helper to accept a full options object, then write tests that will fail until the filtering is implemented.

- [ ] **Step 1: Extend `transform` in `test/helpers.ts` to accept options**

The current signature is `transform(source, warn?)`. Change it to accept an options bag while keeping the `warn`-only overload working for existing callers.

Replace the existing `transform` function in `test/helpers.ts` with:

```typescript
export function transform(
  source: string,
  optionsOrWarn?: ((msg: string) => void) | {
    warn?: (msg: string) => void;
    keepContracts?: boolean | 'pre' | 'post' | 'invariant' | 'all';
  },
): string {
  const options = typeof optionsOrWarn === 'function'
    ? { warn: optionsOrWarn }
    : optionsOrWarn;
  const result = typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2020,
      module: typescript.ModuleKind.CommonJS,
    },
    transformers: {
      before: [createTransformer(undefined, options)],
    },
  });
  return result.outputText;
}
```

- [ ] **Step 2: Run existing tests to confirm the signature change is backward-compatible**

Run: `npm test -- --testPathPattern="transformer" --no-coverage`
Expected: all pre-existing tests still pass.

- [ ] **Step 3: Add the new failing tests to `test/transformer.test.ts`**

Add a new `describe` block at the bottom of `test/transformer.test.ts`:

```typescript
describe('keepContracts option', () => {
  const sourcePreAndPost = `
    /**
     * @pre x > 0
     * @post result > 0
     */
    export function double(x: number): number { return x * 2; }
  `;

  it('keepContracts: false (default) — output identical to omitting the option', () => {
    const withDefault = transform(sourcePreAndPost);
    const withFalse = transform(sourcePreAndPost, { keepContracts: false });
    expect(withFalse).toBe(withDefault);
  });

  it('keepContracts: true — both pre and post checks are emitted', () => {
    const result = transform(sourcePreAndPost, { keepContracts: true });
    expect(result).toContain('x > 0');
    expect(result).toContain('result > 0');
  });

  it('keepContracts: "all" — same output as true', () => {
    const withTrue = transform(sourcePreAndPost, { keepContracts: true });
    const withAll = transform(sourcePreAndPost, { keepContracts: 'all' });
    expect(withTrue).toBe(withAll);
  });

  it('keepContracts: "pre" — only pre check emitted, no post scaffolding', () => {
    const result = transform(sourcePreAndPost, { keepContracts: 'pre' });
    expect(result).toContain('x > 0');
    expect(result).not.toContain('result > 0');
    expect(result).not.toContain('__axiom_result__');
  });

  it('keepContracts: "post" — only post check emitted, no pre assertion', () => {
    const result = transform(sourcePreAndPost, { keepContracts: 'post' });
    expect(result).not.toContain('x > 0');
    expect(result).toContain('result > 0');
    expect(result).toContain('__axiom_result__');
  });

  it('keepContracts: "all" on a function with no contract tags — no output change', () => {
    const source = `export function noop(): void {}`;
    const baseline = transform(source);
    const result = transform(source, { keepContracts: 'all' });
    expect(result).toBe(baseline);
  });
});
```

- [ ] **Step 4: Run to confirm the filtering tests fail**

Run: `npm test -- --testPathPattern="transformer" --testNamePattern="keepContracts option" --no-coverage`
Expected: the `"pre"` and `"post"` tests fail — today the transformer emits both kinds regardless.

---

### Task 2: Add `KeepContracts` type, normaliser, and filtering helpers to `src/function-rewriter.ts`

**Files:**
- Modify: `src/function-rewriter.ts`

- [ ] **Step 1: Add the `KeepContracts` type export**

In `src/function-rewriter.ts`, add immediately after the existing `const` declarations at the top (after `const PREV_ID = 'prev' as const;`):

```typescript
export type KeepContracts = false | 'pre' | 'post' | 'invariant' | 'all';

export function normaliseKeepContracts(
  raw: boolean | 'pre' | 'post' | 'invariant' | 'all' | undefined,
): KeepContracts {
  if (raw === true) return 'all';
  if (!raw) return false;
  return raw;
}
```

- [ ] **Step 2: Add per-kind predicate helpers**

Add immediately after `normaliseKeepContracts`:

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

- [ ] **Step 3: Run typecheck to verify no errors so far**

Run: `npm run typecheck`
Expected: no errors.

---

### Task 3: Update `buildGuardedStatements` to accept and apply `keepContracts`

**Files:**
- Modify: `src/function-rewriter.ts`

- [ ] **Step 1: Add `keepContracts` parameter to `buildGuardedStatements`**

`buildGuardedStatements` currently starts around line 266. Replace its signature and body with the version below. The only change is adding the `keepContracts` param and filtering the three active sets at the top:

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

- [ ] **Step 2: Add `allContractsFiltered` helper**

Add immediately before `rewriteFunction`:

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

---

### Task 4: Thread `keepContracts` through `rewriteFunction` and `tryRewriteFunction`

**Files:**
- Modify: `src/function-rewriter.ts`

- [ ] **Step 1: Add `keepContracts` to `rewriteFunction`**

`rewriteFunction` currently starts around line 381. Add `keepContracts: KeepContracts = false` as the last parameter:

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

- [ ] **Step 2: Update the `shouldSkipRewrite` check in `rewriteFunction`**

Find the `if (shouldSkipRewrite(...))` call in `rewriteFunction`. Replace it with:

```typescript
if (
  shouldSkipRewrite(preTags, postTags, invariantCall) ||
  allContractsFiltered(preTags, postTags, invariantCall, keepContracts)
) {
  return null;
}
```

- [ ] **Step 3: Pass `keepContracts` to `buildGuardedStatements` in `rewriteFunction`**

Find the `buildGuardedStatements(...)` call near the bottom of `rewriteFunction`. Add `keepContracts` as the last argument:

```typescript
const newStatements = buildGuardedStatements(
  factory, preTags, postTags, originalBody, location,
  invariantCall, prevCapture, exportedNames, keepContracts,
);
```

- [ ] **Step 4: Add `keepContracts` to `tryRewriteFunction` and forward it**

`tryRewriteFunction` currently starts around line 445. Add the param and pass it through:

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
  try {
    const rewritten = rewriteFunction(
      factory, node, reparsedFunctions, warn, checker,
      invariantExpressions, interfaceMethodContracts, allowIdentifiers, keepContracts,
    );
    if (rewritten === null) {
      return node;
    }
    transformed.value = true;
    return rewritten;
  } catch {
    return node;
  }
}
```

- [ ] **Step 5: Run the failing tests — confirm they now pass**

Run: `npm test -- --testPathPattern="transformer" --testNamePattern="keepContracts option" --no-coverage`
Expected: all tests in the `keepContracts option` describe block pass.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: all tests pass, coverage threshold met.

- [ ] **Step 7: Lint**

Run: `npm run lint`
Expected: no errors. Fix any `id-length`, `complexity`, or `max-len` violations.

- [ ] **Step 8: Commit**

```bash
git add src/function-rewriter.ts test/helpers.ts test/transformer.test.ts
git commit -m "feat: add keepContracts type, normaliser, and buildGuardedStatements filtering"
```
