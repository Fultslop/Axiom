# Try/Catch Body Contracts Implementation Plan

Status: done

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow `@pre` and `@post` contracts to be injected on functions whose body contains a `try/catch` block.

**Architecture:** `buildBodyCapture` (ast-builder.ts) calls `reifyStatement` on every statement in a function body to produce a fully-synthesised IIFE. `reifyStatement` (reifier.ts) has no case for `TryStatement` and throws — this exception propagates to the `try/catch` wrapper in `tryRewriteFunction`, which logs `[axiom] Internal error` and returns the original function with all contracts dropped. The fix is a single new case in `reifyStatement` that recursively reifies the try-block, catch-clause, and optional finally-block.

**Tech Stack:** TypeScript compiler API (`typescript`), Jest

---

## File map

| File | Change |
|---|---|
| `src/reifier.ts` | Add `TryStatement` case to `reifyStatement` before line 332 |
| `test/transformer.test.ts` | Add try/catch contract tests |
| `docs/reference.md` | Remove try/catch from limitation #6 |

---

### Task 1: Failing tests — `@pre` and `@post` on try/catch functions

**Files:**
- Modify: `test/transformer.test.ts`

- [ ] **Step 1: Write two failing tests**

Add these two `describe` blocks to `test/transformer.test.ts`:

```typescript
describe('@pre on function with try/catch body', () => {
  it('injects @pre guard before the try block', () => {
    const source = `
      /** @pre amount > 0 */
      export function parse(amount: number): number {
        try { return JSON.parse(String(amount)); } catch { return 0; }
      }
    `;
    const warnings: string[] = [];
    const js = transform(source, (msg) => warnings.push(msg));
    expect(warnings).toEqual([]);
    const fn = evalTransformedWith(js, 'parse') as (n: number) => number;
    expect(() => fn(-1)).toThrow('PRE');
    expect(fn(1)).toBe(1);
  });
});

describe('@post on function with try/catch body', () => {
  it('injects @post check after the try/catch IIFE', () => {
    const source = `
      /**
       * @pre amount > 0
       * @post result >= 0
       */
      export function parse(amount: number): number {
        try { return JSON.parse(String(amount)); } catch { return -1; }
      }
    `;
    const warnings: string[] = [];
    const js = transform(source, (msg) => warnings.push(msg));
    expect(warnings).toEqual([]);
    const fn = evalTransformedWith(js, 'parse') as (n: number) => number;
    expect(() => fn(-1)).toThrow('PRE');
    expect(() => fn(1)).toThrow('POST'); // -1 violates result >= 0
    expect(fn(42)).toBe(42);
  });
});
```

The file already imports `transform` and `evalTransformedWith` from `./helpers` at the top. Use those names exactly.

- [ ] **Step 2: Run the tests and confirm they fail**

```
npm test -- --testPathPattern="transformer.test" --testNamePattern="try/catch"
```

Expected: both tests fail. The first likely fails with `[axiom] Internal error in parse: Unsupported statement node kind: TryStatement` (logged as a warning, no throw). Confirm by checking `warnings` in the first test — it will contain the internal error message rather than being empty.

---

### Task 2: Add `TryStatement` to `reifyStatement`

**Files:**
- Modify: `src/reifier.ts:322-332`

- [ ] **Step 1: Add the TryStatement case**

In `src/reifier.ts`, insert the following block immediately before the `throw new Error(...)` at line 332 (after the `loopResult` block):

```typescript
  if (typescript.isTryStatement(node)) {
    const reifiedTryBlock = factory.createBlock(
      Array.from(node.tryBlock.statements).map((s) => reifyStatement(factory, s)),
      true,
    );
    const reifiedCatchClause = node.catchClause !== undefined
      ? factory.createCatchClause(
          node.catchClause.variableDeclaration !== undefined
            ? factory.createVariableDeclaration(
                typescript.isIdentifier(node.catchClause.variableDeclaration.name)
                  ? factory.createIdentifier(node.catchClause.variableDeclaration.name.text)
                  : node.catchClause.variableDeclaration.name,
              )
            : undefined,
          factory.createBlock(
            Array.from(node.catchClause.block.statements).map((s) => reifyStatement(factory, s)),
            true,
          ),
        )
      : undefined;
    const reifiedFinallyBlock = node.finallyBlock !== undefined
      ? factory.createBlock(
          Array.from(node.finallyBlock.statements).map((s) => reifyStatement(factory, s)),
          true,
        )
      : undefined;
    return factory.createTryStatement(
      reifiedTryBlock,
      reifiedCatchClause,
      reifiedFinallyBlock,
    );
  }
```

The catch variable binding falls back to `node.catchClause.variableDeclaration.name` for destructuring patterns (consistent with how `isVariableStatement` handles non-identifier bindings at line 300).

- [ ] **Step 2: Run the tests**

```
npm test -- --testPathPattern="transformer.test" --testNamePattern="try/catch"
```

Expected: both tests pass.

- [ ] **Step 3: Run the full test suite**

```
npm test
```

Expected: all tests pass, no regressions.

- [ ] **Step 4: Commit**

```bash
git add src/reifier.ts test/transformer.test.ts
git commit -m "feat: support @pre/@post on functions with try/catch bodies"
```

---

### Task 3: Edge cases — `finally` block and nested try/catch

**Files:**
- Modify: `test/transformer.test.ts`

- [ ] **Step 1: Write edge case tests**

```typescript
describe('@pre on function with try/catch/finally body', () => {
  it('injects @pre and preserves finally execution', () => {
    const source = `
      /** @pre x > 0 */
      export function withFinally(x: number): number {
        try { return x * 2; } catch { return 0; } finally { /* cleanup */ }
      }
    `;
    const warnings: string[] = [];
    const js = transform(source, (msg) => warnings.push(msg));
    expect(warnings).toEqual([]);
    const fn = evalTransformedWith(js, 'withFinally') as (n: number) => number;
    expect(() => fn(0)).toThrow('PRE');
    expect(fn(3)).toBe(6);
  });
});

describe('@pre on function with try/catch only (no catch binding)', () => {
  it('handles catch clause with no variable binding', () => {
    const source = `
      /** @pre s.length > 0 */
      export function parseJson(s: string): unknown {
        try { return JSON.parse(s); } catch { return null; }
      }
    `;
    const warnings: string[] = [];
    const js = transform(source, (msg) => warnings.push(msg));
    expect(warnings).toEqual([]);
    const fn = evalTransformedWith(js, 'parseJson') as (s: string) => unknown;
    expect(() => fn('')).toThrow('PRE');
    expect(fn('{"a":1}')).toEqual({ a: 1 });
  });
});
```

- [ ] **Step 2: Run edge case tests**

```
npm test -- --testPathPattern="transformer.test" --testNamePattern="try/catch|finally|catch clause"
```

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add test/transformer.test.ts
git commit -m "test: edge cases for try/catch/finally contract injection"
```

---

### Task 4: Update reference.md

**Files:**
- Modify: `docs/reference.md`

- [ ] **Step 1: Remove try/catch from limitation #6**

In `docs/reference.md`, find limitation **6** ("Unsupported expression constructs..."). The limitation lists three internal error cases. Remove the try/catch example:

```typescript
// Internal error — try/catch body prevents reification
/** @pre amount > 0 */
export function parse(amount: number): number {
  try { return JSON.parse(String(amount)); } catch { return 0; }
}
```

Also remove the sentence "or when the function body contains a `try/catch` block," from the limitation description.

- [ ] **Step 2: Add try/catch to the Supported cases list**

In the `## Supported cases` section of `docs/reference.md`, add after the constructor contracts bullet:

```
- `@pre` and `@post` on functions whose body contains `try/catch` — the body is wrapped in an IIFE that captures the return value from any branch; `@pre` guards run before the try block; `@post` checks the resolved value; `finally` blocks are preserved and execute normally
```

- [ ] **Step 3: Commit**

```bash
git add docs/reference.md
git commit -m "docs: update reference.md — try/catch contracts now supported"
```
