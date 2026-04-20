# Class Inheritance — Task 7: `transpileModule` mode warning covers `extends` clause

State: completed

> **Sequence:** This is step 7 of 8. Task 4 must be complete before starting this task.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

We are propagating `@pre`, `@post`, and `@invariant` contracts from a base class to its direct
subclasses via the `extends` clause.

**What previous tasks added (already in the codebase):**

- Task 4: `hasResolvableHeritageClauses` now covers both `implements` and `extends` clauses,
  which means the `transpileModule` warning already fires for classes with `extends`.

**What this task does:**

- Adds explicit tests to verify that the `transpileModule` warning fires when a class has an
  `extends` clause and no TypeChecker is available.
- Verifies that the class's own contracts (on methods not inherited) still fire in `transpileModule`
  mode.
- No source code changes expected.

**Files changed in this task:**

- `test/transformer.test.ts`

---

## ESLint constraints (read before touching any `src/` file)

- `id-length: min 3` — no identifiers shorter than 3 characters.
- No bare `return;` — restructure with guards.
- `complexity: 10` — extract helpers when functions grow.
- `max-len: 100` — lines under 100 chars.
- No `console` — use the injectable `warn` callback.

---

## Steps

- [ ] **Step 1: Write failing test**

Add to `test/transformer.test.ts`:

```typescript
describe('transpileModule mode with extends clause', () => {
  it('emits warning when class has extends clause and no TypeChecker', () => {
    const source = `
      class Animal {
        /** @pre amount > 0 */
        feed(amount: number): void {}
      }
      export class Dog extends Animal {
        feed(amount: number): void {}
      }
    `;
    const warnings: string[] = [];
    transform(source, (msg) => warnings.push(msg));
    expect(
      warnings.some(
        (w) =>
          w.includes('transpileModule') &&
          w.includes('class-level contracts unaffected'),
      ),
    ).toBe(true);
  });

  it('class-own contracts still fire in transpileModule mode', () => {
    const source = `
      class Animal {}
      export class Dog extends Animal {
        energy = 0;
        /** @pre amount > 0 */
        feed(amount: number): void { this.energy += amount; }
      }
    `;
    const js = transform(source, () => {});
    const DogClass = evalTransformedWith(js, 'Dog') as new () => { feed: (n: number) => void };
    const dog = new DogClass();
    expect(() => dog.feed(-1)).toThrow();
    expect(() => dog.feed(5)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npx jest --testPathPattern="transformer" -t "transpileModule mode with extends clause" --no-coverage
```

Expected: both pass (warning guard was already updated in Task 4).

- [ ] **Step 3: Run full suite**

```bash
npm test
```

Expected: all tests pass.

---

## Done when

- `npm test` exits 0 with no regressions.
- `transpileModule` warning fires when a class has `extends` and no TypeChecker.
- Class-own `@pre` contracts still execute correctly in `transpileModule` mode.
