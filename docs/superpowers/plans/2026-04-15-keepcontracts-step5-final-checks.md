# keepContracts Step 5 — Final Lint, Typecheck, Coverage & Acceptance

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Confirm the full implementation passes all quality gates — lint, typecheck, coverage threshold, dead-code check — and perform a manual acceptance walkthrough against the spec checklist.

**Architecture:** No source changes expected. Fix any lint or type errors that surface, then tick through the acceptance checklist.

**Tech Stack:** TypeScript, Jest, ESLint, Knip.

**Prerequisite:** Steps 1–4 must be complete (Steps 1–3 required; Step 4 optional stretch).

---

## File Map

| File | Change |
|---|---|
| `src/*.ts` / `test/*.ts` | Fix any lint or typecheck violations found — no planned new code |

---

### Task 1: Lint

- [ ] **Step 1: Run lint**

```bash
npm run lint
```

Expected: no errors.

Common violations to watch for:
- `id-length`: variable names like `raw`, `msg`, `fn` are too short — rename to `rawValue`, `message`, `func` etc.
- `complexity`: if any function has too many branches after the changes, extract a helper.
- `max-len`: lines over 100 chars — wrap at a logical boundary.

- [ ] **Step 2: Fix any violations and re-run lint until clean**

```bash
npm run lint:fix
npm run lint
```

- [ ] **Step 3: Commit lint fixes (if any)**

```bash
git add -p
git commit -m "chore: lint fixes for keepContracts implementation"
```

---

### Task 2: Typecheck

- [ ] **Step 1: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 2: Fix any errors**

Type errors most likely to appear after threading a new parameter:
- A call site that was not updated when a function signature was extended.
- A default parameter used in a position where TypeScript cannot infer the default.

Fix the specific error reported, then re-run typecheck.

- [ ] **Step 3: Commit typecheck fixes (if any)**

```bash
git add -p
git commit -m "chore: typecheck fixes for keepContracts implementation"
```

---

### Task 3: Coverage

- [ ] **Step 1: Run tests with coverage**

```bash
npm run test:coverage
```

Expected: all tests pass, all coverage thresholds met (80% minimum for statements, branches, functions, lines).

If a threshold is missed, identify which branches are untested using the coverage report output, write a minimal test that exercises the uncovered branch, and re-run.

---

### Task 4: Dead-code check

- [ ] **Step 1: Run Knip**

```bash
npm run knip
```

Expected: no new unused exports introduced by this change.

If `normaliseKeepContracts` is flagged as unused (only consumed internally by `transformer.ts`), consider making it unexported — change `export function` to `function` in `src/function-rewriter.ts` and remove the re-import in `transformer.ts` if you inline the logic. Only do this if no test file imports it directly.

---

### Task 5: Acceptance checklist

Work through each item manually by running small transforms in a test REPL or by reading the test output. Tick off each item:

- [ ] `keepContracts` absent (default): output byte-for-byte identical to before this change.
- [ ] `keepContracts: false` explicitly set: same as above — no regression.
- [ ] `keepContracts: true` and `keepContracts: 'all'` produce identical output; both contain `@pre` and `@post` checks for a function with both tags.
- [ ] `keepContracts: 'pre'`: function with `@pre x > 0` and `@post result > 0` emits only the pre assertion; no `__axiom_result__` or result-return scaffolding.
- [ ] `keepContracts: 'post'`: same function emits only the post check and its scaffolding; no pre assertion.
- [ ] `keepContracts: 'invariant'`: class with `@invariant` and a method with `@pre` emits `#checkInvariants()` but not the pre assertion.
- [ ] `keepContracts: 'all'` on a function with no contract tags: output identical to the bare function.
- [ ] When all kinds are filtered out: `require('fs-axiom/contracts')` import is **absent**.
- [ ] When at least one check is emitted: `require('fs-axiom/contracts')` import is **present**.
- [ ] (Step 4 only) `// @axiom keepContracts` on line 1 with global `false` → both checks emitted.
- [ ] (Step 4 only) `// @axiom keepContracts pre` on line 1 → only pre check emitted.
- [ ] (Step 4 only) Same directive on line 2+ → ignored, global option applies.
- [ ] `npm run lint` clean.
- [ ] `npm run typecheck` clean.
- [ ] `npm run test:coverage` passes all thresholds.
- [ ] `npm run knip` reports no new unused exports.
