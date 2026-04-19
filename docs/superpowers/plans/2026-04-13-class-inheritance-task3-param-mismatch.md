# Class Inheritance — Task 3: Parameter mismatch handling for base class contracts

State: Completed

> **Sequence:** This is step 3 of 8. Task 2 must be complete before starting this task.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

We are propagating `@pre`, `@post`, and `@invariant` contracts from a base class to its direct
subclasses via the `extends` clause.

**What previous tasks added (already in the codebase):**

- Task 1: `BaseClassContracts` type, `findClassByPos` helper, stub `resolveBaseClassContracts`.
- Task 2: Full `resolveBaseClassContracts` implementation with `findBaseClassMethodParams`,
  `extractBaseMethodContracts`, and `processBaseClassDeclaration`.

**What this task does:**

- Adds targeted tests verifying the parameter-mismatch behaviour (rename mode, ignore mode, and
  count-mismatch) that `extractBaseMethodContracts` already delegates to `handleParamMismatch`.
- No source code changes expected — all tests should pass with the implementation from Task 2.

**Files changed in this task:**

- `test/interface-resolver.test.ts`

---

## ESLint constraints (read before touching any `src/` file)

- `id-length: min 3` — no identifiers shorter than 3 characters.
- No bare `return;` — restructure with guards.
- `complexity: 10` — extract helpers when functions grow.
- `max-len: 100` — lines under 100 chars.
- No `console` — use the injectable `warn` callback.

---

## Steps

- [ ] **Step 1: Write failing tests for parameter mismatch**

Add to the `resolveBaseClassContracts` describe block in `test/interface-resolver.test.ts`:

```typescript
it('renames expressions when subclass uses different param names (rename mode)', () => {
  const source = `
    class Animal {
      /** @pre amount > 0 */
      feed(amount: number): void {}
    }
    class Dog extends Animal {
      feed(qty: number): void {}
    }
  `;
  const warnings: string[] = [];
  const output = transformWithProgram(source, (msg) => warnings.push(msg));
  expect(output).toContain('qty > 0');
  expect(output).not.toContain('amount > 0');
  expect(warnings.some((w) => w.includes('mismatch') && w.includes('Dog.feed'))).toBe(true);
});

it('skips base class contracts when param names differ (ignore mode)', () => {
  const source = `
    class Animal {
      /** @pre amount > 0 */
      feed(amount: number): void {}
    }
    class Dog extends Animal {
      feed(qty: number): void {}
    }
  `;
  const warnings: string[] = [];
  const output = transformWithProgram(source, (msg) => warnings.push(msg), 'ignore');
  expect(output).not.toContain('qty > 0');
  expect(output).not.toContain('amount > 0');
  expect(warnings.some((w) => w.includes('skipped') && w.includes('Dog.feed'))).toBe(true);
});

it('skips all base class contracts for a method when param counts differ', () => {
  const source = `
    class Animal {
      /** @pre amount > 0 */
      feed(amount: number, unit: string): void {}
    }
    class Dog extends Animal {
      feed(amount: number): void {}
    }
  `;
  const warnings: string[] = [];
  const output = transformWithProgram(source, (msg) => warnings.push(msg));
  expect(output).not.toContain('amount > 0');
  expect(
    warnings.some((w) => w.includes('count mismatch') && w.includes('Dog.feed')),
  ).toBe(true);
});
```

- [ ] **Step 2: Run tests**

```bash
npx jest --testPathPattern="interface-resolver" -t "resolveBaseClassContracts" --no-coverage
```

Expected: all pass (implementation is already in place from Task 2).

- [ ] **Step 3: Run full suite**

```bash
npm test
```

Expected: all tests pass.

---

## Done when

- `npm test` exits 0 with no regressions.
- All three parameter-mismatch test cases pass.
- Rename mode: guard uses `qty > 0`, not `amount > 0`, and a rename warning is emitted.
- Ignore mode: no guard is injected and a "skipped" warning is emitted.
- Count mismatch: base contracts are skipped and a count-mismatch warning is emitted.
