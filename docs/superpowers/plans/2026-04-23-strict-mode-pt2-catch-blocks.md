# Strict Mode — Part 2: Catch Block Changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update `tryRewriteFunction` and `tryRewriteClass` catch blocks to throw (compile-level error) when `ctx.strict` is true, rather than silently swallowing the error.

**Architecture:** Two files change — `function-rewriter.ts` and `class-rewriter.ts`. Each catch block gains a `ctx.strict` check: if true, re-throw a descriptive `Error`; if false, fall through to the existing `warn + return node` behaviour. One new test file covers both paths.

**Tech Stack:** TypeScript, Jest

**Depends on:** `docs/superpowers/plans/2026-04-23-strict-mode-pt1-foundation.md` must be applied first — `ctx.strict` must exist on `TransformerContext` before this plan runs.

---

## How the error trigger works in tests

`reifyExpression` in `src/reifier.ts` throws `Unsupported expression node kind: ArrayLiteralExpression` when it encounters an array literal `[...]`. The contract validator only checks identifiers and assignment operators, so `@pre n === [0][0]` passes validation but causes `reifyExpression` to throw during AST construction — which is caught by `tryRewriteFunction`'s `catch` block.

Similarly, `@invariant this.n === [0][0]` on a class passes invariant validation but throws in `buildCheckInvariantsMethod` → `reifyExpression`, which is caught by `tryRewriteClass`'s `catch` block.

---

### Task 1: Update `tryRewriteFunction` catch block in `function-rewriter.ts`

**Files:**
- Modify: `src/function-rewriter.ts:560-567`
- Create: `test/transformer.strict-mode.test.ts`

- [ ] **Step 1: Write failing tests for the function strict path**

Create `test/transformer.strict-mode.test.ts`:

```typescript
import typescript from 'typescript';
import createTransformer, { factory as transformerFactory } from '@src/transformer';

function transformWithOptions(
  source: string,
  strict: boolean,
  warn?: (msg: string) => void,
): string {
  return typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS },
    transformers: {
      before: [createTransformer(undefined, { strict, warn })],
    },
  }).outputText;
}

const FUNCTION_SOURCE = `
  /**
   * @pre n === [0][0]
   */
  export function check(n: number): void {}
`;

describe('transformer — strict mode', () => {
  describe('tryRewriteFunction', () => {
    it('throws on internal error when strict: true', () => {
      expect(() => transformWithOptions(FUNCTION_SOURCE, true)).toThrow(
        /Internal error rewriting 'check'/,
      );
    });

    it('error message includes "strict: false to suppress" hint', () => {
      expect(() => transformWithOptions(FUNCTION_SOURCE, true)).toThrow(
        /strict: false to suppress/,
      );
    });

    it('calls warn and does not throw when strict: false', () => {
      const warnings: string[] = [];
      expect(() =>
        transformWithOptions(FUNCTION_SOURCE, false, (msg) => warnings.push(msg)),
      ).not.toThrow();
      expect(warnings.some((w) => w.includes('Internal error'))).toBe(true);
    });

    it('does not throw or warn for a valid contract when strict: true', () => {
      const source = `
        /**
         * @pre n > 0
         */
        export function positive(n: number): void {}
      `;
      const warnings: string[] = [];
      expect(() =>
        transformWithOptions(source, true, (msg) => warnings.push(msg)),
      ).not.toThrow();
      expect(warnings).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `npm test -- --testPathPattern=transformer.strict-mode`
Expected: FAIL — `strict` does not yet change the catch block behaviour; the throw tests will fail because no error is thrown, and the warn-not-throw test may pass or fail depending on current error path

- [ ] **Step 3: Update the `tryRewriteFunction` catch block**

In `src/function-rewriter.ts`, find `tryRewriteFunction` (around line 532). The current catch block (lines ~561–566) looks like:

```typescript
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    ctx.warn(
      `[axiom] Internal error in ${buildLocationName(node)}: ${errMsg}`,
    );
    return node;
  }
```

Replace it with:

```typescript
  } catch (err) {
    const fnName = buildLocationName(node);
    if (ctx.strict) {
      throw new Error(
        `[axiom] Internal error rewriting '${fnName}': ${String(err)}. `
        + `Contracts were NOT injected. Set strict: false to suppress.`,
      );
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    ctx.warn(
      `[axiom] Internal error in ${fnName}: ${errMsg}`,
    );
    return node;
  }
```

- [ ] **Step 4: Run the function strict tests to confirm they pass**

Run: `npm test -- --testPathPattern=transformer.strict-mode`
Expected: All four `tryRewriteFunction` tests pass

- [ ] **Step 5: Run all tests to confirm no regressions**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/function-rewriter.ts test/transformer.strict-mode.test.ts
git commit -m "feat: throw on internal error in tryRewriteFunction when strict: true"
```

---

### Task 2: Update `tryRewriteClass` catch block in `class-rewriter.ts`

**Files:**
- Modify: `src/class-rewriter.ts:482-491`
- Modify: `test/transformer.strict-mode.test.ts`

- [ ] **Step 1: Write failing tests for the class strict path**

In `test/transformer.strict-mode.test.ts`, add this describe block after the existing `tryRewriteFunction` describe block:

```typescript
const CLASS_SOURCE = `
  /**
   * @invariant this.n === [0][0]
   */
  export class Checker {
    public n: number = 0;
  }
`;

describe('tryRewriteClass', () => {
  it('throws on internal error when strict: true', () => {
    expect(() => transformWithOptions(CLASS_SOURCE, true)).toThrow(
      /Internal error rewriting 'Checker'/,
    );
  });

  it('error message includes "strict: false to suppress" hint', () => {
    expect(() => transformWithOptions(CLASS_SOURCE, true)).toThrow(
      /strict: false to suppress/,
    );
  });

  it('calls warn and does not throw when strict: false', () => {
    const warnings: string[] = [];
    expect(() =>
      transformWithOptions(CLASS_SOURCE, false, (msg) => warnings.push(msg)),
    ).not.toThrow();
    expect(warnings.some((w) => w.includes('Internal error'))).toBe(true);
  });
});

describe('factory export', () => {
  it('passes strict option through to createTransformer', () => {
    expect(() =>
      typescript.transpileModule(FUNCTION_SOURCE, {
        compilerOptions: { module: typescript.ModuleKind.CommonJS },
        transformers: { before: [transformerFactory(typescript, { strict: true })] },
      }),
    ).toThrow(/strict: false to suppress/);
  });
});
```

- [ ] **Step 2: Run the new tests to confirm the class tests fail**

Run: `npm test -- --testPathPattern=transformer.strict-mode`
Expected: The `tryRewriteFunction` tests pass; the `tryRewriteClass` and `factory export` tests fail because the class catch block and factory not yet updated

- [ ] **Step 3: Update the `tryRewriteClass` catch block**

In `src/class-rewriter.ts`, find `tryRewriteClass` (around line 477). The current catch block (lines ~483–490) looks like:

```typescript
  } catch (err) {
    const className = node.name?.text ?? 'UnknownClass';
    const errMsg = err instanceof Error ? err.message : String(err);
    ctx.warn(
      `[axiom] Internal error in ${className}: ${errMsg}`,
    );
    return node;
  }
```

Replace it with:

```typescript
  } catch (err) {
    const className = node.name?.text ?? 'UnknownClass';
    if (ctx.strict) {
      throw new Error(
        `[axiom] Internal error rewriting '${className}': ${String(err)}. `
        + `Contracts were NOT injected. Set strict: false to suppress.`,
      );
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    ctx.warn(
      `[axiom] Internal error in ${className}: ${errMsg}`,
    );
    return node;
  }
```

- [ ] **Step 4: Run all strict-mode tests to confirm they pass**

Run: `npm test -- --testPathPattern=transformer.strict-mode`
Expected: All tests pass (7 tests across `tryRewriteFunction`, `tryRewriteClass`, and `factory export`)

- [ ] **Step 5: Run all tests to confirm no regressions**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/class-rewriter.ts test/transformer.strict-mode.test.ts
git commit -m "feat: throw on internal error in tryRewriteClass when strict: true; add factory export test"
```
