# Class Inheritance — Task 8: Acceptance tests — runtime contract enforcement

State: completed

> **Sequence:** This is step 8 of 8. Tasks 4, 5, 6, and 7 must be complete before starting this task.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

We are propagating `@pre`, `@post`, and `@invariant` contracts from a base class to its direct
subclasses via the `extends` clause.

**What previous tasks added (already in the codebase):**

- Task 1–2: `resolveBaseClassContracts` in `src/interface-resolver.ts`.
- Task 3: Parameter mismatch test coverage.
- Task 4: `mergeContractSets`, `hasResolvableHeritageClauses`, wiring in `src/class-rewriter.ts`.
- Task 5: Invariant inheritance and updated `resolveEffectiveInvariants`.
- Task 6: Three-way merge tests.
- Task 7: `transpileModule` warning tests for `extends` clause.

**What this task does:**

- Adds a full end-to-end acceptance test suite in `test/acceptance.test.ts` covering all contract
  inheritance scenarios at runtime.
- Runs the complete suite with coverage and lint to confirm the feature is production-ready.

**Files changed in this task:**

- `test/acceptance.test.ts`

---

## ESLint constraints (read before touching any `src/` file)

- `id-length: min 3` — no identifiers shorter than 3 characters.
- No bare `return;` — restructure with guards.
- `complexity: 10` — extract helpers when functions grow.
- `max-len: 100` — lines under 100 chars.
- No `console` — use the injectable `warn` callback.

---

## Steps

- [ ] **Step 1: Add acceptance test describe block skeleton**

Add to `test/acceptance.test.ts`:

```typescript
describe('class inheritance contracts', () => {
  it('Dog.feed throws ContractViolationError when @pre from Animal is violated', () => {
    // Basic inheritance: @pre amount > 0 on Animal.feed fires for Dog.feed
  });

  it('Dog.feed throws ContractViolationError when @post from Animal is violated', () => {
    // Post-condition: @post this.energy > 0 fires after Dog.feed runs
  });

  it('Dog inherits @invariant from Animal — InvariantViolationError thrown', () => {
    // Invariant: @invariant this.energy >= 0 fires after Dog.feed corrupts state
  });

  it('additive merge: both Animal.feed and Dog.feed @pre guards fire', () => {
    // Base guard: amount > 0 (Animal); subclass guard: amount < 1000 (Dog)
    // amount = -1 violates Animal; amount = 2000 violates Dog; amount = 5 succeeds
  });

  it('cross-file base class: contracts resolved from separate .ts file', () => {
    // Base class defined in a separate virtual source file — contracts still applied
  });

  it('no double-injection: subclass not overriding a method is not affected', () => {
    // Dog does not override run(); Animal.run() @pre fires on Animal instance only
  });

  it('parameter rename: base uses "amount", subclass uses "qty" — guard uses "qty"', () => {
    // Rename mode: Dog.feed(qty) inherits @pre qty > 0 (renamed from amount)
  });
});
```

- [ ] **Step 2: Implement each test body**

Fill in each test body using the project's existing acceptance test patterns
(`transformAndEval`, `ContractViolationError`, `InvariantViolationError`).

- [ ] **Step 3: Run acceptance tests**

```bash
npx jest --testPathPattern="acceptance" --no-coverage
```

Expected: all pass.

- [ ] **Step 4: Run full suite with coverage**

```bash
npm run test:coverage
```

Expected: all tests pass, coverage thresholds met (≥ 80%).

- [ ] **Step 5: Run lint**

```bash
npm run lint
```

Expected: no errors.

---

## Done when

- `npm run test:coverage` exits 0 with all thresholds met.
- `npm run lint` exits 0 with no errors.
- All seven acceptance tests pass.
- The following scenarios are verified at runtime:
  - Basic `@pre` inheritance (`Dog.feed` throws for `animal.feed(-1)`).
  - `@post` inheritance (`Dog.feed` throws when post-condition is violated).
  - `@invariant` inheritance (`InvariantViolationError` thrown after state corruption).
  - Additive merge: both base and subclass `@pre` guards fire.
  - Cross-file base class: contracts resolved from a separate virtual source file.
  - No double-injection for non-overridden methods.
  - Parameter rename: guard uses subclass param names.
