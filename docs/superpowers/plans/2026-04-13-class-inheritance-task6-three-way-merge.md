# Class Inheritance — Task 6: Three-way merge warning and merge ordering

State: not started

> **Sequence:** This is step 6 of 8. Task 5 must be complete before starting this task.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

We are propagating `@pre`, `@post`, and `@invariant` contracts from a base class to its direct
subclasses via the `extends` clause.

**What previous tasks added (already in the codebase):**

- Task 1–2: `resolveBaseClassContracts` in `src/interface-resolver.ts`.
- Task 4–5: Wiring in `src/class-rewriter.ts`, `mergeContractSets`, and invariant inheritance.

**What this task does:**

- Verifies that when interface contracts, base class contracts, and subclass own contracts all
  define `@pre` tags for the same method, all three sets are applied in the correct order
  (interface → base → subclass) and a merge warning is emitted listing all three sources.
- No source code changes expected — all tests should pass with the implementation from prior tasks.
  If any fail, inspect `emitMethodMergeWarnings` — it may need updating to reference the combined
  `sourceInterface` field.

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

- [ ] **Step 1: Write failing tests**

Add to `test/transformer.test.ts`:

```typescript
describe('three-way contract merge (interface + base + subclass)', () => {
  it('emits merge warning listing all three sources', () => {
    const source = `
      interface IAnimal {
        /** @pre amount !== 0 */
        feed(amount: number): void;
      }
      class Animal implements IAnimal {
        /** @pre amount > 0 */
        feed(amount: number): void {}
      }
      export class Dog extends Animal implements IAnimal {
        /** @pre amount < 1000 */
        feed(amount: number): void {}
      }
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(
      warnings.some(
        (w) =>
          w.includes('IAnimal') &&
          w.includes('Animal') &&
          w.includes('Dog') &&
          w.includes('@pre'),
      ),
    ).toBe(true);
  });

  it('applies all three @pre guards in order (interface → base → subclass)', () => {
    const source = `
      interface IAnimal {
        /** @pre amount !== 0 */
        feed(amount: number): void;
      }
      class Animal implements IAnimal {
        /** @pre amount > -100 */
        feed(amount: number): void {}
      }
      export class Dog extends Animal implements IAnimal {
        energy = 0;
        /** @pre amount < 1000 */
        feed(amount: number): void { this.energy += amount; }
      }
    `;
    const { Dog } = evalTransformed(transformWithProgram(source, () => {}));
    const dog = new Dog();
    expect(() => dog.feed(0)).toThrow();      // violates interface pre
    expect(() => dog.feed(-200)).toThrow();   // violates base pre
    expect(() => dog.feed(2000)).toThrow();   // violates subclass pre
    expect(() => dog.feed(5)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npx jest --testPathPattern="transformer" -t "three-way contract merge" --no-coverage
```

Expected: both pass. If either fails, inspect `emitMethodMergeWarnings` in `src/class-rewriter.ts`
and update it to reference the merged `sourceInterface` field from the combined contract set.

- [ ] **Step 3: Run full suite**

```bash
npm test
```

Expected: all tests pass.

---

## Done when

- `npm test` exits 0 with no regressions.
- Merge warning names all three sources (`IAnimal`, `Animal`, `Dog`).
- All three `@pre` guards fire in order: interface → base → subclass.
- `dog.feed(5)` succeeds (satisfies all three guards).
