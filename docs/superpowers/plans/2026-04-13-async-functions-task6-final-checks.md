# Async Functions — Task 6: Final checks — regression, coverage, lint, typecheck

> **Sequence:** This is step 6 of 6. Tasks 1–5 must be complete before starting this task.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

We are fixing `@post` contracts on `async` functions and async class methods so that the
post-condition check operates on the **resolved** value of the promise, not the `Promise` object
itself.

**What previous tasks added (already in the codebase):**

- Task 1: `isAsyncFunction` helper + `buildBodyCapture` `isAsync` parameter + threading.
- Task 2: `resolvePromiseTypeArg` + updated `returnTypeDescription`.
- Task 3: `unwrapPromiseType` + updated `buildPostParamTypes`.
- Task 4: Test coverage for async class methods and invariants.
- Task 5: Test coverage for `@prev` ordering semantics with async methods.

**What this task does:**

- Confirms the synchronous path through `buildBodyCapture` (`isAsync = false`) is bit-for-bit
  identical to the pre-change behaviour — no `await`, no `async` modifier on the IIFE arrow.
- Runs coverage, lint, and typecheck to satisfy the project-wide quality gates.
- No source files or test files change.

---

## Steps

- [ ] **Step 1: Run the full suite**

```
npm test
```

Expected: all previously passing tests still pass. The synchronous IIFE emitted by
`buildBodyCapture` when `isAsync = false` must have no `await` and no `async` modifier on the
arrow.

- [ ] **Step 2: Run coverage**

```
npm run test:coverage
```

Expected: coverage thresholds met (≥ 80% across all thresholds).

- [ ] **Step 3: Lint check**

```
npm run lint
```

Expected: no errors.

- [ ] **Step 4: Type check**

```
npm run typecheck
```

Expected: no errors.

---

## Done when

- `npm test` exits 0.
- `npm run test:coverage` exits 0 with all thresholds ≥ 80%.
- `npm run lint` exits 0 with no errors.
- `npm run typecheck` exits 0 with no errors.
- No source files or test files were modified in this task.
