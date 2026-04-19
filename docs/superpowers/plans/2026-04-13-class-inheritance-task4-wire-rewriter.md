# Class Inheritance — Task 4: Wire `resolveBaseClassContracts` into `class-rewriter.ts`

State: not started

> **Sequence:** This is step 4 of 8. Task 2 must be complete before starting this task.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

We are propagating `@pre`, `@post`, and `@invariant` contracts from a base class to its direct
subclasses via the `extends` clause.

**What previous tasks added (already in the codebase):**

- Task 1: `BaseClassContracts` type, `findClassByPos` helper, stub `resolveBaseClassContracts`.
- Task 2: Full `resolveBaseClassContracts` implementation.
- Task 3: Parameter mismatch test coverage.

**What this task does:**

- Imports `resolveBaseClassContracts` and `BaseClassContracts` in `src/class-rewriter.ts`.
- Adds the `mergeContractSets` helper in `src/class-rewriter.ts`.
- Renames `hasImplementsClauses` to `hasResolvableHeritageClauses` and widens it to also cover
  `ExtendsKeyword` (so the `transpileModule` warning fires for classes with `extends`).
- Calls `resolveBaseClassContracts` and merges the result with the interface contracts in
  `rewriteClass`.

**Files changed in this task:**

- `src/class-rewriter.ts`
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

- [ ] **Step 1: Write failing integration tests**

Add to `test/transformer.test.ts`:

```typescript
describe('base class contract inheritance', () => {
  it('Dog.feed inherits @pre from Animal.feed', () => {
    const source = `
      class Animal {
        /** @pre amount > 0 */
        feed(amount: number): void {}
      }
      export class Dog extends Animal {
        energy = 0;
        feed(amount: number): void { this.energy += amount; }
      }
    `;
    const { Dog } = evalTransformed(transformWithProgram(source, () => {}));
    const dog = new Dog();
    expect(() => dog.feed(-1)).toThrow();
    expect(() => dog.feed(5)).not.toThrow();
  });

  it('Dog.feed inherits @post from Animal.feed', () => {
    const source = `
      class Animal {
        energy = 0;
        /**
         * @post this.energy > 0
         */
        feed(amount: number): void { this.energy += amount; }
      }
      export class Dog extends Animal {
        energy = 0;
        feed(amount: number): void { this.energy = -1; }
      }
    `;
    const { Dog } = evalTransformed(transformWithProgram(source, () => {}));
    const dog = new Dog();
    expect(() => dog.feed(5)).toThrow();
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

```bash
npx jest --testPathPattern="transformer" -t "base class contract inheritance" --no-coverage
```

Expected: FAILs — `resolveBaseClassContracts` is not yet called in `class-rewriter.ts`.

- [ ] **Step 3: Import `resolveBaseClassContracts` and `BaseClassContracts` in `src/class-rewriter.ts`**

Update the import from `./interface-resolver`:

```typescript
import {
  resolveInterfaceContracts,
  resolveBaseClassContracts,
  type InterfaceContracts,
  type InterfaceMethodContracts,
  type BaseClassContracts,
  type ParamMismatchMode,
} from './interface-resolver';
```

- [ ] **Step 4: Add `mergeContractSets` helper in `src/class-rewriter.ts`**

Add after the `hasImplementsClauses` function:

```typescript
function mergeContractSets(
  primary: InterfaceContracts,
  secondary: BaseClassContracts,
): InterfaceContracts {
  const merged: InterfaceContracts = {
    methods: new Map(primary.methods),
    invariants: [...primary.invariants, ...secondary.invariants],
  };
  secondary.methods.forEach((contracts, methodName) => {
    const existing = merged.methods.get(methodName);
    if (existing === undefined) {
      merged.methods.set(methodName, contracts);
    } else {
      merged.methods.set(methodName, {
        preTags: [...existing.preTags, ...contracts.preTags],
        postTags: [...existing.postTags, ...contracts.postTags],
        sourceInterface: existing.sourceInterface,
        prevExpression: existing.prevExpression ?? contracts.prevExpression,
      });
    }
  });
  return merged;
}
```

- [ ] **Step 5: Rename `hasImplementsClauses` to `hasResolvableHeritageClauses` and widen it**

Replace:

```typescript
function hasImplementsClauses(node: typescript.ClassDeclaration): boolean {
  return node.heritageClauses !== undefined && node.heritageClauses.some(
    (clause) => clause.token === typescript.SyntaxKind.ImplementsKeyword,
  );
}
```

With:

```typescript
function hasResolvableHeritageClauses(node: typescript.ClassDeclaration): boolean {
  if (node.heritageClauses === undefined) {
    return false;
  }
  return node.heritageClauses.some(
    (clause) =>
      clause.token === typescript.SyntaxKind.ImplementsKeyword ||
      clause.token === typescript.SyntaxKind.ExtendsKeyword,
  );
}
```

Update the call site in `rewriteClass` from `hasImplementsClauses(node)` to
`hasResolvableHeritageClauses(node)`.

- [ ] **Step 6: Call `resolveBaseClassContracts` and merge in `rewriteClass`**

In `rewriteClass`, replace:

```typescript
  const interfaceContracts: InterfaceContracts = checker !== undefined
    ? resolveInterfaceContracts(node, checker, cache, warn, mode)
    : { methods: new Map(), invariants: [] };
```

With:

```typescript
  const ifaceOnly: InterfaceContracts = checker !== undefined
    ? resolveInterfaceContracts(node, checker, cache, warn, mode)
    : { methods: new Map(), invariants: [] };
  const baseContracts: BaseClassContracts = checker !== undefined
    ? resolveBaseClassContracts(node, checker, cache, warn, mode)
    : { methods: new Map(), invariants: [] };
  const interfaceContracts = mergeContractSets(ifaceOnly, baseContracts);
```

- [ ] **Step 7: Run failing tests to confirm they now pass**

```bash
npx jest --testPathPattern="transformer" -t "base class contract inheritance" --no-coverage
```

Expected: all pass.

- [ ] **Step 8: Run full suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 9: Run lint and typecheck**

```bash
npm run lint && npm run typecheck
```

Expected: no errors.

---

## Done when

- `npm test` exits 0 with no regressions.
- `npm run lint && npm run typecheck` exit 0.
- `Dog.feed` inherits `@pre` and `@post` from `Animal.feed` at runtime.
- `hasResolvableHeritageClauses` covers both `implements` and `extends` clauses.
- `mergeContractSets` is present and merges interface and base class contracts.
