# Class Inheritance — Task 5: Invariant inheritance and updated `resolveEffectiveInvariants`

State: completed

> **Sequence:** This is step 5 of 8. Task 4 must be complete before starting this task.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

We are propagating `@pre`, `@post`, and `@invariant` contracts from a base class to its direct
subclasses via the `extends` clause.

**What previous tasks added (already in the codebase):**

- Task 1–2: `resolveBaseClassContracts` in `src/interface-resolver.ts`.
- Task 4: `mergeContractSets`, `hasResolvableHeritageClauses`, and wiring in `src/class-rewriter.ts`.

**What this task does:**

- Extends `resolveEffectiveInvariants` in `src/class-rewriter.ts` to accept a
  `baseClassInvariants` parameter.
- Updates the merge warning to name all contributing sources (interface, base class, subclass
  class name) rather than the generic "interface and class" wording.
- Threads `baseContracts.invariants` separately into `resolveEffectiveInvariants` (instead of
  relying solely on the merged `interfaceContracts.invariants`) so the warning can name the base
  class.
- Updates `mergeContractSets` to stop merging invariants (they are now threaded separately).

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

- [ ] **Step 1: Write failing tests**

Add to `test/transformer.test.ts`:

```typescript
describe('base class invariant inheritance', () => {
  it('subclass inherits @invariant from base class', () => {
    const source = `
      /** @invariant this.energy >= 0 */
      class Animal {
        energy = 0;
        feed(amount: number): void { this.energy += amount; }
      }
      export class Dog extends Animal {
        energy = 0;
        feed(amount: number): void { this.energy = -99; }
      }
    `;
    const js = transformWithProgram(source, () => {});
    const DogClass = evalTransformedWith(js, 'Dog') as new () => { feed: (n: number) => void };
    const dog = new DogClass();
    expect(() => dog.feed(5)).toThrow();
  });

  it('emits named merge warning when base and subclass both define @invariant', () => {
    const source = `
      /** @invariant this.energy >= 0 */
      class Animal {
        energy = 0;
        feed(amount: number): void {}
      }
      /** @invariant this.energy < 1000 */
      export class Dog extends Animal {
        energy = 0;
        feed(amount: number): void {}
      }
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(
      warnings.some(
        (w) => w.includes('Animal') && w.includes('Dog') && w.includes('invariant'),
      ),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

```bash
npx jest --testPathPattern="transformer" -t "base class invariant inheritance" --no-coverage
```

Expected: invariant test FAILs (invariants not yet flowing through); warning test may PASS or FAIL
depending on current warning wording.

- [ ] **Step 3: Update `resolveEffectiveInvariants` signature in `src/class-rewriter.ts`**

Replace:

```typescript
function resolveEffectiveInvariants(
  node: typescript.ClassDeclaration,
  reparsedClass: typescript.ClassDeclaration | typescript.Node,
  className: string,
  warn: (msg: string) => void,
  interfaceInvariants: string[],
): string[] {
  const classRaw = extractInvariantExpressions(reparsedClass);

  if (interfaceInvariants.length > 0 && classRaw.length > 0) {
    warn(
      `[axiom] Contract merge warning in ${className}:`
      + '\n  both interface and class define @invariant tags'
      + ' — additive merge applied',
    );
  }

  const allRaw = [...interfaceInvariants, ...classRaw];
```

With:

```typescript
function resolveEffectiveInvariants(
  node: typescript.ClassDeclaration,
  reparsedClass: typescript.ClassDeclaration | typescript.Node,
  className: string,
  warn: (msg: string) => void,
  interfaceInvariants: string[],
  baseClassInvariants: string[] = [],
): string[] {
  const classRaw = extractInvariantExpressions(reparsedClass);
  const sources: string[] = [];
  if (interfaceInvariants.length > 0) {
    sources.push('interface');
  }
  if (baseClassInvariants.length > 0) {
    sources.push('base class');
  }
  if (classRaw.length > 0) {
    sources.push(className);
  }
  if (sources.length > 1) {
    warn(
      `[axiom] Contract merge warning in ${className}:`
      + `\n  ${sources.join(', ')} all define @invariant tags`
      + ' — additive merge applied',
    );
  }

  const allRaw = [...interfaceInvariants, ...baseClassInvariants, ...classRaw];
```

- [ ] **Step 4: Thread `baseContracts.invariants` into `resolveEffectiveInvariants` in `rewriteClass`**

Update the call to `resolveEffectiveInvariants` in `rewriteClass`:

```typescript
  const effectiveInvariants = resolveEffectiveInvariants(
    node, reparsedClass, className, warn,
    ifaceOnly.invariants, baseContracts.invariants,
  );
```

- [ ] **Step 5: Update `mergeContractSets` to stop merging invariants**

```typescript
function mergeContractSets(
  primary: InterfaceContracts,
  secondary: BaseClassContracts,
): InterfaceContracts {
  const merged: InterfaceContracts = {
    methods: new Map(primary.methods),
    invariants: primary.invariants,   // invariants merged separately in resolveEffectiveInvariants
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

- [ ] **Step 6: Run tests**

```bash
npx jest --testPathPattern="transformer" -t "base class invariant inheritance" --no-coverage
```

Expected: both pass.

- [ ] **Step 7: Run full suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 8: Run lint and typecheck**

```bash
npm run lint && npm run typecheck
```

Expected: no errors.

---

## Done when

- `npm test` exits 0 with no regressions.
- `npm run lint && npm run typecheck` exit 0.
- Subclass inherits `@invariant` from base class and violation is detected at runtime.
- Merge warning names both the base class and the subclass when both define `@invariant`.
