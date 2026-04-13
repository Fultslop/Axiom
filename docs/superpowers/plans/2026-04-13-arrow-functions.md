# Arrow Functions and Function Expressions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the transformer so that `@pre`/`@post` tags on exported `const` arrow functions and function expressions are recognised, validated, and injected — matching the behaviour already in place for `FunctionDeclaration` and `MethodDeclaration`.

**Architecture:** Five files change. `src/transformer.ts` gains a `VariableStatement` branch in `visitNode` that iterates exported `const` declarations and attempts a rewrite for each `ArrowFunction` or `FunctionExpression` initialiser. `src/function-rewriter.ts` gains a `normaliseArrowBody` helper that converts expression-body arrows to block bodies, and `applyNewBody` gains two new cases for `ArrowFunction` and `FunctionExpression`. `src/node-helpers.ts` extends `buildLocationName` to resolve the variable name from the enclosing `VariableDeclaration`, and adds a new `isExportedVariableInitialiser` predicate. `src/jsdoc-parser.ts` adds `extractContractTagsForFunctionLike` that falls back to the parent `VariableStatement` when `getJSDocTags` on the function node itself yields no tags. No changes are needed in `src/reparsed-index.ts`, `src/ast-builder.ts`, `src/contract-validator.ts`, or `src/type-helpers.ts`.

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
| `src/transformer.ts` | Add `VariableStatement` branch in `visitNode`; iterate declarations, normalise arrow bodies, attempt rewrite, reconstruct updated `VariableStatement` |
| `src/function-rewriter.ts` | Export `normaliseArrowBody` helper; extend `applyNewBody` with `ArrowFunction` and `FunctionExpression` cases |
| `src/node-helpers.ts` | Extend `buildLocationName` with parent-walk for `ArrowFunction`/`FunctionExpression`; add exported `isExportedVariableInitialiser` helper |
| `src/jsdoc-parser.ts` | Add `extractContractTagsForFunctionLike` that falls back to the parent `VariableStatement`; update `extractContractTags` to call it |
| `test/transformer.test.ts` | New describe blocks for all arrow-function/function-expression cases |

---

## Task 1: `isExportedVariableInitialiser` and extended `buildLocationName` in `node-helpers.ts`

**Files:**
- Modify: `src/node-helpers.ts`
- Test: `test/transformer.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/transformer.test.ts` (uses the low-level `buildLocationName` import, or exercises location strings via end-to-end output):

```typescript
describe('buildLocationName for arrow and function expressions', () => {
  it('returns variable name for arrow function assigned to exported const', () => {
    // End-to-end: error message location should use the variable name.
    const source = `
      export const validate = /** @pre x > 0 */ (x: number): boolean => x > 0;
    `;
    let output = '';
    transform(source); // transpileModule path
    // The location check is covered by the ContractError message in Task 3.
    // Here we verify no throw and no warning for valid input.
    expect(() => transform(source)).not.toThrow();
  });
});
```

Note: the location-string assertion is more naturally verified in Task 3 as part of the full injection tests. This step exists to confirm `node-helpers.ts` exports compile correctly after the changes.

- [ ] **Step 2: Add `isExportedVariableInitialiser` to `src/node-helpers.ts`**

Add after `isPublicTarget`:

```typescript
export function isExportedVariableInitialiser(
  node: typescript.FunctionLikeDeclaration,
): boolean {
  if (
    !typescript.isArrowFunction(node) &&
    !typescript.isFunctionExpression(node)
  ) {
    return false;
  }
  const varDecl = node.parent;
  if (!typescript.isVariableDeclaration(varDecl)) {
    return false;
  }
  const varDeclList = varDecl.parent;
  if (!typescript.isVariableDeclarationList(varDeclList)) {
    return false;
  }
  const varStmt = varDeclList.parent;
  if (!typescript.isVariableStatement(varStmt)) {
    return false;
  }
  const modifiers = typescript.canHaveModifiers(varStmt)
    ? typescript.getModifiers(varStmt) ?? []
    : [];
  return modifiers.some((mod) => mod.kind === typescript.SyntaxKind.ExportKeyword);
}
```

- [ ] **Step 3: Extend `buildLocationName` in `src/node-helpers.ts`**

Add two new cases before the final `return 'anonymous'` fallback:

```typescript
  if (
    (typescript.isArrowFunction(node) || typescript.isFunctionExpression(node)) &&
    typescript.isVariableDeclaration(node.parent) &&
    typescript.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  if (typescript.isFunctionExpression(node) && node.name !== undefined) {
    return node.name.text;
  }
```

- [ ] **Step 4: Run lint and typecheck**

```
npm run lint && npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Run full suite**

```
npm test
```

Expected: all existing tests pass; no regressions.

---

## Task 2: JSDoc fallback in `jsdoc-parser.ts`

**Files:**
- Modify: `src/jsdoc-parser.ts`
- Test: `test/transformer.test.ts` (covered in Task 3 end-to-end)

The TypeScript compiler does not propagate JSDoc from a `VariableStatement` to its inner `ArrowFunction` or `FunctionExpression` node when `getJSDocTags` is called on the function node directly. This task adds the fallback lookup.

- [ ] **Step 1: Add `extractContractTagsForFunctionLike` to `src/jsdoc-parser.ts`**

Add after `extractContractTags`:

```typescript
export function extractContractTagsForFunctionLike(
  node: typescript.FunctionLikeDeclaration,
): ContractTag[] {
  const direct = extractContractTagsFromNode(node);
  if (direct.length > 0) {
    return direct;
  }
  // For ArrowFunction / FunctionExpression the JSDoc comment is attached to
  // the enclosing VariableStatement, not to the function node itself.
  if (
    (typescript.isArrowFunction(node) || typescript.isFunctionExpression(node)) &&
    typescript.isVariableDeclaration(node.parent) &&
    typescript.isVariableDeclarationList(node.parent.parent) &&
    typescript.isVariableStatement(node.parent.parent.parent)
  ) {
    return extractContractTagsFromNode(node.parent.parent.parent);
  }
  return [];
}
```

- [ ] **Step 2: Update `extractContractTags` to delegate to the new helper**

Replace the body of `extractContractTags`:

```typescript
export function extractContractTags(
  node: typescript.FunctionLikeDeclaration,
): ContractTag[] {
  return extractContractTagsForFunctionLike(node);
}
```

- [ ] **Step 3: Run lint and typecheck**

```
npm run lint && npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Run full suite**

```
npm test
```

Expected: all existing tests pass; no regressions.

---

## Task 3: `normaliseArrowBody` and extended `applyNewBody` in `function-rewriter.ts`

**Files:**
- Modify: `src/function-rewriter.ts`
- Test: `test/transformer.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/transformer.test.ts`:

```typescript
describe('arrow function with expression body (@pre)', () => {
  it('injects @pre check and throws ContractError on violation', () => {
    const source = `
      export const double = /** @pre x > 0 */ (x: number): number => x * 2;
    `;
    const compiled = transform(source);
    const fn = loadFunction<(x: number) => number>(compiled, 'double');
    expect(() => fn(-1)).toThrow();
    expect(fn(2)).toBe(4);
  });
});

describe('arrow function with block body (@pre)', () => {
  it('injects @pre check into block-body arrow', () => {
    const source = `
      export const clamp = /** @pre min <= max */
        (num: number, min: number, max: number): number => {
          return Math.min(Math.max(num, min), max);
        };
    `;
    const compiled = transform(source);
    const fn = loadFunction<(num: number, min: number, max: number) => number>(compiled, 'clamp');
    expect(() => fn(5, 10, 1)).toThrow();
    expect(fn(5, 1, 10)).toBe(5);
  });
});

describe('function expression (@pre)', () => {
  it('injects @pre check into exported function expression', () => {
    const source = `
      export const trim = /** @pre input.length > 0 */ function(input: string): string {
        return input.trim();
      };
    `;
    const compiled = transform(source);
    const fn = loadFunction<(input: string) => string>(compiled, 'trim');
    expect(() => fn('')).toThrow();
    expect(fn('  hello  ')).toBe('hello');
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

```
npx jest --testPathPattern="transformer" -t "arrow function|function expression" --no-coverage
```

Expected: all three FAILs (contracts not injected yet).

- [ ] **Step 3: Add `normaliseArrowBody` to `src/function-rewriter.ts`**

Add before `rewriteFunction`:

```typescript
export function normaliseArrowBody(
  factory: typescript.NodeFactory,
  node: typescript.ArrowFunction,
): typescript.ArrowFunction {
  if (typescript.isBlock(node.body)) {
    return node;
  }
  const returnStmt = factory.createReturnStatement(
    node.body as typescript.Expression,
  );
  const block = factory.createBlock([returnStmt], /* multiLine */ true);
  return factory.updateArrowFunction(
    node,
    typescript.getModifiers(node),
    node.typeParameters,
    node.parameters,
    node.type,
    node.equalsGreaterThanToken,
    block,
  );
}
```

- [ ] **Step 4: Extend `applyNewBody` in `src/function-rewriter.ts`**

Add two new cases inside `applyNewBody` before the final `return null`:

```typescript
  if (typescript.isArrowFunction(node)) {
    return factory.updateArrowFunction(
      node,
      typescript.getModifiers(node),
      node.typeParameters,
      node.parameters,
      node.type,
      node.equalsGreaterThanToken,
      newBody,
    );
  }
  if (typescript.isFunctionExpression(node)) {
    return factory.updateFunctionExpression(
      node,
      typescript.getModifiers(node),
      node.asteriskToken,
      node.name,
      node.typeParameters,
      node.parameters,
      node.type,
      newBody,
    );
  }
```

- [ ] **Step 5: Run failing tests — expect them still to fail (transformer dispatch not wired yet)**

```
npx jest --testPathPattern="transformer" -t "arrow function|function expression" --no-coverage
```

Expected: still FAILs. The `applyNewBody` and `normaliseArrowBody` helpers are ready but `visitNode` does not yet call them.

- [ ] **Step 6: Run lint and typecheck**

```
npm run lint && npm run typecheck
```

Expected: no errors.

---

## Task 4: `VariableStatement` branch in `transformer.ts`

**Files:**
- Modify: `src/transformer.ts`
- Test: `test/transformer.test.ts`

This task wires up the new dispatch so the tests from Task 3 start passing.

- [ ] **Step 1: Add import for `normaliseArrowBody` and `isExportedVariableInitialiser` in `src/transformer.ts`**

Update the import from `function-rewriter`:

```typescript
import {
  tryRewriteFunction, isPublicTarget, normaliseArrowBody,
} from './function-rewriter';
```

Update the import from `node-helpers`:

```typescript
import { isExportedVariableInitialiser } from './node-helpers';
```

- [ ] **Step 2: Add a `rewriteVariableDeclaration` helper in `src/transformer.ts`**

Add before `visitNode`:

```typescript
function rewriteVariableDeclaration(
  factory: typescript.NodeFactory,
  decl: typescript.VariableDeclaration,
  reparsedIndex: ReparsedIndex,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker: typescript.TypeChecker | undefined,
  allowIdentifiers: string[],
): typescript.VariableDeclaration {
  const init = decl.initializer;
  if (init === undefined) {
    return decl;
  }
  let funcNode: typescript.FunctionLikeDeclaration | undefined;
  if (typescript.isArrowFunction(init)) {
    funcNode = normaliseArrowBody(factory, init);
  } else if (typescript.isFunctionExpression(init)) {
    funcNode = init;
  }
  if (funcNode === undefined || !isExportedVariableInitialiser(funcNode)) {
    return decl;
  }
  const rewritten = tryRewriteFunction(
    factory,
    funcNode,
    reparsedIndex.functions,
    transformed,
    warn,
    checker,
    [],
    undefined,
    allowIdentifiers,
  );
  if (rewritten === funcNode) {
    return decl;
  }
  return factory.updateVariableDeclaration(
    decl,
    decl.name,
    decl.exclamationToken,
    decl.type,
    rewritten as typescript.Expression,
  );
}
```

- [ ] **Step 3: Add a `visitVariableStatement` helper in `src/transformer.ts`**

Add after `rewriteVariableDeclaration`:

```typescript
function visitVariableStatement(
  factory: typescript.NodeFactory,
  node: typescript.VariableStatement,
  reparsedIndex: ReparsedIndex,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker: typescript.TypeChecker | undefined,
  allowIdentifiers: string[],
): typescript.VariableStatement {
  const modifiers = typescript.canHaveModifiers(node)
    ? typescript.getModifiers(node) ?? []
    : [];
  const isExported = modifiers.some(
    (mod) => mod.kind === typescript.SyntaxKind.ExportKeyword,
  );
  if (!isExported) {
    return node;
  }
  const newDeclarations = node.declarationList.declarations.map((decl) =>
    rewriteVariableDeclaration(
      factory, decl, reparsedIndex, transformed, warn, checker, allowIdentifiers,
    ),
  );
  const changed = newDeclarations.some(
    (decl, idx) => decl !== node.declarationList.declarations[idx],
  );
  if (!changed) {
    return node;
  }
  const newDeclList = factory.updateVariableDeclarationList(
    node.declarationList,
    newDeclarations,
  );
  return factory.updateVariableStatement(node, modifiers, newDeclList);
}
```

- [ ] **Step 4: Add the `VariableStatement` branch to `visitNode` in `src/transformer.ts`**

Insert before the `return typescript.visitEachChild(...)` call:

```typescript
  if (typescript.isVariableStatement(node)) {
    return visitVariableStatement(
      factory,
      node as typescript.VariableStatement,
      reparsedIndex,
      transformed,
      warn,
      checker,
      allowIdentifiers,
    );
  }
```

- [ ] **Step 5: Run the failing tests from Task 3**

```
npx jest --testPathPattern="transformer" -t "arrow function|function expression" --no-coverage
```

Expected: all three now PASS.

- [ ] **Step 6: Run full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 7: Run lint and typecheck**

```
npm run lint && npm run typecheck
```

Expected: no errors.

- [ ] **Step 8: Commit**

```
git add src/transformer.ts src/function-rewriter.ts src/node-helpers.ts src/jsdoc-parser.ts test/transformer.test.ts
git commit -m "feat: inject @pre/@post contracts on exported const arrow and function expressions"
```

---

## Task 5: Location string uses variable name

**Files:**
- Test: `test/transformer.test.ts`

The `buildLocationName` changes from Task 1 should already cause the error message to use the variable name. This task adds an explicit assertion.

- [ ] **Step 1: Write the test**

```typescript
describe('location string for arrow function', () => {
  it('uses the variable name in the ContractError message', () => {
    const source = `
      export const validate = /** @pre x > 0 */ (x: number): boolean => x > 0;
    `;
    const compiled = transform(source);
    const fn = loadFunction<(x: number) => boolean>(compiled, 'validate');
    let message = '';
    try {
      fn(-1);
    } catch (err: unknown) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('validate');
    expect(message).not.toContain('anonymous');
  });
});
```

- [ ] **Step 2: Run the test**

```
npx jest --testPathPattern="transformer" -t "location string for arrow function" --no-coverage
```

Expected: PASS (covered by Task 1 + Task 4).

If it fails, verify that `buildLocationName` is receiving the function node with its parent set correctly after normalisation. When `normaliseArrowBody` returns a new `ArrowFunction`, the parent pointers are synthesised and may not match; pass the original `init` node to `tryRewriteFunction` for location resolution while using the normalised node for body rewriting. Adjust `rewriteVariableDeclaration` accordingly.

- [ ] **Step 3: Run full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```
git add test/transformer.test.ts
git commit -m "test: assert location string uses variable name for arrow function contracts"
```

---

## Task 6: Remaining spec test cases

**Files:**
- Test: `test/transformer.test.ts`

Cover all remaining cases from section 6 of the spec.

- [ ] **Step 1: Write the tests**

```typescript
describe('arrow function @post with result', () => {
  it('injects @post result check (expression body)', () => {
    const source = `
      export const abs = /** @post result >= 0 */ (x: number): number => Math.abs(x);
    `;
    const compiled = transform(source);
    const fn = loadFunction<(x: number) => number>(compiled, 'abs');
    expect(fn(-3)).toBe(3);
    expect(fn(3)).toBe(3);
  });

  it('warns and drops @post result when no return type annotation', () => {
    const source = `
      export const broken = /** @post result > 0 */ (x: number) => x;
    `;
    const warnings: string[] = [];
    transform(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes('result') && w.includes('@post dropped')),
    ).toBe(true);
  });
});

describe('named function expression', () => {
  it('injects @pre and uses variable name (not function name) in location', () => {
    const source = `
      export const factorial =
        /** @pre num >= 0 */ function fact(num: number): number {
          return num <= 1 ? 1 : num * fact(num - 1);
        };
    `;
    const compiled = transform(source);
    const fn = loadFunction<(num: number) => number>(compiled, 'factorial');
    expect(() => fn(-1)).toThrow();
    let message = '';
    try { fn(-1); } catch (err: unknown) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('factorial');
    expect(fn(5)).toBe(120);
  });
});

describe('non-exported arrow function — no injection', () => {
  it('leaves non-exported arrow unchanged and emits no warning', () => {
    const source = `
      const internal = /** @pre x > 0 */ (x: number): number => x;
    `;
    const warnings: string[] = [];
    const compiled = transform(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
    // No require injection means the output does not contain the contract runtime import.
    expect(compiled).not.toContain('require(');
  });
});

describe('arrow with no tags — no injection', () => {
  it('does not inject require when no @pre/@post present', () => {
    const source = `
      export const noop = (x: number): number => x;
    `;
    const compiled = transform(source);
    expect(compiled).not.toContain('require(');
  });
});

describe('multiple contracts on one arrow', () => {
  it('injects both @pre and @post', () => {
    const source = `
      export const divide =
        /** @pre denominator !== 0 @post result !== Infinity */
        (numerator: number, denominator: number): number => numerator / denominator;
    `;
    const compiled = transform(source);
    const fn = loadFunction<(numerator: number, denominator: number) => number>(compiled, 'divide');
    expect(() => fn(1, 0)).toThrow();
    expect(fn(10, 2)).toBe(5);
  });
});

describe('unknown identifier in @pre on arrow — warning, tag dropped', () => {
  it('warns and drops the @pre tag', () => {
    const source = `
      export const foo = /** @pre ghost > 0 */ (x: number): number => x;
    `;
    const warnings: string[] = [];
    transform(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes('ghost'))).toBe(true);
  });
});

describe('VariableStatement with multiple declarations', () => {
  it('only rewrites the annotated declaration', () => {
    const source = `
      export const alpha = 1,
        validate = /** @pre x > 0 */ (x: number): boolean => x > 0;
    `;
    const compiled = transform(source);
    expect(compiled).toContain('alpha');
    const fn = loadFunction<(x: number) => boolean>(compiled, 'validate');
    expect(() => fn(-1)).toThrow();
    expect(fn(1)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the new tests**

```
npx jest --testPathPattern="transformer" -t "@post with result|named function expression|non-exported|no tags|multiple contracts|unknown identifier|multiple declarations" --no-coverage
```

Expected: all PASS. If any fail, debug per the spec section 4 guidance.

- [ ] **Step 3: Run full suite with coverage**

```
npm run test:coverage
```

Expected: all tests pass; coverage remains above 80%.

- [ ] **Step 4: Commit**

```
git add test/transformer.test.ts
git commit -m "test: full coverage for arrow function and function expression contract injection"
```

---

## Acceptance Checklist

Human QA steps to verify the feature end-to-end before merging:

- [ ] `export const validate = /** @pre x > 0 */ (x: number): boolean => x > 0` — calling `validate(-1)` throws; calling `validate(1)` returns `true`.
- [ ] Expression-body arrow with `@post result >= 0` — `@post` is injected; result assertion passes for valid inputs.
- [ ] `export const clamp = /** @pre min <= max */ (n, min, max) => { ... }` — block-body arrow with `@pre` injects correctly.
- [ ] `export const trim = /** @pre input.length > 0 */ function(input: string) { ... }` — function expression: `trim('')` throws.
- [ ] Named function expression: `export const factorial = /** @pre n >= 0 */ function fact(n) { ... }` — location string in the error message is `"factorial"`, not `"fact"` or `"anonymous"`.
- [ ] Non-exported `const internal = /** @pre x > 0 */ (x) => x` — no injection, no warning, no `require(...)` in output.
- [ ] `export const noop = (x: number): number => x` (no tags) — output contains no `require(...)`.
- [ ] Arrow with both `@pre denominator !== 0` and `@post result !== Infinity` — both checks injected.
- [ ] Arrow with `@post result > 0` but no return type annotation — warning emitted containing `'result' used but no return type is declared; @post dropped`; no injection.
- [ ] `VariableStatement` with two declarations, only one annotated — only the annotated declaration is rewritten; the other is unchanged.
- [ ] `npm run lint` passes with no errors.
- [ ] `npm run typecheck` passes with no errors.
- [ ] `npm run test:coverage` reports 80%+ coverage and all tests green.
