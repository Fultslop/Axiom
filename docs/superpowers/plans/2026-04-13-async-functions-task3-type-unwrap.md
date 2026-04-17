# Async Functions — Task 3: `buildPostParamTypes` unwraps `Promise<T>` for result type checking

> **Sequence:** This is step 3 of 6. Tasks 1 and 2 must be complete before starting this task.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

We are fixing `@post` contracts on `async` functions and async class methods so that the
post-condition check operates on the **resolved** value of the promise, not the `Promise` object
itself.

**What previous tasks added (already in the codebase):**

- Task 1: `isAsyncFunction` helper + `buildBodyCapture` `isAsync` parameter + threading through
  `buildGuardedStatements`.
- Task 2: `resolvePromiseTypeArg` helper + updated `returnTypeDescription` to drop `@post result`
  with a warning for `Promise<void|never|undefined>` return types.

**What this task does:**

- Adds `unwrapPromiseType` — a file-private helper in `src/type-helpers.ts` that, given a
  `typescript.Type` and a `TypeChecker`, returns the first type argument if the type is a `Promise`,
  otherwise `undefined`.
- Updates `buildPostParamTypes` to call `unwrapPromiseType` on the raw return type before resolving
  the result slot. This means type-mismatch detection for `@post result` compares against `T` (the
  resolved type) rather than `Promise<T>`.

**Files changed in this task:**

- `src/type-helpers.ts`
- `test/transformer.test.ts`

---

## ESLint constraints (read before touching any `src/` file)

- `id-length: min 3` — no identifiers shorter than 3 characters.
- `complexity: 10` — keep functions small; extract helpers.
- `max-len: 100` — lines under 100 chars.
- No `console` — use the injectable `warn` callback.

---

## Steps

- [ ] **Step 1: Write the failing tests**

Add to `test/transformer.test.ts`:

```typescript
describe('async result type mismatch detection', () => {
  it('warns for @post result === "ok" when async return is Promise<number>', () => {
    const source = `
      /**
       * @post result === "ok"
       */
      export async function getCount(): Promise<number> { return Promise.resolve(1); }
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes('type mismatch') && w.includes('result')),
    ).toBe(true);
  });

  it('does not warn for @post result > 0 when async return is Promise<number>', () => {
    const source = `
      /**
       * @post result > 0
       */
      export async function getCount(): Promise<number> { return Promise.resolve(1); }
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
  });

  it('does not warn for @post result !== null when async return is Promise<string>', () => {
    const source = `
      /**
       * @post result !== null
       */
      export async function getName(): Promise<string> { return Promise.resolve(''); }
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to confirm the first test fails**

```
npx jest --testPathPattern="transformer" -t "async result type mismatch detection" --no-coverage
```

Expected: first test FAILs (no warning, because `Promise<number>` resolves to `non-primitive`
rather than `number`), others PASS.

- [ ] **Step 3: Add `unwrapPromiseType` helper to `src/type-helpers.ts`**

Add after `resolveSimpleType`:

```typescript
function unwrapPromiseType(
  returnType: typescript.Type,
  checker: typescript.TypeChecker,
): typescript.Type | undefined {
  /* eslint-disable no-bitwise */
  if (!(returnType.flags & typescript.TypeFlags.Object)) {
    return undefined;
  }
  /* eslint-enable no-bitwise */
  const symbol = returnType.getSymbol();
  if (symbol?.name !== 'Promise') {
    return undefined;
  }
  const typeArgs = checker.getTypeArguments(returnType as typescript.TypeReference);
  if (typeArgs.length !== 1) {
    return undefined;
  }
  return typeArgs[0];
}
```

- [ ] **Step 4: Update `buildPostParamTypes` to use `unwrapPromiseType`**

Replace the `returnType` resolution block inside `buildPostParamTypes` so it calls
`unwrapPromiseType` before resolving the result slot:

```typescript
export function buildPostParamTypes(
  node: typescript.FunctionLikeDeclaration,
  checker: typescript.TypeChecker | undefined,
  base: Map<string, TypeMapValue> | undefined,
): Map<string, TypeMapValue> | undefined {
  if (checker === undefined || base === undefined) {
    return base;
  }
  const sig = checker.getSignatureFromDeclaration(node);
  if (sig === undefined) {
    return base;
  }
  const rawReturn = checker.getReturnTypeOfSignature(sig);
  const resolvedReturn = unwrapPromiseType(rawReturn, checker) ?? rawReturn;
  const resultType = simpleTypeFromFlags(resolvedReturn.flags) ??
    resolveSimpleType(resolvedReturn, checker);
  if (resultType === undefined) {
    return base;
  }
  const extended = new Map(base);
  extended.set('result', resultType);
  return extended;
}
```

- [ ] **Step 5: Run the failing tests**

```
npx jest --testPathPattern="transformer" -t "async result type mismatch detection" --no-coverage
```

Expected: all three PASSes.

- [ ] **Step 6: Run lint and typecheck**

```
npm run lint && npm run typecheck
```

Expected: no errors.

- [ ] **Step 7: Run full suite**

```
npm test
```

Expected: all tests pass, no regressions.

---

## Done when

- `npm run lint && npm run typecheck` exit 0.
- `npm test` exits 0 with no regressions.
- All three `async result type mismatch detection` tests PASS.
- `@post result === "ok"` on a `Promise<number>` function emits a type-mismatch warning.
- `@post result > 0` on a `Promise<number>` function emits no warning.
- `unwrapPromiseType` is a file-private helper in `src/type-helpers.ts`.
