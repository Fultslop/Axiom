# Async Arrow Function Contracts Implementation Plan

Status: done

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow `@pre` and `@post` contracts on exported `const`-assigned async arrow functions (`export const f = async (x) => ...`).

**Architecture:** Non-async arrows already work via `rewriteVariableDeclaration` in `transformer.ts`, which normalises expression bodies to block bodies and calls `tryRewriteFunction`. The `async` modifier is preserved through `normaliseArrowBody` (it calls `factory.updateArrowFunction` with the original modifiers). The async IIFE path in `buildBodyCapture` is also already implemented (`isAsync` flag). Code analysis suggests the fix is plumbing, not structural — but the exact failure mode must be confirmed with a failing test before applying any fix.

**Outcome:** Task 1 tests passed without any source fix — no failure mode was observed. The feature was already fully implemented. Tasks 2A/B/C were not needed.

**Tech Stack:** TypeScript compiler API (`typescript`), Jest

---

## File map

| File | Change |
|---|---|
| `test/transformer.test.ts` | Add async arrow contract tests (written first) |
| `src/jsdoc-parser.ts` | Likely fix location — `extractContractTagsForFunctionLike` |
| `src/function-rewriter.ts` | Possible fix location — `normaliseArrowBody` |
| `docs/reference.md` | Remove async arrow from limitation #4, add to supported cases |

---

### Task 1: Failing test — confirm exact failure mode

**Files:**
- Modify: `test/transformer.test.ts`

- [ ] **Step 1: Write a failing test for an async arrow with `@pre`**

Add to `test/transformer.test.ts`:

```typescript
describe('async arrow function with @pre (expression body)', () => {
  it('injects @pre guard into async expression-body arrow', async () => {
    const source = `
      /** @pre id > 0 */
      export const fetchUser = async (id: number): Promise<string> => \`user-\${id}\`;
    `;
    const warnings: string[] = [];
    const js = transform(source, (msg) => warnings.push(msg));
    expect(warnings).toEqual([]);
    const fn = evalTransformedWith(js, 'fetchUser') as (id: number) => Promise<string>;
    await expect(fn(-1)).rejects.toThrow('PRE');
    await expect(fn(1)).resolves.toBe('user-1');
  });
});
```

- [ ] **Step 2: Run the test and read the output carefully**

```
npm test -- --testPathPattern="transformer.test" --testNamePattern="async arrow.*@pre"
```

Expected: test fails. **Read the failure message carefully.** There are three possible failure modes:

**Mode A — Contracts silently skipped (no injection, no warning):**
The `warnings` array is empty but the function does not throw on `fn(-1)`. This means tag extraction returned empty — the `@pre` was never found. The fix is in JSDoc extraction.

**Mode B — Internal error warning:**
The `warnings` array contains `[axiom] Internal error in fetchUser: ...`. This means tag extraction worked but reification failed. Read the error message to find the exact node kind.

**Mode C — Wrong injection (e.g. result is not awaited):**
The pre-check fires but `fn(-1)` does not reject (it resolves or throws synchronously). This means the async wrapping is broken.

Note which mode you observe — the fix differs for each.

---

### Task 2A: Fix for Mode A — tag extraction not finding JSDoc on async arrows

**Files:**
- Modify: `src/jsdoc-parser.ts:82-100`

Applies if the test shows contracts silently skipped with no warnings.

The root cause in Mode A: `extractContractTagsForFunctionLike` calls `typescript.getJSDocTags(node)` on the arrow function node (direct check), then falls back to walking up the `parent` chain to the variable statement. For the **normalised** arrow created by `factory.updateArrowFunction`, the `parent` property is `undefined` (synthesized nodes have no parent). This means the fallback path at line 92-98 of `jsdoc-parser.ts` never triggers.

The fix: `extractContractTags` already receives the `reparsedNode` (from `buildReparsedIndex`, which sets parents). However, `rewriteFunction` in `function-rewriter.ts` passes `funcNode` (the synthesized, normalised arrow) as `node`, and uses `reparsedNode` only for tag extraction. Confirm that `extractContractTags(reparsedNode)` is what is called. If it IS the reparsed node, check whether `getJSDocTags` on the reparsed arrow finds the tag.

- [ ] **Step 1: Add a diagnostic log to confirm**

Temporarily add to `rewriteFunction` (function-rewriter.ts, line ~510, before `extractAndFilterTags`):

```typescript
const debugTags = extractContractTags(reparsedNode);
ctx.warn(`[debug] reparsed tags for ${location}: ${JSON.stringify(debugTags)}`);
```

Run the test and check whether the debug line shows the `@pre` tag. Remove the debug line after confirming.

- [ ] **Step 2: Apply the fix based on what the diagnostic reveals**

If `extractContractTags(reparsedNode)` returns empty for the reparsed async arrow: the JSDoc is attached to the **VariableStatement** in the reparsed source, not the arrow function directly. Check `reparsedNode.parent`:

```typescript
// In jsdoc-parser.ts extractContractTagsForFunctionLike, confirm the parent chain
// works for async arrows by checking the parent of the reparsed async arrow node.
```

If the parent chain is set but `getJSDocTags(variableStatement)` returns empty, the JSDoc comment might not be in the expected position. Check the exact source format — the JSDoc must be on the line BEFORE `export const`, not inline between `=` and `async`.

The fix for inline placement (`export const f = /** @pre */ async () => ...`): walk the leading trivia of the arrow function's first token to extract JSDoc manually, or emit a warning that inline placement is not supported for async arrows and require the JSDoc before `export const`.

- [ ] **Step 3: Remove the diagnostic log, run the full test suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/jsdoc-parser.ts test/transformer.test.ts
git commit -m "fix: extract @pre/@post tags for async arrow function constants"
```

---

### Task 2B: Fix for Mode B — internal error during reification

**Files:**
- Modify: whichever file the error message points to

Applies if the test shows an `[axiom] Internal error` warning.

- [ ] **Step 1: Read the error message**

The error will say `Unsupported [expression|statement] node kind: <KindName>`. Look up `typescript.SyntaxKind.<KindName>` to understand what construct is failing. Common candidates:

- `AwaitExpression` — if the contract expression itself contains `await`
- `AsyncKeyword` — if the modifier is being treated as an expression

- [ ] **Step 2: Add the missing case to `reifyExpression` or `reifyStatement` in `src/reifier.ts`**

For `AwaitExpression`:
```typescript
if (typescript.isAwaitExpression(node)) {
  return factory.createAwaitExpression(reifyExpression(factory, node.expression));
}
```

Add this after the `isTypeOfExpression` case at line 141.

- [ ] **Step 3: Run the full test suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/reifier.ts test/transformer.test.ts
git commit -m "fix: support async arrow function contracts (reifier mode)"
```

---

### Task 2C: Fix for Mode C — async result not awaited

**Files:**
- Modify: `src/function-rewriter.ts` or `src/ast-builder.ts`

Applies if the pre-check fires but the async resolution is wrong.

- [ ] **Step 1: Confirm `isAsyncFunction` returns true for the normalised arrow**

Temporarily add a log in `rewriteFunction` (function-rewriter.ts, ~line 523):

```typescript
ctx.warn(`[debug] isAsync for ${location}: ${isAsyncFunction(node)}`);
```

Run the test and confirm. Remove the log after confirming.

- [ ] **Step 2: If `isAsyncFunction` returns false**

The normalized arrow from `normaliseArrowBody` may not preserve the `async` modifier. In `function-rewriter.ts:141-159`, `normaliseArrowBody` calls:

```typescript
factory.updateArrowFunction(
  node,
  typescript.getModifiers(node),
  ...
)
```

`typescript.getModifiers` on a source-file node returns modifiers correctly. But on a fully synthesized node it may return `undefined`. Confirm whether `init` (the original source node, not the normalized one) has the `async` modifier visible via `getModifiers`.

The fix: pass `node` (the original `init`) to `isAsyncFunction` instead of `funcNode`:

In `rewriteFunction` (function-rewriter.ts), change:
```typescript
const asyncFlag = isAsyncFunction(node);
```
to:
```typescript
const asyncFlag = isAsyncFunction(node) || isAsyncFunction(locationNode ?? node);
```

where `locationNode` is the original `init` passed from `tryRewriteFunction`.

- [ ] **Step 3: Run the full test suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/function-rewriter.ts test/transformer.test.ts
git commit -m "fix: preserve async modifier for const-assigned arrow function contracts"
```

---

### Task 3: Additional tests — block body and `@post`

**Files:**
- Modify: `test/transformer.test.ts`

Only after Task 2 (whichever mode) passes.

- [ ] **Step 1: Write additional tests**

```typescript
describe('async arrow function with @pre (block body)', () => {
  it('injects @pre guard into async block-body arrow', async () => {
    const source = `
      /** @pre id > 0 */
      export const fetchUser = async (id: number): Promise<string> => {
        return \`user-\${id}\`;
      };
    `;
    const warnings: string[] = [];
    const js = transform(source, (msg) => warnings.push(msg));
    expect(warnings).toEqual([]);
    const fn = evalTransformedWith(js, 'fetchUser') as (id: number) => Promise<string>;
    await expect(fn(0)).rejects.toThrow('PRE');
    await expect(fn(5)).resolves.toBe('user-5');
  });
});

describe('async arrow function with @post result', () => {
  it('checks resolved value, not Promise object', async () => {
    const source = `
      /**
       * @pre id > 0
       * @post result !== null
       */
      export const findUser = async (id: number): Promise<string | null> =>
        id === 99 ? null : \`user-\${id}\`;
    `;
    const warnings: string[] = [];
    const js = transform(source, (msg) => warnings.push(msg));
    expect(warnings).toEqual([]);
    const fn = evalTransformedWith(js, 'findUser') as (id: number) => Promise<string | null>;
    await expect(fn(0)).rejects.toThrow('PRE');
    await expect(fn(99)).rejects.toThrow('POST');
    await expect(fn(1)).resolves.toBe('user-1');
  });
});

describe('async arrow returning Promise<void> — @post dropped with warning', () => {
  it('drops @post and emits a warning', async () => {
    const source = `
      /** @post result !== null */
      export const logUser = async (id: number): Promise<void> => { /* noop */ };
    `;
    const warnings: string[] = [];
    const js = transform(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes('void') && w.includes('@post'))).toBe(true);
    const fn = evalTransformedWith(js, 'logUser') as (id: number) => Promise<void>;
    await expect(fn(1)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run all new tests**

```
npm test -- --testPathPattern="transformer.test" --testNamePattern="async arrow"
```

Expected: all pass.

- [ ] **Step 3: Run the full test suite**

```
npm test
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add test/transformer.test.ts
git commit -m "test: async arrow @pre/@post edge cases"
```

---

### Task 4: Update reference.md

**Files:**
- Modify: `docs/reference.md`

- [ ] **Step 1: Remove limitation #4**

In `docs/reference.md`, remove limitation **4** ("Async arrow functions are not instrumented") entirely, including its code block.

- [ ] **Step 2: Update the supported cases list**

Find the existing bullet:

```
- `@pre` and `@post` on exported `const` arrow functions and function expressions — expression-body arrows are normalised to block bodies automatically; the location string uses the variable name; JSDoc must precede the `const` keyword
```

Update it to:

```
- `@pre` and `@post` on exported `const` arrow functions and function expressions, including `async` arrows — expression-body arrows are normalised to block bodies automatically; `async` arrows await the IIFE result identically to `async function` declarations; the location string uses the variable name; JSDoc must precede the `const` keyword
```

- [ ] **Step 3: Commit**

```bash
git add docs/reference.md
git commit -m "docs: update reference.md — async arrow contracts now supported"
```
