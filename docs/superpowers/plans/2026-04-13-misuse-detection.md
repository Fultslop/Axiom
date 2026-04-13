# Misuse Detection: Silent Failures on Unsupported Targets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit a targeted `[axiom] Warning:` on the `warn` callback for each of the five silent-failure cases in #13: `@pre`/`@post` on a constructor; `@pre`/`@post` on an arrow function, function expression, or non-exported closure; `@pre`/`@post` on a class body; and `@invariant` on a non-class node.

**Architecture:** Two files change. `src/class-rewriter.ts` gains contract-tag checks in `rewriteMember` (constructor case) and `rewriteClass` (class-body case). `src/transformer.ts` gains detection branches in `visitNode` for arrow/function-expression, non-exported closure, and `@invariant`-on-non-class cases, plus a private `resolveDisplayName` helper. `src/jsdoc-parser.ts` is unchanged — `extractContractTagsFromNode` and `extractInvariantExpressions` are already exported and sufficient.

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
| `src/class-rewriter.ts` | In `rewriteMember`: detect `@pre`/`@post` on `ConstructorDeclaration` and warn. In `rewriteClass`: detect `@pre`/`@post` on the `ClassDeclaration` node itself and warn. Import `extractContractTagsFromNode` (already in `jsdoc-parser.ts`). |
| `src/transformer.ts` | In `visitNode`: detect arrow functions / function expressions with `@pre`/`@post`; detect non-exported `FunctionDeclaration` with `@pre`/`@post`; detect `@invariant` on any non-class node. Import `extractContractTagsFromNode` and `extractInvariantExpressions` directly. Add private `resolveDisplayName` helper. |
| `test/transformer.test.ts` | New `describe` blocks for each of the five misuse cases. |

---

## Task 1: `@pre`/`@post` on a constructor

**Files:**
- Modify: `src/class-rewriter.ts` — `rewriteMember`
- Test: `test/transformer.test.ts`

**Warning message:**
```
[axiom] Warning: @pre/@post on constructors is not supported — use @invariant on the class or call pre()/post() manually inside the constructor body (in ClassName.constructor)
```

- [ ] **Step 1: Write the failing tests**

Add to `test/transformer.test.ts`:

```typescript
describe('@pre/@post on constructor', () => {
  it('warns when constructor has @pre tag', () => {
    const source = `
      export class Counter {
        /** @pre x > 0 */
        constructor(private x: number) {}
      }
    `;
    const warnings: string[] = [];
    transpileWithWarn(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes('constructors is not supported') && w.includes('Counter')),
    ).toBe(true);
  });

  it('warns when constructor has @post tag', () => {
    const source = `
      export class Box {
        /** @post result !== null */
        constructor(public value: string) {}
      }
    `;
    const warnings: string[] = [];
    transpileWithWarn(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes('constructors is not supported') && w.includes('Box')),
    ).toBe(true);
  });

  it('does not warn for @pre on a regular method', () => {
    const source = `
      export class Calc {
        /** @pre x > 0 */
        double(x: number): number { return x * 2; }
      }
    `;
    const warnings: string[] = [];
    transpileWithWarn(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes('constructors is not supported'))).toBe(false);
  });

  it('injects invariant into constructor AND warns about @pre on constructor', () => {
    const source = `
      /** @invariant this.x > 0 */
      export class Guarded {
        /** @pre x > 0 */
        constructor(private x: number) {}
      }
    `;
    const warnings: string[] = [];
    const output = transpileWithWarn(source, (msg) => warnings.push(msg));
    expect(output).toContain('#checkInvariants');
    expect(
      warnings.some((w) => w.includes('constructors is not supported') && w.includes('Guarded')),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm failures**

```
npx jest --testPathPattern="transformer" -t "@pre/@post on constructor" --no-coverage
```

Expected: first two FAILs (no warning emitted), last two PASS.

- [ ] **Step 3: Import `extractContractTagsFromNode` in `src/class-rewriter.ts`**

Add `extractContractTagsFromNode` to the existing import from `./jsdoc-parser`:

```typescript
import {
  extractInvariantExpressions,
  extractContractTags,
  extractPrevExpression,
  extractContractTagsFromNode,
} from './jsdoc-parser';
```

- [ ] **Step 4: Add the warning in `rewriteMember` in `src/class-rewriter.ts`**

Inside `rewriteMember`, after the `isMethodDeclaration` branch and before the `isConstructorDeclaration` branch, add a contract-tag check on the constructor. The existing `isConstructorDeclaration` branch only fires when `effectiveInvariants.length > 0`; the new check must fire unconditionally:

```typescript
  if (typescript.isConstructorDeclaration(member)) {
    const constructorTags = extractContractTagsFromNode(member);
    if (constructorTags.length > 0) {
      warn(
        `[axiom] Warning: @pre/@post on constructors is not supported`
        + ` — use @invariant on the class or call pre()/post() manually`
        + ` inside the constructor body (in ${className}.constructor)`,
      );
    }
    if (effectiveInvariants.length > 0) {
      return { element: rewriteConstructor(factory, member, className), changed: true };
    }
    return { element: member, changed: false };
  }
```

This replaces the existing `if (typescript.isConstructorDeclaration(member) && effectiveInvariants.length > 0)` branch.

- [ ] **Step 5: Run the tests**

```
npx jest --testPathPattern="transformer" -t "@pre/@post on constructor" --no-coverage
```

Expected: all four PASSes.

- [ ] **Step 6: Run the full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```
git add src/class-rewriter.ts test/transformer.test.ts
git commit -m "feat: warn when @pre/@post is placed on a constructor"
```

---

## Task 2: `@pre`/`@post` on an arrow function or function expression

**Files:**
- Modify: `src/transformer.ts` — `visitNode`, add `resolveDisplayName` helper
- Test: `test/transformer.test.ts`

**Warning message:**
```
[axiom] Warning: @pre/@post on arrow functions, function expressions, and closures is not supported — contracts were not injected (in foo)
```

- [ ] **Step 1: Write the failing tests**

Add to `test/transformer.test.ts`:

```typescript
describe('@pre/@post on arrow function or function expression', () => {
  it('warns when named arrow function has @pre tag', () => {
    const source = `
      const foo = /** @pre x > 0 */ (x: number): number => x + 1;
    `;
    const warnings: string[] = [];
    transpileWithWarn(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes('arrow functions') && w.includes('foo')),
    ).toBe(true);
  });

  it('warns when named function expression has @post tag', () => {
    const source = `
      const bar = /** @post result > 0 */ function(x: number): number { return x; };
    `;
    const warnings: string[] = [];
    transpileWithWarn(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes('function expressions') && w.includes('bar')),
    ).toBe(true);
  });

  it('warns with (anonymous) for anonymous IIFE', () => {
    const source = `
      (/** @pre x > 0 */ (x: number): number => x)();
    `;
    const warnings: string[] = [];
    transpileWithWarn(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes('arrow functions') && w.includes('(anonymous)')),
    ).toBe(true);
  });

  it('does not warn for named exported function declaration with @pre', () => {
    const source = `
      /** @pre x > 0 */
      export function add(x: number): number { return x + 1; }
    `;
    const warnings: string[] = [];
    transpileWithWarn(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes('arrow functions'))).toBe(false);
    expect(warnings.some((w) => w.includes('function expressions'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm failures**

```
npx jest --testPathPattern="transformer" -t "@pre/@post on arrow function or function expression" --no-coverage
```

Expected: first three FAILs, fourth PASS.

- [ ] **Step 3: Import `extractContractTagsFromNode` in `src/transformer.ts`**

Add a direct import at the top of `src/transformer.ts`:

```typescript
import { extractContractTagsFromNode } from './jsdoc-parser';
```

- [ ] **Step 4: Add the `resolveDisplayName` helper in `src/transformer.ts`**

Add above `visitNode`:

```typescript
function resolveDisplayName(node: typescript.Node): string {
  if (
    typescript.isVariableDeclaration(node.parent) &&
    typescript.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  return '(anonymous)';
}
```

- [ ] **Step 5: Add detection branches in `visitNode` in `src/transformer.ts`**

After the `isFunctionDeclaration` + `isPublicTarget` branch and before `visitEachChild`, add:

```typescript
  if (typescript.isArrowFunction(node) || typescript.isFunctionExpression(node)) {
    const contractTags = extractContractTagsFromNode(node);
    if (contractTags.length > 0) {
      const displayName = resolveDisplayName(node);
      const kind = typescript.isArrowFunction(node) ? 'arrow functions' : 'function expressions';
      warn(
        `[axiom] Warning: @pre/@post on ${kind}, function expressions, and closures`
        + ` is not supported — contracts were not injected (in ${displayName})`,
      );
    }
  }
```

Note: for arrow functions the message says "arrow functions, function expressions, and closures" in full (matching the spec). For function expressions it would read slightly redundantly but that mirrors the spec's intended single message. Alternatively, use the unified message verbatim for both:

```typescript
  if (typescript.isArrowFunction(node) || typescript.isFunctionExpression(node)) {
    const contractTags = extractContractTagsFromNode(node);
    if (contractTags.length > 0) {
      const displayName = resolveDisplayName(node);
      warn(
        '[axiom] Warning: @pre/@post on arrow functions, function expressions, and closures'
        + ` is not supported — contracts were not injected (in ${displayName})`,
      );
    }
  }
```

This placement ensures the node still falls through to `visitEachChild` so nested supported nodes continue to be processed.

- [ ] **Step 6: Run the tests**

```
npx jest --testPathPattern="transformer" -t "@pre/@post on arrow function or function expression" --no-coverage
```

Expected: all four PASSes.

- [ ] **Step 7: Run the full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```
git add src/transformer.ts test/transformer.test.ts
git commit -m "feat: warn when @pre/@post is placed on arrow functions or function expressions"
```

---

## Task 3: `@pre`/`@post` on a nested or non-exported function declaration

**Files:**
- Modify: `src/transformer.ts` — `visitNode`
- Test: `test/transformer.test.ts`

**Warning message:**
```
[axiom] Warning: @pre/@post on arrow functions, function expressions, and closures is not supported — contracts were not injected (in foo)
```
(same message as Task 2 — non-exported function declarations share the unsupported-closure category)

- [ ] **Step 1: Write the failing tests**

Add to `test/transformer.test.ts`:

```typescript
describe('@pre/@post on nested or non-exported function declaration', () => {
  it('warns for unexported top-level function with @pre', () => {
    const source = `
      /** @pre x > 0 */
      function helper(x: number): number { return x; }
    `;
    const warnings: string[] = [];
    transpileWithWarn(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes('closures') && w.includes('helper')),
    ).toBe(true);
  });

  it('warns for function declaration nested inside another function', () => {
    const source = `
      export function outer(x: number): number {
        /** @pre x > 0 */
        function inner(x: number): number { return x; }
        return inner(x);
      }
    `;
    const warnings: string[] = [];
    transpileWithWarn(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes('closures') && w.includes('inner')),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm failures**

```
npx jest --testPathPattern="transformer" -t "@pre/@post on nested or non-exported function declaration" --no-coverage
```

Expected: both FAILs.

- [ ] **Step 3: Add detection for non-public `FunctionDeclaration` in `visitNode` in `src/transformer.ts`**

The existing `isFunctionDeclaration` branch only fires when `isPublicTarget` returns `true`. Add a parallel branch immediately after it for the non-public case. The node still falls through to `visitEachChild` so nested nodes are visited:

```typescript
  if (
    typescript.isFunctionDeclaration(node) &&
    !isPublicTarget(node as typescript.FunctionLikeDeclaration)
  ) {
    const contractTags = extractContractTagsFromNode(node);
    if (contractTags.length > 0) {
      const funcName = (node as typescript.FunctionDeclaration).name?.text ?? '(anonymous)';
      warn(
        '[axiom] Warning: @pre/@post on arrow functions, function expressions, and closures'
        + ` is not supported — contracts were not injected (in ${funcName})`,
      );
    }
  }
```

Place this block between the public-target `isFunctionDeclaration` branch and the `visitEachChild` return, so control always falls to `visitEachChild` and descends into the function body.

- [ ] **Step 4: Run the tests**

```
npx jest --testPathPattern="transformer" -t "@pre/@post on nested or non-exported function declaration" --no-coverage
```

Expected: both PASSes.

- [ ] **Step 5: Run the full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```
git add src/transformer.ts test/transformer.test.ts
git commit -m "feat: warn when @pre/@post is placed on non-exported or nested function declarations"
```

---

## Task 4: `@pre`/`@post` on a class body (not on a method)

**Files:**
- Modify: `src/class-rewriter.ts` — `rewriteClass`
- Test: `test/transformer.test.ts`

**Warning message:**
```
[axiom] Warning: @pre/@post on a class declaration is not supported — annotate individual methods instead (in ClassName)
```

- [ ] **Step 1: Write the failing tests**

Add to `test/transformer.test.ts`:

```typescript
describe('@pre/@post on a class body', () => {
  it('warns when @pre JSDoc is on the class declaration itself', () => {
    const source = `
      /** @pre this.x > 0 */
      export class Widget {
        constructor(public x: number) {}
      }
    `;
    const warnings: string[] = [];
    transpileWithWarn(source, (msg) => warnings.push(msg));
    expect(
      warnings.some(
        (w) => w.includes('class declaration is not supported') && w.includes('Widget'),
      ),
    ).toBe(true);
  });

  it('class-level warning emitted AND method contracts injected normally', () => {
    const source = `
      /** @pre this.x > 0 */
      export class Dual {
        constructor(public x: number) {}
        /** @pre val > 0 */
        set(val: number): void { this.x = val; }
      }
    `;
    const warnings: string[] = [];
    const output = transpileWithWarn(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes('class declaration is not supported') && w.includes('Dual')),
    ).toBe(true);
    expect(output).toContain('pre(');
  });
});
```

- [ ] **Step 2: Run to confirm failures**

```
npx jest --testPathPattern="transformer" -t "@pre/@post on a class body" --no-coverage
```

Expected: both FAILs.

- [ ] **Step 3: Add the class-body check in `rewriteClass` in `src/class-rewriter.ts`**

After computing `className` and before the `interfaceContracts` resolution, add:

```typescript
  const classContractTags = extractContractTagsFromNode(node);
  const reparsedClass = reparsedIndex.classes.get(node.pos) ?? node;
  const reparsedClassContractTags = extractContractTagsFromNode(reparsedClass);
  if (classContractTags.length > 0 || reparsedClassContractTags.length > 0) {
    warn(
      `[axiom] Warning: @pre/@post on a class declaration is not supported`
      + ` — annotate individual methods instead (in ${className})`,
    );
  }
```

Note: `reparsedClass` is also computed later in the original function; to avoid computing it twice, move the `reparsedClass` assignment to just after `className` is resolved, before `interfaceContracts` resolution. The existing `const reparsedClass = reparsedIndex.classes.get(node.pos) ?? node;` line later in the function should be removed to avoid a redeclaration.

- [ ] **Step 4: Run the tests**

```
npx jest --testPathPattern="transformer" -t "@pre/@post on a class body" --no-coverage
```

Expected: both PASSes.

- [ ] **Step 5: Run the full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```
git add src/class-rewriter.ts test/transformer.test.ts
git commit -m "feat: warn when @pre/@post is placed on a class declaration instead of a method"
```

---

## Task 5: `@invariant` on a non-class node

**Files:**
- Modify: `src/transformer.ts` — `visitNode`
- Test: `test/transformer.test.ts`

**Warning message:**
```
[axiom] Warning: @invariant is only supported on class declarations — tag has no effect (in foo)
```

- [ ] **Step 1: Write the failing tests**

Add to `test/transformer.test.ts`:

```typescript
describe('@invariant on a non-class node', () => {
  it('warns when exported function has @invariant tag', () => {
    const source = `
      /** @invariant x > 0 */
      export function process(x: number): number { return x; }
    `;
    const warnings: string[] = [];
    transpileWithWarn(source, (msg) => warnings.push(msg));
    expect(
      warnings.some(
        (w) => w.includes('only supported on class declarations') && w.includes('process'),
      ),
    ).toBe(true);
  });

  it('warns when variable statement has @invariant tag', () => {
    const source = `
      /** @invariant x > 0 */
      const value = 5;
    `;
    const warnings: string[] = [];
    transpileWithWarn(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes('only supported on class declarations')),
    ).toBe(true);
  });

  it('warns when interface has @invariant tag', () => {
    const source = `
      /** @invariant true */
      interface Shape { area(): number; }
    `;
    const warnings: string[] = [];
    transpileWithWarn(source, (msg) => warnings.push(msg));
    expect(
      warnings.some(
        (w) => w.includes('only supported on class declarations') && w.includes('Shape'),
      ),
    ).toBe(true);
  });

  it('does not warn for valid @invariant on a class', () => {
    const source = `
      /** @invariant this.x > 0 */
      export class Good {
        constructor(public x: number) {}
      }
    `;
    const warnings: string[] = [];
    transpileWithWarn(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes('only supported on class declarations'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm failures**

```
npx jest --testPathPattern="transformer" -t "@invariant on a non-class node" --no-coverage
```

Expected: first three FAILs, fourth PASS.

- [ ] **Step 3: Import `extractInvariantExpressions` directly in `src/transformer.ts`**

Update the import from `./jsdoc-parser`:

```typescript
import { extractContractTagsFromNode, extractInvariantExpressions } from './jsdoc-parser';
```

- [ ] **Step 4: Add an `extractNodeName` helper in `src/transformer.ts`**

Add alongside `resolveDisplayName` (above `visitNode`):

```typescript
function extractNodeName(node: typescript.Node): string {
  if (
    typescript.isFunctionDeclaration(node) ||
    typescript.isInterfaceDeclaration(node) ||
    typescript.isClassDeclaration(node)
  ) {
    return (node as { name?: typescript.Identifier }).name?.text ?? '(anonymous)';
  }
  if (typescript.isVariableStatement(node)) {
    const firstDecl = node.declarationList.declarations[0];
    if (firstDecl && typescript.isIdentifier(firstDecl.name)) {
      return firstDecl.name.text;
    }
  }
  return '(anonymous)';
}
```

- [ ] **Step 5: Add `@invariant`-on-non-class detection in `visitNode` in `src/transformer.ts`**

Add a check at the top of `visitNode`, immediately after the `isClassDeclaration` branch (which already handles the supported case) and before the `isFunctionDeclaration` branch:

```typescript
  if (!typescript.isClassDeclaration(node)) {
    const invariantExprs = extractInvariantExpressions(node);
    if (invariantExprs.length > 0) {
      const nodeName = extractNodeName(node);
      warn(
        '[axiom] Warning: @invariant is only supported on class declarations'
        + ` — tag has no effect (in ${nodeName})`,
      );
    }
  }
```

Place this after the existing `isClassDeclaration` branch so that valid class invariants never trigger the warning. The check applies to every non-class node; it fires before any further branching and control continues to the existing `isFunctionDeclaration` branch and the `visitEachChild` fallthrough unchanged.

- [ ] **Step 6: Run the tests**

```
npx jest --testPathPattern="transformer" -t "@invariant on a non-class node" --no-coverage
```

Expected: all four PASSes.

- [ ] **Step 7: Run the full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```
git add src/transformer.ts test/transformer.test.ts
git commit -m "feat: warn when @invariant is placed on a non-class node"
```

---

## Final verification

- [ ] **Run the full suite one last time**

```
npm test
```

Expected: all tests pass, coverage thresholds met.

- [ ] **Run lint**

```
npm run lint
```

Expected: no errors.

- [ ] **Run typecheck**

```
npm run typecheck
```

Expected: no errors.

---

## Acceptance Checklist

The following items should be verified manually by a QA/acceptance tester in a consuming project or via the local Verdaccio registry:

- A class whose constructor carries `/** @pre x > 0 */` compiles without error; a warning message containing `constructors is not supported` and the class name appears on stderr (or the configured `warn` callback). No contract guards appear inside the constructor body.
- A class whose constructor carries `/** @post result !== null */` similarly emits a warning and injects no contract. If the class also has a valid `@invariant`, the invariant check IS injected into the constructor; the `@post` warning is still emitted.
- A `const foo = /** @pre x > 0 */ (x: number) => x + 1;` arrow function compiles without error; a warning containing `arrow functions` and `foo` appears. The compiled output is identical to the same code without the JSDoc tag.
- A `const bar = /** @post result > 0 */ function(x: number) { return x; };` function expression compiles without error; a warning containing `function expressions` and `bar` appears.
- An anonymous arrow IIFE `(/** @pre x > 0 */ (x: number) => x)()` emits a warning containing `(anonymous)`.
- An unexported top-level `/** @pre x > 0 */ function helper(x: number) {}` emits a warning containing `closures` and `helper`.
- A `FunctionDeclaration` nested inside another function body with `@pre` emits a warning containing `closures` and the inner function name.
- A class with `/** @pre this.x > 0 */` on the class declaration itself (not on any method) emits a warning containing `class declaration is not supported` and the class name. No contracts are injected anywhere in that class due to the class-level tag.
- When the same class also has a method with a valid `/** @pre val > 0 */` tag, the method contract IS injected normally and the class-level warning is still emitted (two independent outcomes, no interference).
- An exported function with a `/** @invariant x > 0 */` JSDoc tag emits a warning containing `only supported on class declarations` and the function name. No invariant injection occurs.
- A variable declaration with `/** @invariant ... */` emits the non-class invariant warning.
- An `interface` with `/** @invariant true */` emits the non-class invariant warning.
- A class with a valid `/** @invariant this.x > 0 */` tag does NOT emit the non-class invariant warning; the invariant is injected as usual.
- A supported exported method with valid `@pre`/`@post` and a class with a valid `@invariant` produce no misuse warnings at all (regression check).
- All five warning message texts match the exact format specified in the design doc (prefix `[axiom] Warning:`, correct phrasing, correct location in parentheses).
