# Coverage Threshold Increase to 95% Branch — Design Doc

**Date:** 2026-04-22
**Covers:** Spec 004 finding #3 — Branch coverage floor too low for an AST transformer (Medium)

---

## 1. Problem

Jest is configured with an 80% branch coverage threshold. Current branch coverage is 85%. For an AST transformer library, uncovered branches are disproportionately likely to be edge-case paths in complex AST manipulation — multiple inheritance levels, async generators, partial property chains. These are exactly the scenarios where bugs silently corrupt user code.

Four files have particularly low coverage:
- `src/tag-pipeline.ts` (~87% branch)
- `src/class-rewriter.ts` (merge and multi-inheritance paths)
- `src/assertions.ts` (JSON fallback in `deepSnapshot`)
- `src/require-injection.ts` (~79% branch)

---

## 2. Goals

- Jest `coverageThreshold` is raised to `{ branches: 95, functions: 90, lines: 90, statements: 90 }`.
- All four identified under-covered files reach the new threshold.
- No new source code is changed — only tests are added and the threshold is raised.
- The threshold increase is done last, after the new tests are written (so CI doesn't block mid-implementation).

---

## 3. Approach

### 3.1 Identify uncovered branches

Run `npm run test:coverage` and open the HTML coverage report to identify specific uncovered branches in each file. For each uncovered branch, write a focused test that exercises it.

### 3.2 `src/require-injection.ts` (~79% branch)

Likely uncovered paths:
- CJS vs ESM injection paths
- Files with no matching contract identifiers (no-op path)
- Multiple require statements injected in one file

Add tests using `transpileModule` with `compilerOptions.module` set to both CJS and ESM targets.

### 3.3 `src/tag-pipeline.ts` (~87% branch)

Likely uncovered paths:
- Tags with no expression (empty `@pre` or `@post`)
- Tags with whitespace-only expression
- Multiple tags of the same kind on one function

Add unit tests directly on the pipeline functions if they are exported, or integration tests via `transpileModule`.

### 3.4 `src/class-rewriter.ts` (merge and multi-inheritance)

Likely uncovered paths:
- Class inheriting from two levels deep (grandparent contracts)
- Class with both base class and implemented interface contracts
- Class with `@invariant` and no public methods

These require full-program mode tests (`transformWithProgram`).

### 3.5 `src/assertions.ts` (JSON fallback in `deepSnapshot`)

The JSON fallback path executes when `structuredClone` is unavailable. Test by temporarily removing `globalThis.structuredClone` in a test.

See also spec `2026-04-22-snapshot-test-coverage-design.md` for more assertions tests.

### 3.6 Raise the threshold

After all new tests are written and passing, update `jest.config.ts`:

```typescript
coverageThreshold: {
  global: { branches: 95, functions: 90, lines: 90, statements: 90 }
}
```

---

## 4. Changes Summary

| File | Change |
|---|---|
| `jest.config.ts` | Raise `branches` threshold to 95, `functions`/`lines`/`statements` to 90 |
| `test/require-injection.test.ts` (new or existing) | Add CJS/ESM path tests |
| `test/tag-pipeline.test.ts` (new or existing) | Add edge-case tag parsing tests |
| `test/class-rewriter.test.ts` (new or existing) | Add multi-inheritance and deep inheritance tests |
| `test/assertions.test.ts` | Add `deepSnapshot` JSON fallback test (see snapshot-test-coverage spec) |

---

## 5. Testing Plan

The work IS the testing plan. Success criterion: `npm run test:coverage` passes with the raised threshold.

---

## 6. Out of Scope

- 100% branch coverage — 95% is the target; some branches may be defensive guards that cannot be triggered from public API.
- Per-file thresholds — global threshold only.
- Modifying source code to remove untestable branches — only tests are added.
