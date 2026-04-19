# Class Inheritance — Task 1: `BaseClassContracts` type and `resolveBaseClassContracts` stub

State: not started

> **Sequence:** This is step 1 of 8. No prior tasks required.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

We are propagating `@pre`, `@post`, and `@invariant` contracts from a base class to its direct
subclasses via the `extends` clause, using the same additive-merge and parameter-rename logic
already applied to interface contracts.

**What this task does:**

- Adds the `BaseClassContracts` exported interface to `src/interface-resolver.ts` (structurally
  identical to `InterfaceContracts`).
- Adds the file-private `findClassByPos` helper (mirrors `findInterfaceByPos`).
- Adds a stub `resolveBaseClassContracts` export that returns an empty result — enough to make
  tests import and call it without errors.

**Files changed in this task:**

- `src/interface-resolver.ts`
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

- [ ] **Step 1: Confirm green baseline**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Write failing unit tests for `resolveBaseClassContracts` — empty cases**

Add to `test/interface-resolver.test.ts`:

```typescript
import { resolveBaseClassContracts } from '../src/interface-resolver';
// (add to existing imports)

describe('resolveBaseClassContracts', () => {
  it('returns empty result when class has no extends clause', () => {
    const source = `
      class Animal {
        /** @pre amount > 0 */
        feed(amount: number): void {}
      }
    `;
    const result = transformWithProgram(source, () => {}, (classNode, checker, cache) =>
      resolveBaseClassContracts(classNode, checker, cache, () => {}, 'rename'),
    );
    expect(result.methods.size).toBe(0);
    expect(result.invariants).toHaveLength(0);
  });

  it('returns empty result when base class has no contracts', () => {
    const source = `
      class Animal {
        feed(amount: number): void {}
      }
      class Dog extends Animal {
        feed(amount: number): void {}
      }
    `;
    // Dog.feed should get no inherited contracts
    // assert via transformWithProgram: no @pre guard injected for Dog.feed
    const warnings: string[] = [];
    const output = transformWithProgram(source, (msg) => warnings.push(msg));
    expect(output).not.toContain('ContractViolationError');
    expect(warnings).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run to confirm they fail**

```bash
npx jest --testPathPattern="interface-resolver" -t "resolveBaseClassContracts" --no-coverage
```

Expected: FAIL — `resolveBaseClassContracts` is not exported.

- [ ] **Step 4: Add `BaseClassContracts` type and `findClassByPos` to `src/interface-resolver.ts`**

After the `InterfaceContracts` interface declaration, add:

```typescript
export interface BaseClassContracts {
  methods: Map<string, InterfaceMethodContracts>;
  invariants: string[];
}
```

After `findInterfaceByPos`, add:

```typescript
function findClassByPos(
  sourceFile: typescript.SourceFile,
  pos: number,
): typescript.ClassDeclaration | undefined {
  let found: typescript.ClassDeclaration | undefined;
  function visit(node: typescript.Node): void {
    if (found === undefined && typescript.isClassDeclaration(node)) {
      if (node.pos === pos) {
        found = node;
      }
    }
    if (found === undefined) {
      typescript.forEachChild(node, visit);
    }
  }
  visit(sourceFile);
  return found;
}
```

- [ ] **Step 5: Add stub `resolveBaseClassContracts` export to `src/interface-resolver.ts`**

```typescript
export function resolveBaseClassContracts(
  classNode: typescript.ClassDeclaration,
  checker: typescript.TypeChecker,
  cache: Map<string, typescript.SourceFile>,
  warn: (msg: string) => void,
  mode: ParamMismatchMode,
): BaseClassContracts {
  const result: BaseClassContracts = {
    methods: new Map(),
    invariants: [],
  };
  void classNode; void checker; void cache; void warn; void mode;
  return result;
}
```

- [ ] **Step 6: Run tests**

```bash
npm test
```

Expected: all existing tests pass; new empty-case tests pass.

- [ ] **Step 7: Run lint and typecheck**

```bash
npm run lint && npm run typecheck
```

Expected: no errors.

---

## Done when

- `npm test` exits 0 with no regressions.
- `npm run lint && npm run typecheck` exit 0.
- `BaseClassContracts` is exported from `src/interface-resolver.ts`.
- `resolveBaseClassContracts` is exported and returns an empty result for any input.
- Both empty-case tests pass.
