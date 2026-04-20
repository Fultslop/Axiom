# Contract Expression Error Messages Implementation Plan

Status: done

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic `[axiom] Internal error` for unsupported constructs in contract expressions (array literals, arrow functions) with targeted, actionable warnings that drop only the affected tag — not all contracts on the function.

**Architecture:** `reifyExpression` in `reifier.ts` throws `Unsupported expression node kind: <X>` for array literals and arrow functions. This throw propagates from `buildGuardIf` → `buildPreCheck`/`buildPostCheck` → `buildGuardedStatements` → `rewriteFunction` → caught by `tryRewriteFunction`, which drops ALL contracts on the function and logs a generic internal error. The fix moves detection upstream: a new `findUnsupportedExpressionNode` function in `reifier.ts` walks the expression AST before reification and returns a targeted error description. `filterValidTags` in `tag-pipeline.ts` calls this check after `parseContractExpression`, so unsupported tags are dropped individually with a clear warning — the function's other contracts are unaffected.

**Tech Stack:** TypeScript compiler API (`typescript`), Jest

---

## File map

| File | Change |
|---|---|
| `src/reifier.ts` | Add `findUnsupportedExpressionNode` export |
| `src/tag-pipeline.ts` | Call the new check in `filterValidTags` |
| `test/transformer.warnings.test.ts` | Add targeted warning tests |
| `docs/reference.md` | Update limitation #6 description and examples |

---

### Task 1: Failing tests — confirm current behaviour

**Files:**
- Modify: `test/transformer.warnings.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/transformer.warnings.test.ts`:

```typescript
describe('array literal in @post expression — targeted warning, other contracts preserved', () => {
  it('drops only the @post tag and keeps @pre', () => {
    const source = `
      /**
       * @pre items.length > 0
       * @post result === [1, 2, 3]
       */
      export function getItems(items: number[]): number[] {
        return items;
      }
    `;
    const warnings: string[] = [];
    const js = transform(source, (msg) => warnings.push(msg));
    // Should warn about the array literal @post, but NOT emit an internal error
    expect(warnings.some((w) => w.includes('Internal error'))).toBe(false);
    expect(warnings.some((w) => w.includes('array literal') || w.includes('ArrayLiteralExpression'))).toBe(true);
    // @pre must still be injected
    const fn = evalTransformedWith(js, 'getItems') as (items: number[]) => number[];
    expect(() => fn([])).toThrow('PRE');
    expect(fn([1])).toEqual([1]);
  });
});

describe('arrow function in @post expression — targeted warning, other contracts preserved', () => {
  it('drops only the offending @post tag and keeps @pre', () => {
    const source = `
      /**
       * @pre items.length > 0
       * @post result === items.map(x => x * 2)
       */
      export function doubled(items: number[]): number[] {
        return items.map(x => x * 2);
      }
    `;
    const warnings: string[] = [];
    const js = transform(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes('Internal error'))).toBe(false);
    expect(warnings.some((w) => w.includes('arrow') || w.includes('ArrowFunction') || w.includes('function expression'))).toBe(true);
    const fn = evalTransformedWith(js, 'doubled') as (items: number[]) => number[];
    expect(() => fn([])).toThrow('PRE');
    expect(fn([2])).toEqual([4]);
  });
});
```

The file imports `transform` from `./helpers`. Add `evalTransformedWith` to the same import line: `import { transform, transpileWithWarn, transformWithProgram, evalTransformedWith } from './helpers';`

- [ ] **Step 2: Run the tests and confirm failure**

```
npm test -- --testPathPattern="transformer.warnings" --testNamePattern="array literal|arrow function in"
```

Expected: both fail. The `warnings` array currently contains `[axiom] Internal error in ...` (not the targeted warning), and the function has no `@pre` injection (all contracts dropped).

---

### Task 2: Add `findUnsupportedExpressionNode` to reifier.ts

**Files:**
- Modify: `src/reifier.ts`

- [ ] **Step 1: Add the detection function**

Add the following function to `src/reifier.ts`, **after** `reifyExpression` (after line 158) and **before** `reifyForInitializer`:

```typescript
/**
 * Walks an expression AST and returns a human-readable description of the
 * first node kind that reifyExpression cannot handle, or undefined if the
 * expression is fully reifiable.
 */
export function findUnsupportedExpressionNode(
  node: typescript.Expression,
): string | undefined {
  if (typescript.isArrayLiteralExpression(node)) {
    return 'array literal — use a property check such as result.length === N instead';
  }
  if (typescript.isArrowFunction(node) || typescript.isFunctionExpression(node)) {
    return 'function expression — contract expressions must be pure predicates, not callbacks';
  }
  // Recursively check children for the expression node kinds reifyExpression handles
  let found: string | undefined;
  node.forEachChild((child) => {
    if (found !== undefined) {
      return;
    }
    if (typescript.isExpression(child)) {
      found = findUnsupportedExpressionNode(child as typescript.Expression);
    }
  });
  return found;
}
```

- [ ] **Step 2: Verify the function compiles**

```
npm run typecheck
```

Expected: no errors.

---

### Task 3: Call the check in `filterValidTags`

**Files:**
- Modify: `src/tag-pipeline.ts:170-200`

- [ ] **Step 1: Import the new function**

In `src/tag-pipeline.ts`, add `findUnsupportedExpressionNode` to the import from `./reifier`:

```typescript
import { findUnsupportedExpressionNode } from './reifier';
```

If `reifier` is not currently imported in `tag-pipeline.ts`, add the import line. Check the existing imports at the top of the file.

Actually, `tag-pipeline.ts` already imports `parseContractExpression` from `./ast-builder`, not from `./reifier`. Add a new import:

```typescript
import { findUnsupportedExpressionNode } from './reifier';
```

- [ ] **Step 2: Add the check in `filterValidTags`**

In `filterValidTags` (line ~180), add the unsupported-node check **before** the `validateExpression` call:

```typescript
export function filterValidTags(
  tags: ContractTag[],
  kind: 'pre' | 'post',
  location: string,
  warn: (msg: string) => void,
  knownIdentifiers: Set<string>,
  paramTypes?: Map<string, TypeMapValue>,
  checker?: typescript.TypeChecker,
  contextNode?: typescript.FunctionLikeDeclaration,
): ContractTag[] {
  return tags.filter((tag) => {
    const parsed = parseContractExpression(tag.expression);
    const unsupported = findUnsupportedExpressionNode(parsed);
    if (unsupported !== undefined) {
      warn(
        `[axiom] Warning: @${kind} ${tag.expression} — ${unsupported}`
        + ` (in ${location}); tag dropped`,
      );
      return false;
    }
    const errors = validateExpression(
      parsed,
      tag.expression,
      location,
      knownIdentifiers,
      paramTypes,
      checker,
      contextNode,
    );
    if (errors.length > 0) {
      errors.forEach((err) => {
        warn(`[axiom] Contract validation warning in ${location}:`
          + `\n  @${kind} ${err.expression} — ${err.message}`);
      });
      return false;
    }
    return true;
  });
}
```

Note: the original `filterValidTags` calls `parseContractExpression(tag.expression)` inside `validateExpression`. Extract the parse call to a `const parsed` variable so both the unsupported check and `validateExpression` use the same parsed result. Look at the current `validateExpression` signature in `contract-validator.ts` to confirm it takes the parsed `Expression` node as its first argument (it does — see `tag-pipeline.ts:181`).

- [ ] **Step 3: Run the failing tests**

```
npm test -- --testPathPattern="transformer.warnings" --testNamePattern="array literal|arrow function in"
```

Expected: both tests pass. Warnings contain targeted descriptions, `@pre` is still injected.

- [ ] **Step 4: Run the full test suite**

```
npm test
```

Expected: all tests pass, no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/reifier.ts src/tag-pipeline.ts test/transformer.warnings.test.ts
git commit -m "feat: targeted warnings for unsupported constructs in contract expressions"
```

---

### Task 4: Void expression in contracts

**Files:**
- Modify: `test/transformer.warnings.test.ts`

`void` expressions in contract expressions (`@post void 0`) are also unsupported. Add coverage.

- [ ] **Step 1: Write the test**

```typescript
describe('void expression in @pre — targeted warning', () => {
  it('drops the tag with a targeted warning', () => {
    const source = `
      /** @pre void 0 */
      export function noop(x: number): void {}
    `;
    const warnings: string[] = [];
    transform(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes('Internal error'))).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test**

```
npm test -- --testPathPattern="transformer.warnings" --testNamePattern="void expression"
```

If the test fails, check whether `VoidExpression` is handled or thrown by `reifyExpression`. If it throws, add it to `findUnsupportedExpressionNode`:

```typescript
if (typescript.isVoidExpression(node)) {
  return 'void expression — contract expressions must be pure predicates';
}
```

Add this check in `src/reifier.ts` after the `isArrowFunction` check in `findUnsupportedExpressionNode`.

- [ ] **Step 3: Run the full test suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/reifier.ts test/transformer.warnings.test.ts
git commit -m "feat: targeted warning for void expression in contract"
```

---

### Task 5: Update reference.md

**Files:**
- Modify: `docs/reference.md`

- [ ] **Step 1: Update limitation #6 description**

Find limitation **6** ("Unsupported expression constructs..."). Update the description paragraph:

**From:**
```
the contract reifier handles a defined set of expression and statement node kinds. When a contract expression contains an unsupported construct (e.g. an array literal, an arrow function, or a `void` expression), or when the function body contains a `try/catch` block, the reifier cannot process the function and emits an `[axiom] Internal error` warning. All contracts on that function are dropped — no pre/post injection occurs.
```

**To:**
```
the contract reifier handles a defined set of expression node kinds. When a contract expression contains an unsupported construct — an array literal, an arrow function, or a `void` expression — that specific tag is dropped with a targeted warning. Other contracts on the same function are unaffected. The warning format is:
```

```
[axiom] Warning: @post result === [1, 2, 3] — array literal — use a property check such as result.length === N instead (in getItems); tag dropped
```

- [ ] **Step 2: Update the code examples**

Replace the three code examples with:

```typescript
// @post tag dropped — array literal in contract expression
/** @post result === [1, 2, 3] */
// warns: array literal — use a property check such as result.length === N instead
export function getItems(): number[] { … }

// @post tag dropped — arrow function in contract expression
/** @post result === items.map(x => x * 2) */
// warns: function expression — contract expressions must be pure predicates, not callbacks
export function doubled(items: number[]): number[] { … }
```

- [ ] **Step 3: Commit**

```bash
git add docs/reference.md
git commit -m "docs: update reference.md — targeted warnings for unsupported expression constructs"
```
