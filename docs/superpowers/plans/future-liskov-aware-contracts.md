# Liskov-Aware Contract Warnings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit a compile-time warning whenever a subtype method adds `@pre` constraints on top of an inherited `@pre` (heuristic LSP violation detection). Provide a `@preWeakens` opt-out tag that suppresses the warning when the developer intentionally weakens a precondition. No change to runtime merge behaviour — additive merge is preserved.

**Architecture:** Three files change. `src/jsdoc-parser.ts` gains `extractPreWeakensTag` to detect the opt-out annotation. `src/interface-resolver.ts` gains `resolveBaseClassContracts` to walk `extends` heritage clauses and return base class method contracts in the same `InterfaceContracts` shape used for interface contracts. `src/class-rewriter.ts` gains `checkLiskovPreConditions`, called after contracts are resolved for each method, which emits a warning when both the inherited side and the class side carry `@pre` tags and `@preWeakens` is absent.

**Depends on:** `#17` (class-to-class inheritance) must ship before this plan is executed. `resolveBaseClassContracts` relies on the `extends` heritage walk that #17 introduces.

**Spec reference:** `docs/superpowers/specs/2026-04-13-liskov-contracts-design.md`

**Tech Stack:** TypeScript, ts-patch transformer API, Jest.

---

## ESLint constraints (read before touching any `src/` file)

- `id-length: min 3` — no identifiers shorter than 3 characters.
- `complexity: 10` — keep functions small; extract helpers.
- `max-len: 100` — lines under 100 chars.
- No `console` — use the injectable `warn` callback.

---

## File Map

| File | Change |
|---|---|
| `src/jsdoc-parser.ts` | Add `extractPreWeakensTag` exported function |
| `src/interface-resolver.ts` | Add `resolveBaseClassContracts` exported function mirroring `resolveInterfaceContracts` but walking `ExtendsKeyword` heritage |
| `src/class-rewriter.ts` | Add `checkLiskovPreConditions` helper; call it from `lookupIfaceMethodContracts` after contracts are resolved; pass base class contracts through the same path |
| `test/transformer.test.ts` | New describe blocks for each task |

---

## Task 1: `extractPreWeakensTag` in `jsdoc-parser.ts`

**Files:**
- Modify: `src/jsdoc-parser.ts`
- Test: `test/transformer.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/transformer.test.ts`:

```typescript
describe('extractPreWeakensTag', () => {
  it('returns the tag argument when @preWeakens is present', () => {
    const source = `
      class Foo {
        /**
         * @preWeakens Lockable.unlock
         */
        unlock(userId: string): void {}
      }
    `;
    // Use a helper that exposes the parsed JSDoc tag value
    // (exact helper depends on test harness — adjust to match existing patterns)
    const result = extractPreWeakensTagFromSource(source, 'unlock');
    expect(result).toBe('Lockable.unlock');
  });

  it('returns undefined when @preWeakens is absent', () => {
    const source = `
      class Foo {
        /** @pre amount > 0 */
        pay(amount: number): void {}
      }
    `;
    const result = extractPreWeakensTagFromSource(source, 'pay');
    expect(result).toBeUndefined();
  });

  it('returns empty string when @preWeakens is present with no argument', () => {
    const source = `
      class Foo {
        /** @preWeakens */
        pay(amount: number): void {}
      }
    `;
    const result = extractPreWeakensTagFromSource(source, 'pay');
    expect(result).toBe('');
  });
});
```

- [ ] **Step 2: Run to confirm failures**

```
npx jest --testPathPattern="transformer" -t "extractPreWeakensTag" --no-coverage
```

Expected: all three FAILs (`extractPreWeakensTag` does not exist yet).

- [ ] **Step 3: Add `extractPreWeakensTag` to `src/jsdoc-parser.ts`**

Add the constant and function after `extractPrevExpression`:

```typescript
const PRE_WEAKENS_TAG = 'preweakens' as const;

export function extractPreWeakensTag(
  node: typescript.Node,
): string | undefined {
  const jsDocTags = typescript.getJSDocTags(node);
  for (const tag of jsDocTags) {
    if (tag.tagName.text.toLowerCase() === PRE_WEAKENS_TAG) {
      return resolveTagComment(tag.comment);
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Run the tests**

```
npx jest --testPathPattern="transformer" -t "extractPreWeakensTag" --no-coverage
```

Expected: all three PASSes.

- [ ] **Step 5: Run full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```
git add src/jsdoc-parser.ts test/transformer.test.ts
git commit -m "feat: add extractPreWeakensTag to jsdoc-parser"
```

---

## Task 2: `checkLiskovPreConditions` helper in `class-rewriter.ts`

**Files:**
- Modify: `src/class-rewriter.ts`
- Test: `test/transformer.test.ts`

This task adds the core detection logic. It does not yet wire it into the class-rewriting flow — that happens in Task 4.

- [ ] **Step 1: Write the failing tests**

Add to `test/transformer.test.ts`:

```typescript
describe('LSP precondition warning — interface', () => {
  it('warns when interface has @pre and class method also has @pre', () => {
    const source = `
      interface Withdrawable {
        /** @pre amount > 0 */
        withdraw(amount: number): void;
      }
      class PremiumAccount implements Withdrawable {
        /** @pre amount > 100 */
        withdraw(amount: number): void {}
      }
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) =>
        w.includes('[axiom] Possible LSP violation') &&
        w.includes('PremiumAccount.withdraw'),
      ),
    ).toBe(true);
  });

  it('does not warn when only the class has @pre (no interface @pre)', () => {
    const source = `
      interface Printable {
        print(): void;
      }
      class Doc implements Printable {
        /** @pre this.ready */
        print(): void {}
      }
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings.every((w) => !w.includes('LSP violation'))).toBe(true);
  });

  it('does not warn when only the interface has @pre (class adds none)', () => {
    const source = `
      interface Withdrawable {
        /** @pre amount > 0 */
        withdraw(amount: number): void;
      }
      class BasicAccount implements Withdrawable {
        withdraw(amount: number): void {}
      }
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings.every((w) => !w.includes('LSP violation'))).toBe(true);
  });

  it('suppresses the warning when @preWeakens is present', () => {
    const source = `
      interface Lockable {
        /** @pre this.isLocked */
        unlock(userId: string): void;
      }
      class PublicDoor implements Lockable {
        /**
         * @pre this.isLocked
         * @preWeakens Lockable.unlock
         */
        unlock(userId: string): void {}
      }
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings.every((w) => !w.includes('LSP violation'))).toBe(true);
  });

  it('emits advisory when @preWeakens is present but no inherited @pre exists', () => {
    const source = `
      interface Printable {
        print(): void;
      }
      class Doc implements Printable {
        /**
         * @preWeakens Printable.print
         */
        print(): void {}
      }
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) =>
        w.includes('@preWeakens') && w.includes('has no effect'),
      ),
    ).toBe(true);
  });
});

describe('LSP postcondition strengthening — no warning', () => {
  it('does not warn when subtype adds @post beyond inherited @post', () => {
    const source = `
      interface Describable {
        /** @post result.length > 0 */
        describe(): string;
      }
      class Dog implements Describable {
        /** @post result.length > 10 */
        describe(): string { return ''; }
      }
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings.every((w) => !w.includes('LSP violation'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm failures**

```
npx jest --testPathPattern="transformer" -t "LSP precondition warning" --no-coverage
npx jest --testPathPattern="transformer" -t "LSP postcondition strengthening" --no-coverage
```

Expected: the "warns when" and "emits advisory" tests FAIL; the "does not warn" tests may PASS trivially.

- [ ] **Step 3: Add `checkLiskovPreConditions` to `src/class-rewriter.ts`**

Add the import for `extractPreWeakensTag` at the top of the file:

```typescript
import {
  extractInvariantExpressions,
  extractContractTags,
  extractPrevExpression,
  extractPreWeakensTag,
} from './jsdoc-parser';
```

Add the helper function before `lookupIfaceMethodContracts`:

```typescript
function checkLiskovPreConditions(
  className: string,
  methodName: string,
  inheritedPreTags: ContractTag[],
  classPreTags: ContractTag[],
  classMethodNode: typescript.MethodDeclaration,
  parentTypeName: string,
  warn: (msg: string) => void,
): void {
  const location = `${className}.${methodName}`;
  const preWeakensArg = extractPreWeakensTag(classMethodNode);
  const hasPreWeakens = preWeakensArg !== undefined;

  if (hasPreWeakens && inheritedPreTags.length === 0) {
    warn(
      `[axiom] @preWeakens on ${location} has no effect:`
      + `\n  no inherited @pre found for this method in any interface or base class`,
    );
    return;
  }

  if (inheritedPreTags.length === 0 || classPreTags.length === 0) {
    return;
  }

  if (hasPreWeakens) {
    return;
  }

  warn(
    `[axiom] Possible LSP violation in ${location}:`
    + `\n  adds @pre constraints beyond those in ${parentTypeName}.${methodName}`
    + `\n  — preconditions should only be weakened in subtypes, not strengthened`
    + `\n  — use @preWeakens to suppress if this is intentional`,
  );
}
```

- [ ] **Step 4: Run the tests**

```
npx jest --testPathPattern="transformer" -t "LSP precondition warning" --no-coverage
npx jest --testPathPattern="transformer" -t "LSP postcondition strengthening" --no-coverage
```

Expected: all PASSes once `checkLiskovPreConditions` is wired in Task 4. Some may still fail until then — proceed to Task 4.

- [ ] **Step 5: Run full suite**

```
npm test
```

Expected: all tests pass (new tests may remain failing until Task 4).

- [ ] **Step 6: Commit**

```
git add src/class-rewriter.ts test/transformer.test.ts
git commit -m "feat: add checkLiskovPreConditions helper to class-rewriter"
```

---

## Task 3: `resolveBaseClassContracts` in `interface-resolver.ts`

**Files:**
- Modify: `src/interface-resolver.ts`
- Test: `test/transformer.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/transformer.test.ts`:

```typescript
describe('LSP precondition warning — base class', () => {
  it('warns when base class has @pre and subclass method also has @pre', () => {
    const source = `
      class Animal {
        /** @pre this.isAlive */
        move(): void {}
      }
      class Dog extends Animal {
        /** @pre this.isAlive && this.hasLegs */
        move(): void {}
      }
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) =>
        w.includes('[axiom] Possible LSP violation') &&
        w.includes('Dog.move'),
      ),
    ).toBe(true);
  });

  it('does not warn when base class has @pre and subclass adds none', () => {
    const source = `
      class Animal {
        /** @pre this.isAlive */
        move(): void {}
      }
      class Dog extends Animal {
        move(): void {}
      }
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings.every((w) => !w.includes('LSP violation'))).toBe(true);
  });

  it('suppresses warning for base class @pre when @preWeakens is present', () => {
    const source = `
      class Animal {
        /** @pre this.isAlive */
        move(): void {}
      }
      class Dog extends Animal {
        /**
         * @pre this.isAlive
         * @preWeakens Animal.move
         */
        move(): void {}
      }
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings.every((w) => !w.includes('LSP violation'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm failures**

```
npx jest --testPathPattern="transformer" -t "LSP precondition warning — base class" --no-coverage
```

Expected: the "warns when" test FAILs; the "does not warn" and "suppresses" tests may PASS trivially.

- [ ] **Step 3: Add `resolveBaseClassContracts` to `src/interface-resolver.ts`**

Add a helper to find a class declaration by position, mirroring `findInterfaceByPos`:

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

Add a helper to extract contracts from a base class method declaration (not a signature):

```typescript
function extractBaseClassMethodContracts(
  baseClassNode: typescript.ClassDeclaration,
  methodName: string,
  classParams: string[],
  mode: ParamMismatchMode,
  baseClassName: string,
  location: string,
  warn: (msg: string) => void,
): InterfaceMethodContracts | undefined {
  const methodDecl = Array.from(baseClassNode.members).find(
    (member): member is typescript.MethodDeclaration =>
      typescript.isMethodDeclaration(member) &&
      typescript.isIdentifier(member.name) &&
      member.name.text === methodName,
  );
  if (methodDecl === undefined) {
    return undefined;
  }

  const baseParams = getClassMethodParams(methodDecl);
  if (baseParams.length !== classParams.length) {
    warn(
      `[axiom] Parameter count mismatch in ${location}:`
      + `\n  base class ${baseClassName} has ${baseParams.length} parameters,`
      + ` subclass has ${classParams.length} — base class contracts skipped`,
    );
    return { preTags: [], postTags: [], sourceInterface: baseClassName };
  }

  const { renameMap, shouldSkip } = handleParamMismatch(
    baseClassName, location, baseParams, classParams, mode, warn,
  );
  if (shouldSkip) {
    return { preTags: [], postTags: [], sourceInterface: baseClassName };
  }

  const hasMismatch = renameMap.size > 0;
  const allTags = extractContractTagsFromNode(methodDecl);
  const preTags = allTags.filter((tag) => tag.kind === KIND_PRE);
  const postTags = allTags.filter((tag) => tag.kind === KIND_POST);

  let prevExpr = extractPrevExpression(methodDecl);
  if (hasMismatch && mode === MODE_RENAME && prevExpr !== undefined) {
    prevExpr = renameIdentifiersInExpression(prevExpr, renameMap);
  }

  return buildContractsResult(
    preTags, postTags, prevExpr, renameMap, hasMismatch, mode, baseClassName,
  );
}
```

Add the exported function:

```typescript
export function resolveBaseClassContracts(
  classNode: typescript.ClassDeclaration,
  checker: typescript.TypeChecker,
  cache: Map<string, typescript.SourceFile>,
  warn: (msg: string) => void,
  mode: ParamMismatchMode,
): InterfaceContracts {
  const result: InterfaceContracts = {
    methods: new Map<string, InterfaceMethodContracts>(),
    invariants: [],
  };
  const className = classNode.name?.text ?? 'UnknownClass';

  const heritageClauses = classNode.heritageClauses ?? [];
  heritageClauses.forEach((clause) => {
    if (clause.token === typescript.SyntaxKind.ExtendsKeyword) {
      clause.types.forEach((typeRef) => {
        const baseType = checker.getTypeAtLocation(typeRef.expression);
        const declarations = baseType.symbol?.declarations;
        if (declarations === undefined) {
          return;
        }
        declarations.forEach((decl) => {
          if (!typescript.isClassDeclaration(decl)) {
            return;
          }
          const baseClassName = decl.name?.text ?? 'UnknownBase';
          const reparsed = reparseCached(decl.getSourceFile(), cache);
          const reparsedBase = findClassByPos(reparsed, decl.pos);
          if (reparsedBase === undefined) {
            return;
          }
          classNode.members.forEach((member) => {
            const isMethod = typescript.isMethodDeclaration(member);
            const hasIdentifierName = isMethod && typescript.isIdentifier(member.name);
            if (!isMethod || !hasIdentifierName) {
              return;
            }
            const methodName = member.name.text;
            const classParams = getClassMethodParams(member);
            const location = `${className}.${methodName}`;
            const methodContracts = extractBaseClassMethodContracts(
              reparsedBase, methodName, classParams, mode,
              baseClassName, location, warn,
            );
            if (methodContracts !== undefined) {
              result.methods.set(
                methodName,
                mergeMethodContracts(result.methods.get(methodName), methodContracts),
              );
            }
          });
        });
      });
    }
  });

  return result;
}
```

- [ ] **Step 4: Run the tests**

```
npx jest --testPathPattern="transformer" -t "LSP precondition warning — base class" --no-coverage
```

Expected: all PASSes once `checkLiskovPreConditions` is wired in Task 4. Proceed.

- [ ] **Step 5: Run full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```
git add src/interface-resolver.ts test/transformer.test.ts
git commit -m "feat: add resolveBaseClassContracts to interface-resolver"
```

---

## Task 4: Wire `checkLiskovPreConditions` into the class-rewriting flow

**Files:**
- Modify: `src/class-rewriter.ts`

This task updates `lookupIfaceMethodContracts` and `rewriteClass` to call `checkLiskovPreConditions` and `resolveBaseClassContracts` in the right places.

- [ ] **Step 1: No new tests required** — the tests from Tasks 2 and 3 cover this; they are expected to be failing until this task is complete.

- [ ] **Step 2: Import `resolveBaseClassContracts` in `src/class-rewriter.ts`**

Update the import from `./interface-resolver`:

```typescript
import {
  resolveInterfaceContracts,
  resolveBaseClassContracts,
  type InterfaceContracts,
  type InterfaceMethodContracts,
  type ParamMismatchMode,
} from './interface-resolver';
```

- [ ] **Step 3: Update `lookupIfaceMethodContracts` to call `checkLiskovPreConditions`**

After the `emitMethodMergeWarnings` call, extract the class method's own `@pre` tags and call `checkLiskovPreConditions`:

```typescript
function lookupIfaceMethodContracts(
  member: typescript.MethodDeclaration,
  reparsedIndex: ReparsedIndex,
  interfaceContracts: InterfaceContracts,
  className: string,
  warn: (msg: string) => void,
): InterfaceMethodContracts | undefined {
  if (!typescript.isIdentifier(member.name)) {
    return undefined;
  }
  const methodName = member.name.text;
  const ifaceContracts = interfaceContracts.methods.get(methodName);
  if (ifaceContracts === undefined) {
    return undefined;
  }
  const reparsedNode = reparsedIndex.functions.get(member.pos) ?? member;
  const location = `${className}.${methodName}`;
  emitMethodMergeWarnings(
    ifaceContracts, reparsedNode, location, className, warn,
  );

  const classTags = extractContractTags(reparsedNode);
  const classPreTags = classTags.filter((tag) => tag.kind === KIND_PRE);
  checkLiskovPreConditions(
    className,
    methodName,
    ifaceContracts.preTags,
    classPreTags,
    member,
    ifaceContracts.sourceInterface,
    warn,
  );

  return ifaceContracts;
}
```

- [ ] **Step 4: Update `rewriteClass` to resolve and check base class contracts**

In `rewriteClass`, after `resolveInterfaceContracts`, also resolve base class contracts and run the LSP check for each method:

```typescript
const interfaceContracts: InterfaceContracts = checker !== undefined
  ? resolveInterfaceContracts(node, checker, cache, warn, mode)
  : { methods: new Map(), invariants: [] };

const baseClassContracts: InterfaceContracts = checker !== undefined
  ? resolveBaseClassContracts(node, checker, cache, warn, mode)
  : { methods: new Map(), invariants: [] };

// Run LSP checks for base class @pre inheritance
node.members.forEach((member) => {
  if (typescript.isMethodDeclaration(member) && typescript.isIdentifier(member.name)) {
    const methodName = member.name.text;
    const baseContracts = baseClassContracts.methods.get(methodName);
    if (baseContracts !== undefined) {
      const reparsedNode = reparsedIndex.functions.get(member.pos) ?? member;
      const classTags = extractContractTags(reparsedNode);
      const classPreTags = classTags.filter((tag) => tag.kind === KIND_PRE);
      checkLiskovPreConditions(
        className,
        methodName,
        baseContracts.preTags,
        classPreTags,
        member,
        baseContracts.sourceInterface,
        warn,
      );
    }
  }
});
```

- [ ] **Step 5: Run all LSP-related tests**

```
npx jest --testPathPattern="transformer" -t "LSP" --no-coverage
```

Expected: all PASSes.

- [ ] **Step 6: Run full suite**

```
npm test
```

Expected: all tests pass, coverage threshold maintained.

- [ ] **Step 7: Commit**

```
git add src/class-rewriter.ts
git commit -m "feat: wire LSP precondition checks into class-rewriting flow"
```

---

## Task 5: `transpileModule` mode — no-op behaviour

**Files:**
- Test: `test/transformer.test.ts`

Verify that LSP checks are silently skipped in `transpileModule` mode (no `TypeChecker`), consistent with spec §7.3.

- [ ] **Step 1: Write the test**

```typescript
describe('LSP checks in transpileModule mode', () => {
  it('emits no LSP warning when TypeChecker is unavailable', () => {
    // Use the non-program transform helper (transpileModule path)
    const source = `
      class Foo {
        /** @pre this.ready */
        run(): void {}
      }
    `;
    const warnings: string[] = [];
    transformSource(source, (msg) => warnings.push(msg));
    expect(warnings.every((w) => !w.includes('LSP violation'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test**

```
npx jest --testPathPattern="transformer" -t "LSP checks in transpileModule mode" --no-coverage
```

Expected: PASS (the TypeChecker guard in `rewriteClass` already prevents base class and interface resolution in this mode).

- [ ] **Step 3: Run full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```
git add test/transformer.test.ts
git commit -m "test: verify LSP checks are skipped in transpileModule mode"
```

---

## Task 6: Cross-file interface contract LSP check

**Files:**
- Test: `test/transformer.test.ts`

Verify that the LSP warning fires when the interface is defined in a separate file.

- [ ] **Step 1: Write the test**

```typescript
describe('LSP precondition warning — cross-file interface', () => {
  it('warns when the interface is in a separate file and both sides have @pre', () => {
    const interfaceSource = `
      export interface Withdrawable {
        /** @pre amount > 0 */
        withdraw(amount: number): void;
      }
    `;
    const classSource = `
      import { Withdrawable } from './withdrawable';
      export class PremiumAccount implements Withdrawable {
        /** @pre amount > 100 */
        withdraw(amount: number): void {}
      }
    `;
    const warnings: string[] = [];
    transformMultiFile(
      { 'withdrawable.ts': interfaceSource, 'account.ts': classSource },
      'account.ts',
      (msg) => warnings.push(msg),
    );
    expect(
      warnings.some((w) =>
        w.includes('[axiom] Possible LSP violation') &&
        w.includes('PremiumAccount.withdraw'),
      ),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test**

```
npx jest --testPathPattern="transformer" -t "LSP precondition warning — cross-file interface" --no-coverage
```

Expected: PASS (cross-file resolution is handled by the existing `reparseCached` infrastructure used by `resolveInterfaceContracts`).

If it fails, check that `transformMultiFile` helper exists in the test suite or adjust to match the existing multi-file test helper pattern.

- [ ] **Step 3: Run full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```
git add test/transformer.test.ts
git commit -m "test: add cross-file interface LSP precondition warning coverage"
```

---

## Acceptance Checklist

Human QA — verify each item manually before marking the branch ready:

- A class that implements an interface where both sides define `@pre` for the same method produces a `[axiom] Possible LSP violation` warning during `npm run build`.
- The warning message includes the subtype class name, the method name, and the parent interface or base class name.
- A class method annotated with `@preWeakens` does not produce an LSP violation warning, even when both sides have `@pre`.
- A class method annotated with `@preWeakens` when no parent defines `@pre` produces the `@preWeakens … has no effect` advisory instead.
- A subtype that adds `@post` beyond an inherited `@post` (postcondition strengthening) produces no LSP warning.
- A subtype that adds `@pre` with no corresponding inherited `@pre` (class-only precondition) produces no LSP warning.
- A class that extends a base class where both sides define `@pre` for the same method produces a `[axiom] Possible LSP violation` warning.
- The runtime-injected guard is unchanged from pre-spec behaviour: additive merge still fires both the interface/base class guard and the class-level guard independently.
- Existing spec 004 acceptance criteria (interface contract injection, additive merge, parameter rename) are not broken.
- `npm run build` completes without TypeScript errors or lint violations.
- `npm test` passes with coverage at or above the 80% threshold.
- `transpileModule` mode (no TypeChecker) produces no LSP warnings — only the existing resolution-skipped warning if `implements` clauses are present.
