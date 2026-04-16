# Arrow Functions — Task 3: `normaliseArrowBody` and `applyNewBody` in `function-rewriter.ts`

> **Sequence:** This is step 3 of 6. Tasks 1 and 2 must be complete before starting this task.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

We are adding `@pre`/`@post` contract injection support for exported `const` arrow functions and
function expressions.

**What previous tasks added (already in the codebase):**
- Task 1: `isExportedVariableInitialiser` + extended `buildLocationName` in `src/node-helpers.ts`
- Task 2: `extractContractTagsForFunctionLike` + updated `extractContractTags` in
  `src/jsdoc-parser.ts`

**What this task does:**
- Adds `normaliseArrowBody` — converts expression-body arrows (`=> expr`) to block-body arrows
  (`=> { return expr; }`) so the body-rewriting code has a uniform shape to work with.
- Extends `applyNewBody` with two new cases: `ArrowFunction` and `FunctionExpression`.

**Important:** After this task the tests are written and the helpers exist, but the tests will
still fail because `transformer.ts` does not yet call these helpers. That wiring happens in Task 4.

**Only `src/function-rewriter.ts` and `test/transformer.test.ts` change in this task.**

---

## ESLint constraints (read before touching any `src/` file)

- `id-length: min 3` — no identifiers shorter than 3 characters.
- `complexity: 10` — keep functions small; extract helpers.
- `max-len: 100` — lines under 100 chars.
- No `console` — use the injectable `warn` callback.

---

## Steps

- [ ] **Step 1: Write failing tests in `test/transformer.test.ts`**

Add the following three `describe` blocks:

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

- [ ] **Step 2: Confirm the tests fail**

```
npx jest --testPathPattern="transformer" -t "arrow function|function expression" --no-coverage
```

Expected: all three FAIL (contracts not injected yet — transformer dispatch not wired).

- [ ] **Step 3: Add `normaliseArrowBody` to `src/function-rewriter.ts`**

Add before the `rewriteFunction` function:

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

Inside `applyNewBody`, add two new cases **before** the final `return null`:

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

- [ ] **Step 5: Confirm tests still fail (expected — transformer not wired yet)**

```
npx jest --testPathPattern="transformer" -t "arrow function|function expression" --no-coverage
```

Expected: still FAILs. This is correct — the helpers exist but `visitNode` in `transformer.ts`
does not yet call them. That wiring is Task 4.

- [ ] **Step 6: Run lint and typecheck**

```
npm run lint && npm run typecheck
```

Expected: no errors.

---

## Done when

- `npm run lint && npm run typecheck` exit 0.
- All existing tests pass (`npm test` exits 0, new tests still fail as expected).
- `src/function-rewriter.ts` exports `normaliseArrowBody`.
- `applyNewBody` handles `ArrowFunction` and `FunctionExpression` nodes.
