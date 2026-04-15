# keepContracts Step 3 — Require-Import Regression Tests

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify that the `require('fs-axiom/contracts')` import is emitted when `keepContracts` results in at least one check being kept, and is **not** emitted when `keepContracts` filters all checks out for a given file.

**Architecture:** No source changes. The `transformed.value` flag already gates the require injection — this plan just adds regression tests to lock in that behaviour.

**Tech Stack:** TypeScript, Jest (`npm test`).

**Prerequisite:** Steps 1 and 2 must be complete.

---

## File Map

| File | Change |
|---|---|
| `test/transformer.test.ts` | New `describe('keepContracts — require injection', ...)` block |

---

### Task 1: Write and confirm the regression tests

**Files:**
- Modify: `test/transformer.test.ts`

- [ ] **Step 1: Add the new describe block**

Append at the bottom of `test/transformer.test.ts`:

```typescript
describe('keepContracts — require injection', () => {
  it('emits require import when keepContracts: "all" and contracts are present', () => {
    const source = `
      /** @pre x > 0 */
      export function inc(x: number): number { return x + 1; }
    `;
    const result = transform(source, { keepContracts: 'all' });
    expect(result).toContain("require('fs-axiom/contracts')");
  });

  it('does not emit require import when keepContracts filters all contracts out', () => {
    // Function has only @pre; keepContracts: 'post' means nothing is emitted.
    const source = `
      /** @pre x > 0 */
      export function inc(x: number): number { return x + 1; }
    `;
    const result = transform(source, { keepContracts: 'post' });
    expect(result).not.toContain("require('fs-axiom/contracts')");
  });
});
```

- [ ] **Step 2: Run the tests — they should pass without any source changes**

Run: `npm test -- --testPathPattern="transformer" --testNamePattern="keepContracts — require injection" --no-coverage`
Expected: both tests pass.

If the first test fails, check that `transformed.value` is still being set to `true` when `rewriteFunction` returns a non-null result. The `allContractsFiltered` guard in `rewriteFunction` (added in Step 1) should cause `rewriteFunction` to return `null` when all kinds are filtered out, which means `tryRewriteFunction` returns the original node unmodified and never sets `transformed.value = true`. Trace through the `keepContracts: 'all'` path to confirm a rewrite does happen and `transformed.value` is set.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all tests pass, coverage threshold met.

- [ ] **Step 4: Commit**

```bash
git add test/transformer.test.ts
git commit -m "test: verify require injection behaviour under keepContracts"
```
