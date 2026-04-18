# Closures — Task 9: Final coverage, lint, typecheck, and build

> **Sequence:** This is step 9 of 9. Requires all prior tasks to be complete.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

All implementation and verification tasks are complete. This task runs the full quality gate —
coverage thresholds, lint, typecheck, and build — and fixes any issues found before the feature
branch is considered ready for review.

**What this task does:**

- Runs `npm run test:coverage` and confirms the 80% threshold is met.
- Runs `npm run lint` and fixes any `id-length`, `complexity`, or `max-len` violations introduced
  by the new helpers.
- Runs `npm run typecheck` and fixes any type errors.
- Runs `npm run build` and confirms a clean compile to `dist/`.

**Files changed in this task:**

- Any `src/` files that need lint or type fixes (no new features introduced here).

---

## ESLint constraints (read before touching any `src/` file)

- `id-length: min 3` — no identifiers shorter than 3 characters.
- `complexity: 10` — keep functions small; extract helpers.
- `max-len: 100` — lines under 100 chars.
- No `console` — use the injectable `warn` callback.

---

## Steps

- [ ] **Step 1: Run coverage**

```
npm run test:coverage
```

Expected: all thresholds pass (80%). If any threshold fails, add tests to cover the new helpers or
branches that are not yet exercised.

- [ ] **Step 2: Run lint**

```
npm run lint
```

Expected: no errors. Common violations to fix:
- `id-length` — rename any short variable names (`w`, `s`, etc.) to three characters or more.
- `complexity` — split large functions into smaller helpers.
- `max-len` — break long lines.

- [ ] **Step 3: Run typecheck**

```
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Run build**

```
npm run build
```

Expected: clean compile to `dist/` with no errors.

- [ ] **Step 5: Commit any fixes**

If lint or type fixes were needed, stage and commit the changes:

```
git add src/
git commit -m "chore: lint and type fixes for closure contract injection"
```

---

## Done when

- `npm run test:coverage` passes all thresholds.
- `npm run lint` exits 0.
- `npm run typecheck` exits 0.
- `npm run build` exits 0.
- `dist/` contains a fresh compile with the new closure injection feature included.
