# Class-to-Class Contract Inheritance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Propagate `@pre`, `@post`, and `@invariant` contracts from a base class to its direct subclasses via the `extends` clause, using the same additive-merge and parameter-rename logic already applied to interface contracts.

**Architecture:** A new `resolveBaseClassContracts` function is added to `src/interface-resolver.ts`. It walks the `ExtendsKeyword` heritage clause, resolves the base class declaration via TypeChecker, re-parses its source file (using the existing `reparseCached` cache), and returns a `BaseClassContracts` value — structurally identical to `InterfaceContracts`. In `src/class-rewriter.ts`, a new `mergeContractSets` helper combines the interface contracts and base class contracts into a single merged set before they are passed to `rewriteMembers`. `resolveEffectiveInvariants` gains a `baseClassInvariants` parameter. The existing `hasImplementsClauses` guard is widened to also cover `ExtendsKeyword` clauses for the transpileModule warning.

**Tech Stack:** TypeScript compiler API (`typescript.TypeChecker`, heritage clause traversal, `typescript.isClassDeclaration`), Jest, ESLint constraints enforced throughout.

---

## ESLint Constraints (read before touching any `src/` file)

- **`id-length: min 3`** — No identifiers shorter than 3 characters.
- **No bare `return;`** — restructure with guards.
- **`complexity: 10`** — extract helpers when functions grow.
- **`max-len: 100`** — lines under 100 chars.
- **No `console`** — use the injectable `warn` callback.

---

## File Map

| File | Change | Responsibility |
| :--- | :--- | :--- |
| `src/interface-resolver.ts` | **Modify** | Add `BaseClassContracts` type, `resolveBaseClassContracts`, `findClassByPos`, `findBaseClassMethodParams`, `extractBaseMethodContracts`, `processBaseClassDeclaration` |
| `src/class-rewriter.ts` | **Modify** | Add `mergeContractSets`; call `resolveBaseClassContracts`; extend `resolveEffectiveInvariants` for base invariants; widen transpileModule guard to cover `ExtendsKeyword` |
| `test/interface-resolver.test.ts` | **Modify** | Unit tests for `resolveBaseClassContracts` (empty cases, contract extraction, param mismatch, invariants) |
| `test/acceptance.test.ts` | **Modify** | Runtime integration tests for inherited pre/post/invariant contracts |
| `test/transformer.test.ts` | **Modify** | Tests for merge warnings, three-way merge, transpileModule warning with `extends` |

---

## Task 1: Add `BaseClassContracts` type and `findClassByPos` helper

**Files:**
- Modify: `src/interface-resolver.ts`
- Test: `test/interface-resolver.test.ts`

- [ ] **Step 1.1: Confirm green baseline**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 1.2: Write failing unit tests for `resolveBaseClassContracts` — empty cases**

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

- [ ] **Step 1.3: Run to confirm they fail**

```bash
npx jest --testPathPattern="interface-resolver" -t "resolveBaseClassContracts" --no-coverage
```

Expected: FAIL — `resolveBaseClassContracts` is not exported.

- [ ] **Step 1.4: Add `BaseClassContracts` type and `findClassByPos` to `src/interface-resolver.ts`**

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

- [ ] **Step 1.5: Add stub `resolveBaseClassContracts` export to `src/interface-resolver.ts`**

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

- [ ] **Step 1.6: Run tests**

```bash
npm test
```

Expected: all existing tests pass; new empty-case tests pass.

- [ ] **Step 1.7: Commit**

```bash
git add src/interface-resolver.ts test/interface-resolver.test.ts
git commit -m "feat: add BaseClassContracts type and resolveBaseClassContracts stub"
```

---

## Task 2: Implement `resolveBaseClassContracts` — method contract extraction

Add the internal helpers and full implementation of `resolveBaseClassContracts` in `src/interface-resolver.ts`, mirroring the existing interface-contract pipeline.

**Files:**
- Modify: `src/interface-resolver.ts`
- Test: `test/interface-resolver.test.ts`

- [ ] **Step 2.1: Write failing unit tests for contract extraction**

Add to the `resolveBaseClassContracts` describe block in `test/interface-resolver.test.ts`:

```typescript
it('returns @pre and @post from base class method when subclass overrides it', () => {
  const source = `
    class Animal {
      /**
       * @pre amount > 0
       * @post this.energy > 0
       */
      feed(amount: number): void {}
    }
    class Dog extends Animal {
      feed(amount: number): void {}
    }
  `;
  // Dog.feed should receive both tags
  const warnings: string[] = [];
  const output = transformWithProgram(source, (msg) => warnings.push(msg));
  expect(output).toContain('amount > 0');
  expect(output).toContain('this.energy > 0');
});

it('returns base class @invariant tags', () => {
  const source = `
    class Animal {
      energy = 0;
      /** @invariant this.energy >= 0 */
    }
    class Dog extends Animal {
      energy = 0;
    }
  `;
  const warnings: string[] = [];
  const output = transformWithProgram(source, (msg) => warnings.push(msg));
  expect(output).toContain('this.energy >= 0');
});
```

- [ ] **Step 2.2: Run to confirm they fail**

```bash
npx jest --testPathPattern="interface-resolver" -t "resolveBaseClassContracts" --no-coverage
```

Expected: FAILs — stub returns empty.

- [ ] **Step 2.3: Add `findBaseClassMethodParams` helper**

After `findClassByPos`, add:

```typescript
function findBaseClassMethodParams(
  classDecl: typescript.ClassDeclaration,
  methodName: string,
): string[] {
  const method = Array.from(classDecl.members).find(
    (member): member is typescript.MethodDeclaration =>
      typescript.isMethodDeclaration(member) &&
      typescript.isIdentifier(member.name) &&
      member.name.text === methodName,
  );
  if (method === undefined) {
    return [];
  }
  return Array.from(method.parameters).map((param) =>
    typescript.isIdentifier(param.name) ? param.name.text : '',
  );
}
```

- [ ] **Step 2.4: Add `extractBaseMethodContracts` helper**

This mirrors `extractMethodContracts` but operates on a `MethodDeclaration` in a `ClassDeclaration` instead of a `MethodSignature` in an `InterfaceDeclaration`.

After `findBaseClassMethodParams`, add:

```typescript
function extractBaseMethodContracts(
  baseClassNode: typescript.ClassDeclaration,
  methodName: string,
  subclassParams: string[],
  mode: ParamMismatchMode,
  baseName: string,
  location: string,
  warn: (msg: string) => void,
): InterfaceMethodContracts | undefined {
  const baseMethod = Array.from(baseClassNode.members).find(
    (member): member is typescript.MethodDeclaration =>
      typescript.isMethodDeclaration(member) &&
      typescript.isIdentifier(member.name) &&
      member.name.text === methodName,
  );
  if (baseMethod === undefined) {
    return undefined;
  }

  const baseParams = findBaseClassMethodParams(baseClassNode, methodName);
  if (baseParams.length !== subclassParams.length) {
    warn(
      `[axiom] Parameter count mismatch in ${location}:`
      + `\n  base class ${baseName} has ${baseParams.length} parameters,`
      + ` subclass has ${subclassParams.length} — base class contracts skipped`,
    );
    return { preTags: [], postTags: [], sourceInterface: baseName };
  }

  const { renameMap, shouldSkip } = handleParamMismatch(
    baseName, location, baseParams, subclassParams, mode, warn,
  );
  if (shouldSkip) {
    return { preTags: [], postTags: [], sourceInterface: baseName };
  }

  const hasMismatch = renameMap.size > 0;
  const allTags = extractContractTagsFromNode(baseMethod);
  const preTags = allTags.filter((tag) => tag.kind === KIND_PRE);
  const postTags = allTags.filter((tag) => tag.kind === KIND_POST);

  let prevExpr = extractPrevExpression(baseMethod);
  if (hasMismatch && mode === MODE_RENAME && prevExpr !== undefined) {
    prevExpr = renameIdentifiersInExpression(prevExpr, renameMap);
  }

  return buildContractsResult(
    preTags, postTags, prevExpr, renameMap, hasMismatch, mode, baseName,
  );
}
```

Note: `handleParamMismatch` currently formats its warning as `interface ${ifaceName}:` — for base class use the same helper but the warning text will say `interface Animal:`. This is acceptable for this iteration; a follow-up can refine the message format. If the wording must say `base class Animal`, extract a `handleParamMismatchWithSource` variant with a `sourceLabel` parameter in the same task.

- [ ] **Step 2.5: Add `processBaseClassDeclaration` helper**

After `extractBaseMethodContracts`, add:

```typescript
function processBaseClassDeclaration(
  decl: typescript.ClassDeclaration,
  classNode: typescript.ClassDeclaration,
  cache: Map<string, typescript.SourceFile>,
  warn: (msg: string) => void,
  mode: ParamMismatchMode,
  className: string,
  result: BaseClassContracts,
): void {
  const baseName = decl.name?.text ?? 'UnknownBase';
  const reparsed = reparseCached(decl.getSourceFile(), cache);
  const reparsedBase = findClassByPos(reparsed, decl.pos);
  if (reparsedBase === undefined) {
    return;
  }

  const baseInvariants = extractInvariantExpressions(reparsedBase);
  result.invariants.push(...baseInvariants);

  classNode.members.forEach((member) => {
    const isMethod = typescript.isMethodDeclaration(member);
    const hasIdentifierName = isMethod && typescript.isIdentifier(member.name);
    if (!isMethod || !hasIdentifierName) {
      return;
    }
    const methodName = member.name.text;
    const subclassParams = getClassMethodParams(member);
    const location = `${className}.${methodName}`;
    const methodContracts = extractBaseMethodContracts(
      reparsedBase, methodName, subclassParams, mode, baseName, location, warn,
    );
    if (methodContracts !== undefined) {
      result.methods.set(
        methodName,
        mergeMethodContracts(result.methods.get(methodName), methodContracts),
      );
    }
  });
}
```

- [ ] **Step 2.6: Replace the stub body of `resolveBaseClassContracts` with full implementation**

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
  const className = classNode.name?.text ?? 'UnknownClass';

  const heritageClauses = classNode.heritageClauses ?? [];
  heritageClauses.forEach((clause) => {
    if (clause.token === typescript.SyntaxKind.ExtendsKeyword) {
      clause.types.forEach((typeRef) => {
        const baseType = checker.getTypeAtLocation(typeRef.expression);
        const declarations = baseType.symbol?.declarations;
        if (declarations !== undefined) {
          declarations.forEach((decl) => {
            if (typescript.isClassDeclaration(decl)) {
              processBaseClassDeclaration(
                decl, classNode, cache, warn, mode, className, result,
              );
            }
          });
        }
      });
    }
  });

  return result;
}
```

- [ ] **Step 2.7: Run failing tests to confirm they now pass**

```bash
npx jest --testPathPattern="interface-resolver" -t "resolveBaseClassContracts" --no-coverage
```

Expected: all cases pass.

- [ ] **Step 2.8: Run full suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2.9: Commit**

```bash
git add src/interface-resolver.ts test/interface-resolver.test.ts
git commit -m "feat: implement resolveBaseClassContracts with method and invariant extraction"
```

---

## Task 3: Parameter mismatch handling for base class contracts

**Files:**
- Test: `test/interface-resolver.test.ts`

The `extractBaseMethodContracts` helper added in Task 2 already delegates to `handleParamMismatch` and `buildContractsResult`. This task verifies the correct end-to-end behaviour and adds targeted tests.

- [ ] **Step 3.1: Write failing tests for parameter mismatch**

Add to the `resolveBaseClassContracts` describe block:

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

- [ ] **Step 3.2: Run tests**

```bash
npx jest --testPathPattern="interface-resolver" -t "resolveBaseClassContracts" --no-coverage
```

Expected: all pass (implementation is already in place from Task 2).

- [ ] **Step 3.3: Run full suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3.4: Commit**

```bash
git add test/interface-resolver.test.ts
git commit -m "test: add param mismatch coverage for resolveBaseClassContracts"
```

---

## Task 4: Wire `resolveBaseClassContracts` into `class-rewriter.ts`

Calls `resolveBaseClassContracts`, merges the result with the interface contracts via a new `mergeContractSets` helper, and threads the merged set through `rewriteMembers` and `resolveEffectiveInvariants`.

**Files:**
- Modify: `src/class-rewriter.ts`
- Test: `test/transformer.test.ts`

- [ ] **Step 4.1: Write failing integration tests**

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

- [ ] **Step 4.2: Run to confirm they fail**

```bash
npx jest --testPathPattern="transformer" -t "base class contract inheritance" --no-coverage
```

Expected: FAILs — `resolveBaseClassContracts` is not yet called in `class-rewriter.ts`.

- [ ] **Step 4.3: Import `resolveBaseClassContracts` and `BaseClassContracts` in `src/class-rewriter.ts`**

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

- [ ] **Step 4.4: Add `mergeContractSets` helper in `src/class-rewriter.ts`**

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

- [ ] **Step 4.5: Update `hasImplementsClauses` to cover `ExtendsKeyword` and rename to `hasResolvableHeritageClauses`**

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

Update the call site in `rewriteClass` from `hasImplementsClauses(node)` to `hasResolvableHeritageClauses(node)`.

- [ ] **Step 4.6: Call `resolveBaseClassContracts` and merge in `rewriteClass`**

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

- [ ] **Step 4.7: Run failing tests to confirm they now pass**

```bash
npx jest --testPathPattern="transformer" -t "base class contract inheritance" --no-coverage
```

Expected: all pass.

- [ ] **Step 4.8: Run full suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4.9: Commit**

```bash
git add src/class-rewriter.ts test/transformer.test.ts
git commit -m "feat: wire resolveBaseClassContracts into class-rewriter with mergeContractSets"
```

---

## Task 5: Invariant inheritance and updated `resolveEffectiveInvariants`

Extend `resolveEffectiveInvariants` to accept base class invariants as a distinct parameter, producing a correctly named merge warning when both base and subclass contribute invariants.

**Files:**
- Modify: `src/class-rewriter.ts`
- Test: `test/transformer.test.ts`, `test/acceptance.test.ts`

- [ ] **Step 5.1: Write failing tests**

Add to `test/transformer.test.ts`:

```typescript
describe('base class invariant inheritance', () => {
  it('subclass inherits @invariant from base class', () => {
    const source = `
      class Animal {
        energy = 0;
        /** @invariant this.energy >= 0 */
        feed(amount: number): void { this.energy += amount; }
      }
      export class Dog extends Animal {
        energy = 0;
        feed(amount: number): void { this.energy = -99; }
      }
    `;
    const { Dog } = evalTransformed(transformWithProgram(source, () => {}));
    const dog = new Dog();
    expect(() => dog.feed(5)).toThrow();
  });

  it('emits named merge warning when base and subclass both define @invariant', () => {
    const source = `
      class Animal {
        energy = 0;
        /** @invariant this.energy >= 0 */
        feed(amount: number): void {}
      }
      export class Dog extends Animal {
        energy = 0;
        /** @invariant this.energy < 1000 */
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

- [ ] **Step 5.2: Run to confirm they fail**

```bash
npx jest --testPathPattern="transformer" -t "base class invariant inheritance" --no-coverage
```

Expected: invariant test FAILs (invariants not yet flowing through), warning test may PASS or FAIL depending on current warning wording.

- [ ] **Step 5.3: Update `resolveEffectiveInvariants` signature in `src/class-rewriter.ts`**

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

- [ ] **Step 5.4: Pass base class invariants from `mergeContractSets` into `resolveEffectiveInvariants`**

Because `mergeContractSets` already concatenates base class invariants into `interfaceContracts.invariants`, the existing call to `resolveEffectiveInvariants` in `rewriteClass` already threads them through. No additional wiring is needed.

However, for the named warning (which should name `Animal` rather than `base class`), the simplest approach is to thread the `baseContracts` object separately. Update `rewriteClass`:

```typescript
  const effectiveInvariants = resolveEffectiveInvariants(
    node, reparsedClass, className, warn,
    ifaceOnly.invariants, baseContracts.invariants,
  );
```

And update `mergeContractSets` to not merge invariants (they are now threaded separately):

```typescript
function mergeContractSets(
  primary: InterfaceContracts,
  secondary: BaseClassContracts,
): InterfaceContracts {
  const merged: InterfaceContracts = {
    methods: new Map(primary.methods),
    invariants: primary.invariants,   // invariants merged separately in resolveEffectiveInvariants
  };
  // ... (method merge unchanged)
```

- [ ] **Step 5.5: Run tests**

```bash
npx jest --testPathPattern="transformer" -t "base class invariant inheritance" --no-coverage
```

Expected: both pass.

- [ ] **Step 5.6: Run full suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5.7: Commit**

```bash
git add src/class-rewriter.ts test/transformer.test.ts
git commit -m "feat: inherit base class invariants with named merge warning"
```

---

## Task 6: Three-way merge warning and merge ordering

Verify that when interface contracts, base class contracts, and subclass own contracts all define `@pre` tags for the same method, all three sets are applied in the correct order and a merge warning is emitted listing all three sources.

**Files:**
- Test: `test/transformer.test.ts`

- [ ] **Step 6.1: Write failing tests**

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

- [ ] **Step 6.2: Run tests**

```bash
npx jest --testPathPattern="transformer" -t "three-way contract merge" --no-coverage
```

Expected: both pass (merge is already handled by `mergeContractSets` + existing `tryRewriteFunction` logic). If either fails, inspect the method merge warning logic in `emitMethodMergeWarnings` — it may need updating to reference the merged `sourceInterface` field from the combined set.

- [ ] **Step 6.3: Run full suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 6.4: Commit**

```bash
git add test/transformer.test.ts
git commit -m "test: add three-way interface+base+subclass contract merge coverage"
```

---

## Task 7: `transpileModule` mode warning covers `extends` clause

**Files:**
- Test: `test/transformer.test.ts`

The guard was already widened in Task 4 (`hasResolvableHeritageClauses`). This task adds an explicit test.

- [ ] **Step 7.1: Write failing test**

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
    transformWithoutProgram(source, (msg) => warnings.push(msg));
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
    const { Dog } = evalTransformed(transformWithoutProgram(source, () => {}));
    const dog = new Dog();
    expect(() => dog.feed(-1)).toThrow();
    expect(() => dog.feed(5)).not.toThrow();
  });
});
```

- [ ] **Step 7.2: Run tests**

```bash
npx jest --testPathPattern="transformer" -t "transpileModule mode with extends clause" --no-coverage
```

Expected: both pass (warning guard already updated in Task 4).

- [ ] **Step 7.3: Run full suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 7.4: Commit**

```bash
git add test/transformer.test.ts
git commit -m "test: verify transpileModule warning fires for extends clause"
```

---

## Task 8: Acceptance tests — runtime contract enforcement

**Files:**
- Modify: `test/acceptance.test.ts`

- [ ] **Step 8.1: Write acceptance tests**

Add a new describe block to `test/acceptance.test.ts`:

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

- [ ] **Step 8.2: Implement each test body**

Fill in the test bodies using the project's existing acceptance test patterns (e.g. `transformAndEval`, `ContractViolationError`, `InvariantViolationError`).

- [ ] **Step 8.3: Run acceptance tests**

```bash
npx jest --testPathPattern="acceptance" --no-coverage
```

Expected: all pass.

- [ ] **Step 8.4: Run full suite with coverage**

```bash
npm run test:coverage
```

Expected: all tests pass, coverage thresholds met.

- [ ] **Step 8.5: Run lint**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 8.6: Commit**

```bash
git add test/acceptance.test.ts
git commit -m "test: acceptance tests for class inheritance contract propagation"
```

---

## Acceptance Checklist

Human QA steps to verify the feature is working end-to-end:

- [ ] **Basic pre-condition inheritance** — Create a class `Dog extends Animal` where `Animal.feed` has `@pre amount > 0`. Call `dog.feed(-1)` and confirm a `ContractViolationError` is thrown. Call `dog.feed(5)` and confirm it succeeds.
- [ ] **Post-condition inheritance** — `Animal.feed` declares `@post this.energy > 0`. Override `feed` in `Dog` with a body that sets `this.energy = -1`. Call `dog.feed(5)` and confirm a `ContractViolationError` is thrown.
- [ ] **Invariant inheritance** — `Animal` declares `@invariant this.energy >= 0`. `Dog.feed` sets `this.energy = -99`. Call `dog.feed(5)` and confirm an `InvariantViolationError` is thrown.
- [ ] **Additive merge (base + subclass)** — Both `Animal.feed` and `Dog.feed` have `@pre` tags. Confirm both guards fire and a merge warning is emitted to `stderr`.
- [ ] **Three-way merge (interface + base + subclass)** — Interface, base class, and subclass all declare `@pre` on the same method. Confirm all three guards fire in order and a single merge warning names all three sources.
- [ ] **Cross-file base class** — Move `Animal` to a separate file. Confirm contracts are still inherited by `Dog` defined in the main file.
- [ ] **No override — no injection** — `Dog` does not override `Animal.bark`. Confirm no duplicate contract injection occurs on `Animal.bark`.
- [ ] **Parameter rename mode** — Base uses `feed(amount)`, subclass uses `feed(qty)`. Confirm the injected guard uses `qty > 0`, not `amount > 0`. Confirm a rename warning is emitted.
- [ ] **Parameter ignore mode** — Same setup with `interfaceParamMismatch: 'ignore'`. Confirm no guard is injected and a "contract skipped" warning is emitted.
- [ ] **Parameter count mismatch** — Base has `feed(amount, unit)`, subclass has `feed(amount)`. Confirm base contracts are skipped and a count-mismatch warning is emitted.
- [ ] **transpileModule mode** — Run without a TypeChecker (e.g. `ts-jest` without Program integration). Confirm the "transpileModule mode" warning is emitted, and that `Dog`'s own class-level contracts (on methods not overridden from `Animal`) still fire.
- [ ] **No regression** — All pre-existing interface contract tests continue to pass (`npm test`).
- [ ] **Lint clean** — `npm run lint` reports no errors.
- [ ] **Coverage** — `npm run test:coverage` meets the 80% threshold.
