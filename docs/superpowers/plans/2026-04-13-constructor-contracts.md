# Constructor Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix issue #16 — `@pre`/`@post` tags on constructors are silently dropped. Extend `src/class-rewriter.ts` to parse, filter, and inject constructor contracts, with the same validation and warning quality that applies to regular methods and standalone functions.

**Architecture:** One file changes substantially (`src/class-rewriter.ts`): `rewriteConstructor` gains new parameters and full `@pre`/`@post` injection logic; `rewriteMember` is updated to call `rewriteConstructor` unconditionally (not just when invariants exist). One export is added to `src/function-rewriter.ts`: `expressionUsesResult` is exported so the constructor path can reuse it. No changes to `src/node-helpers.ts`, `src/ast-builder.ts`, or `src/contract-validator.ts`. All new tests go into `test/transformer.test.ts` in a new `describe('constructor contracts')` block.

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
| `src/function-rewriter.ts` | Export `expressionUsesResult` |
| `src/class-rewriter.ts` | Extend `rewriteConstructor` signature and body; update `rewriteMember` to call it unconditionally |
| `test/transformer.test.ts` | New `describe('constructor contracts')` block covering all cases |

---

## Task 1: Export `expressionUsesResult` from `function-rewriter.ts`

**Files:**
- Modify: `src/function-rewriter.ts`

`expressionUsesResult` is currently a private function. The constructor rewrite path in `class-rewriter.ts` needs it to filter `@post` tags that reference `result`.

- [ ] **Step 1: Change `function expressionUsesResult` to `export function expressionUsesResult`**

In `src/function-rewriter.ts`, change line:

```typescript
function expressionUsesResult(expression: string): boolean {
```

to:

```typescript
export function expressionUsesResult(expression: string): boolean {
```

No other changes in this step.

- [ ] **Step 2: Run full suite to confirm nothing broke**

```
npm test
```

Expected: all tests pass.

---

## Task 2: Write failing tests for constructor `@pre` injection

**Files:**
- Modify: `test/transformer.test.ts`

- [ ] **Step 1: Add the failing tests**

Add a new `describe('constructor contracts')` block to `test/transformer.test.ts`:

```typescript
describe('constructor contracts', () => {
  describe('basic @pre injection', () => {
    it('injects pre-check for constructor @pre tag', () => {
      const source = `
        export class Account {
          balance: number;
          /**
           * @pre initialBalance >= 0
           */
          constructor(initialBalance: number) {
            this.balance = initialBalance;
          }
        }
      `;
      const output = transform(source);
      expect(output).toContain('ContractViolationError');
      expect(output).toContain('!(initialBalance >= 0)');
      expect(output).toContain('"PRE"');
    });

    it('throws at runtime when constructor @pre is violated', () => {
      const source = `
        export class Account {
          balance: number;
          /**
           * @pre initialBalance >= 0
           */
          constructor(initialBalance: number) {
            this.balance = initialBalance;
          }
        }
      `;
      const output = transform(source);
      const mod = { exports: {} as Record<string, unknown> };
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function('module', 'exports', 'require', output)(
        mod,
        mod.exports,
        () => ({ ContractViolationError: class ContractViolationError extends Error {} }),
      );
      // Should not throw for valid input
      const AccountClass = mod.exports['Account'] as new (n: number) => unknown;
      expect(() => new AccountClass(100)).not.toThrow();
    });

    it('uses ClassName (not ClassName.constructor) as the location string', () => {
      const source = `
        export class Account {
          balance: number;
          /**
           * @pre initialBalance >= 0
           */
          constructor(initialBalance: number) {
            this.balance = initialBalance;
          }
        }
      `;
      const output = transform(source);
      expect(output).toContain('"Account"');
      expect(output).not.toContain('"Account.constructor"');
    });
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

```
npx jest --testPathPattern="transformer" -t "constructor contracts" --no-coverage
```

Expected: all three FAILs (no injection yet).

---

## Task 3: Extend `rewriteConstructor` signature and add `@pre` injection

**Files:**
- Modify: `src/class-rewriter.ts`

This task implements the core extension — new parameters, `@pre` parsing, filtering, injection, and the location string correction.

- [ ] **Step 1: Add `expressionUsesResult` and `expressionUsesPrev` imports**

At the top of `src/class-rewriter.ts`, update the import from `./function-rewriter`:

```typescript
import {
  tryRewriteFunction,
  isPublicTarget,
  filterValidTags,
  expressionUsesResult,
} from './function-rewriter';
```

Also add the import for `buildPreCheck`, `buildPostCheck` from `./ast-builder` (they may already be imported — check):

```typescript
import {
  buildCheckInvariantsCall, buildCheckInvariantsMethod,
  parseContractExpression, buildPreCheck, buildPostCheck,
} from './ast-builder';
```

Add the import for `buildKnownIdentifiers` from `./node-helpers`:

```typescript
import { buildKnownIdentifiers } from './node-helpers';
```

Add the import for `buildParameterTypes` and `TypeMapValue` from `./type-helpers`:

```typescript
import { buildParameterTypes, type TypeMapValue } from './type-helpers';
```

- [ ] **Step 2: Add `expressionUsesPrev` helper in `src/class-rewriter.ts`**

Rather than exporting `expressionUsesPrev` from `function-rewriter.ts`, add a private helper in `class-rewriter.ts`. This avoids widening the public API unnecessarily. Add after the `KIND_POST` constant:

```typescript
function expressionUsesPrev(expression: string): boolean {
  try {
    const parsed = parseContractExpression(expression);
    let found = false;
    function walk(node: typescript.Node): void {
      if (!found) {
        if (typescript.isIdentifier(node) && node.text === 'prev') {
          found = true;
        } else {
          typescript.forEachChild(node, walk);
        }
      }
    }
    walk(parsed);
    return found;
  } catch {
    return false;
  }
}
```

- [ ] **Step 3: Update `rewriteConstructor` signature and body**

Replace the current `rewriteConstructor` function with:

```typescript
function filterConstructorPostTags(
  postTags: ContractTag[],
  className: string,
  warn: (msg: string) => void,
): ContractTag[] {
  return postTags.filter((tag) => {
    if (expressionUsesResult(tag.expression)) {
      warn(
        `[axiom] Contract validation warning in ${className}:`
        + `\n  @post ${tag.expression}`
        + ` — 'result' used in constructor @post; @post dropped`,
      );
      return false;
    }
    if (expressionUsesPrev(tag.expression)) {
      warn(
        `[axiom] Contract validation warning in ${className}:`
        + `\n  @post ${tag.expression}`
        + ` — 'prev' used in constructor @post; @post dropped`,
      );
      return false;
    }
    return true;
  });
}

function buildConstructorStatements(
  factory: typescript.NodeFactory,
  preTags: ContractTag[],
  postTags: ContractTag[],
  originalBody: typescript.Block,
  location: string,
  hasInvariants: boolean,
  exportedNames: Set<string>,
): typescript.Statement[] {
  const statements: typescript.Statement[] = [];
  for (const tag of preTags) {
    statements.push(buildPreCheck(tag.expression, location, factory, exportedNames));
  }
  statements.push(...Array.from(originalBody.statements));
  for (const tag of postTags) {
    statements.push(buildPostCheck(tag.expression, location, factory, exportedNames));
  }
  if (hasInvariants) {
    statements.push(buildCheckInvariantsCall(location, factory));
  }
  return statements;
}

function rewriteConstructor(
  factory: typescript.NodeFactory,
  node: typescript.ConstructorDeclaration,
  className: string,
  reparsedIndex: ReparsedIndex,
  effectiveInvariants: string[],
  warn: (msg: string) => void,
  checker: typescript.TypeChecker | undefined,
  allowIdentifiers: string[],
): typescript.ConstructorDeclaration {
  const originalBody = node.body;
  if (!originalBody) {
    return node;
  }
  const location = className;
  const reparsedNode = reparsedIndex.functions.get(node.pos) ?? node;
  const allTags = extractContractTags(reparsedNode);
  const allPreInput = allTags.filter((tag) => tag.kind === KIND_PRE);
  const allPostInput = allTags.filter((tag) => tag.kind === KIND_POST);

  const filteredPost = filterConstructorPostTags(allPostInput, className, warn);

  const preKnown = buildKnownIdentifiers(node, false);
  const postKnown = buildKnownIdentifiers(node, false); // no result/prev for constructors
  const paramTypes = checker !== undefined ? buildParameterTypes(node, checker) : undefined;

  for (const allowedId of allowIdentifiers) {
    preKnown.add(allowedId);
    postKnown.add(allowedId);
  }

  const preTags = filterValidTags(
    allPreInput, KIND_PRE, location, warn, preKnown, paramTypes, checker, node,
  );
  const postTags = filterValidTags(
    filteredPost, KIND_POST, location, warn, postKnown, paramTypes, checker, node,
  );

  const hasInvariants = effectiveInvariants.length > 0;
  if (preTags.length === 0 && postTags.length === 0 && !hasInvariants) {
    return node;
  }

  const exportedNames = new Set<string>();
  const newStatements = buildConstructorStatements(
    factory, preTags, postTags, originalBody, location, hasInvariants, exportedNames,
  );
  return factory.updateConstructorDeclaration(
    node,
    typescript.getModifiers(node),
    node.parameters,
    factory.createBlock(newStatements, true),
  );
}
```

Note: The `exportedNames` set is empty here because constructors cannot reference exported module-level names in their contracts in any meaningful way that the pre/post checks would need to reference by module-scope name. If this changes in the future, wire up `collectExportedNames` (currently private in `function-rewriter.ts`) the same way `rewriteFunction` does.

- [ ] **Step 4: Update `rewriteMember` to call `rewriteConstructor` unconditionally**

Replace the constructor branch in `rewriteMember`:

```typescript
if (typescript.isConstructorDeclaration(member)) {
  const rewritten = rewriteConstructor(
    factory, member, className, reparsedIndex,
    effectiveInvariants, warn, checker, allowIdentifiers,
  );
  return { element: rewritten, changed: rewritten !== member };
}
```

Remove the old guard:

```typescript
// DELETE this old guard:
if (typescript.isConstructorDeclaration(member) && effectiveInvariants.length > 0) {
  return { element: rewriteConstructor(factory, member, className), changed: true };
}
```

- [ ] **Step 5: Run the Task 2 failing tests to confirm they now pass**

```
npx jest --testPathPattern="transformer" -t "constructor contracts" --no-coverage
```

Expected: all three PASSes.

- [ ] **Step 6: Run full suite**

```
npm test
```

Expected: all tests pass.

---

## Task 4: Write and pass tests for `@post` injection

**Files:**
- Modify: `test/transformer.test.ts`

- [ ] **Step 1: Add `@post` injection tests inside the existing `describe('constructor contracts')` block**

```typescript
describe('basic @post injection', () => {
  it('injects post-check for constructor @post tag', () => {
    const source = `
      export class Account {
        balance: number;
        /**
         * @post this.balance === initialBalance
         */
        constructor(initialBalance: number) {
          this.balance = initialBalance;
        }
      }
    `;
    const output = transform(source);
    expect(output).toContain('ContractViolationError');
    expect(output).toContain('!(this.balance === initialBalance)');
    expect(output).toContain('"POST"');
  });

  it('injects both @pre and @post with original statements in between', () => {
    const source = `
      export class Account {
        balance: number;
        /**
         * @pre initialBalance >= 0
         * @post this.balance === initialBalance
         */
        constructor(initialBalance: number) {
          this.balance = initialBalance;
        }
      }
    `;
    const output = transform(source);
    const preIndex = output.indexOf('!(initialBalance >= 0)');
    const postIndex = output.indexOf('!(this.balance === initialBalance)');
    expect(preIndex).toBeGreaterThan(-1);
    expect(postIndex).toBeGreaterThan(-1);
    expect(preIndex).toBeLessThan(postIndex);
  });
});
```

- [ ] **Step 2: Run to confirm tests pass**

```
npx jest --testPathPattern="transformer" -t "constructor contracts" --no-coverage
```

Expected: all PASSes.

---

## Task 5: Write and pass tests for `result` and `prev` filtering

**Files:**
- Modify: `test/transformer.test.ts`

- [ ] **Step 1: Add filter warning tests inside `describe('constructor contracts')`**

```typescript
describe('result and prev filtering', () => {
  it('warns and drops @post that uses result', () => {
    const source = `
      export class Account {
        balance: number;
        /**
         * @post result > 0
         */
        constructor(initialBalance: number) {
          this.balance = initialBalance;
        }
      }
    `;
    const warnings: string[] = [];
    const output = transform(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes("'result' used in constructor @post") && w.includes('Account')),
    ).toBe(true);
    expect(output).not.toContain('ContractViolationError');
  });

  it('warns and drops @post that uses prev', () => {
    const source = `
      export class Account {
        balance: number;
        /**
         * @post this.balance === prev.balance
         */
        constructor(initialBalance: number) {
          this.balance = initialBalance;
        }
      }
    `;
    const warnings: string[] = [];
    const output = transform(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes("'prev' used in constructor @post") && w.includes('Account')),
    ).toBe(true);
    expect(output).not.toContain('ContractViolationError');
  });

  it('drops result @post but still injects a valid sibling @post', () => {
    const source = `
      export class Account {
        balance: number;
        /**
         * @post result > 0
         * @post this.balance === initialBalance
         */
        constructor(initialBalance: number) {
          this.balance = initialBalance;
        }
      }
    `;
    const warnings: string[] = [];
    const output = transform(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes("'result' used in constructor @post"))).toBe(true);
    expect(output).toContain('!(this.balance === initialBalance)');
  });
});
```

- [ ] **Step 2: Run to confirm tests pass**

```
npx jest --testPathPattern="transformer" -t "constructor contracts" --no-coverage
```

Expected: all PASSes.

---

## Task 6: Write and pass tests for ordering with invariants

**Files:**
- Modify: `test/transformer.test.ts`

- [ ] **Step 1: Add ordering tests inside `describe('constructor contracts')`**

```typescript
describe('ordering with invariants', () => {
  it('places @post check before #checkInvariants() call', () => {
    const source = `
      /**
       * @invariant this.balance >= 0
       */
      export class Account {
        balance: number;
        /**
         * @post this.balance === initialBalance
         */
        constructor(initialBalance: number) {
          this.balance = initialBalance;
        }
      }
    `;
    const output = transform(source);
    const postIndex = output.indexOf('!(this.balance === initialBalance)');
    const invariantIndex = output.indexOf('#checkInvariants');
    expect(postIndex).toBeGreaterThan(-1);
    expect(invariantIndex).toBeGreaterThan(-1);
    expect(postIndex).toBeLessThan(invariantIndex);
  });

  it('places @pre at top, then original statements, then invariant (no @post)', () => {
    const source = `
      /**
       * @invariant this.balance >= 0
       */
      export class Account {
        balance: number;
        /**
         * @pre initialBalance >= 0
         */
        constructor(initialBalance: number) {
          this.balance = initialBalance;
        }
      }
    `;
    const output = transform(source);
    const preIndex = output.indexOf('!(initialBalance >= 0)');
    const assignIndex = output.indexOf('this.balance = initialBalance');
    const invariantIndex = output.indexOf('#checkInvariants');
    expect(preIndex).toBeGreaterThan(-1);
    expect(assignIndex).toBeGreaterThan(-1);
    expect(invariantIndex).toBeGreaterThan(-1);
    expect(preIndex).toBeLessThan(assignIndex);
    expect(assignIndex).toBeLessThan(invariantIndex);
  });

  it('existing invariant-only constructor injection still works (no @pre/@post)', () => {
    const source = `
      /**
       * @invariant this.balance >= 0
       */
      export class Account {
        balance: number;
        constructor(initialBalance: number) {
          this.balance = initialBalance;
        }
      }
    `;
    const output = transform(source);
    expect(output).toContain('#checkInvariants');
    expect(output).not.toContain('ContractViolationError');
  });
});
```

- [ ] **Step 2: Run to confirm tests pass**

```
npx jest --testPathPattern="transformer" -t "constructor contracts" --no-coverage
```

Expected: all PASSes.

---

## Task 7: Write and pass tests for identifier validation and edge cases

**Files:**
- Modify: `test/transformer.test.ts`

- [ ] **Step 1: Add validation and edge-case tests inside `describe('constructor contracts')`**

```typescript
describe('identifier validation', () => {
  it('validates @pre with this.x (this is in scope)', () => {
    const source = `
      export class Account {
        balance: number;
        /**
         * @pre this.balance === 0
         */
        constructor(initialBalance: number) {
          this.balance = initialBalance;
        }
      }
    `;
    const warnings: string[] = [];
    const output = transform(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
    expect(output).toContain('!(this.balance === 0)');
  });

  it('warns and drops @pre with unknown identifier', () => {
    const source = `
      export class Account {
        balance: number;
        /**
         * @pre unknownVar > 0
         */
        constructor(initialBalance: number) {
          this.balance = initialBalance;
        }
      }
    `;
    const warnings: string[] = [];
    transform(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes('unknownVar') && w.includes('Account')),
    ).toBe(true);
  });
});

describe('no-op cases', () => {
  it('returns constructor node unchanged when no @pre/@post and no invariants', () => {
    const source = `
      export class Account {
        balance: number;
        constructor(initialBalance: number) {
          this.balance = initialBalance;
        }
      }
    `;
    const output = transform(source);
    expect(output).not.toContain('ContractViolationError');
    expect(output).not.toContain('#checkInvariants');
  });

  it('does not throw on a constructor without a body (declare class)', () => {
    const source = `
      export declare class Account {
        balance: number;
        /**
         * @pre initialBalance >= 0
         */
        constructor(initialBalance: number);
      }
    `;
    expect(() => transform(source)).not.toThrow();
  });

  it('injects nothing when all @post tags are filtered out and no @pre and no invariants', () => {
    const source = `
      export class Account {
        balance: number;
        /**
         * @post result > 0
         */
        constructor(initialBalance: number) {
          this.balance = initialBalance;
        }
      }
    `;
    const warnings: string[] = [];
    const output = transform(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes("'result' used in constructor @post"))).toBe(true);
    expect(output).not.toContain('ContractViolationError');
  });
});
```

- [ ] **Step 2: Run all constructor contract tests**

```
npx jest --testPathPattern="transformer" -t "constructor contracts" --no-coverage
```

Expected: all PASSes.

- [ ] **Step 3: Run full suite**

```
npm test
```

Expected: all tests pass.

---

## Task 8: Final validation

- [ ] **Step 1: Run typecheck**

```
npm run typecheck
```

Expected: no errors.

- [ ] **Step 2: Run lint**

```
npm run lint
```

Expected: no errors.

- [ ] **Step 3: Run tests with coverage**

```
npm run test:coverage
```

Expected: all tests pass; coverage thresholds met (≥80%).

- [ ] **Step 4: Run knip to check for dead exports**

```
npm run knip
```

Verify that the newly exported `expressionUsesResult` is consumed by `class-rewriter.ts` (it is — it is used in `filterConstructorPostTags`). No new dead exports expected.

---

## Acceptance Checklist

Human QA — verify each of these by reading the transformed output or running the compiled code:

- [ ] A class with `@pre initialBalance >= 0` on its constructor compiles without warnings, and calling `new Account(-1)` at runtime throws a `ContractViolationError` with kind `"PRE"` and location `"Account"` (not `"Account.constructor"`).
- [ ] A class with `@post this.balance === initialBalance` on its constructor injects a post-check that follows the original constructor body statements in the compiled output.
- [ ] A class with both `@pre` and `@post` on its constructor compiles to: pre-check, original body, post-check — in that order.
- [ ] A constructor with `@post result > 0` emits a warning containing `'result' used in constructor @post` and the class name; no `ContractViolationError` code is injected for that tag.
- [ ] A constructor with `@post this.balance === prev.balance` emits a warning containing `'prev' used in constructor @post`; no `ContractViolationError` code is injected for that tag.
- [ ] A class with `@invariant` and a constructor with `@post` injects the post-check before the `#checkInvariants()` call in the compiled output.
- [ ] A class with `@invariant` and a constructor with only `@pre` injects: pre-check, original body, `#checkInvariants()` — in that order; no post-check is present.
- [ ] A class with `@invariant` and a constructor with no `@pre`/`@post` still injects only the `#checkInvariants()` call (existing behaviour preserved).
- [ ] A class with `@pre this.balance === 0` on the constructor (using `this` before any assignment) compiles without warnings and the check is injected; `this` is a valid identifier in the constructor pre-check scope.
- [ ] A class with `@pre unknownVar > 0` on the constructor emits an identifier validation warning and does not inject a check for that tag.
- [ ] A constructor with no body (e.g. `declare class`) is handled without throwing; no transformation is applied.
- [ ] A class with no `@pre`/`@post` on its constructor and no `@invariant` on the class produces output identical to the input (no `ContractViolationError`, no `#checkInvariants`).
- [ ] `npm run lint` passes with no new violations after the changes.
- [ ] `npm run typecheck` passes with no errors after the changes.
- [ ] `npm run test:coverage` meets the ≥80% threshold.
