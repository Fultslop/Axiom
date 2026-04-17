# Async Functions — Task 2: `returnTypeDescription` unwraps `Promise<void|never|undefined>`

> **Sequence:** This is step 2 of 6. Task 1 must be complete before starting this task.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

We are fixing `@post` contracts on `async` functions and async class methods so that the
post-condition check operates on the **resolved** value of the promise, not the `Promise` object
itself.

**What previous tasks added (already in the codebase):**

- Task 1: `isAsyncFunction` helper + `buildBodyCapture` `isAsync` parameter + threading through
  `buildGuardedStatements` in `src/function-rewriter.ts` and `src/ast-builder.ts`.

**What this task does:**

- Adds `resolvePromiseTypeArg` — a file-private helper in `src/function-rewriter.ts` that inspects
  a `TypeNode` and, if it is `Promise<void>`, `Promise<never>`, or `Promise<undefined>`, returns
  the inner keyword kind.
- Updates `returnTypeDescription` to call this helper, so async functions returning those types
  emit a warning and have their `@post result` tags dropped — matching the existing behaviour for
  synchronous `void`/`never`/`undefined` returns.

**Files changed in this task:**

- `src/function-rewriter.ts`
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
describe('async void return type — @post result drop', () => {
  it('warns and drops @post result on async Promise<void> function', () => {
    const source = `
      /**
       * @post result !== undefined
       */
      export async function doWork(): Promise<void> {}
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes("return type is 'void'") && w.includes('@post')),
    ).toBe(true);
  });

  it('warns and drops @post result on async Promise<never> function', () => {
    const source = `
      /**
       * @post result !== null
       */
      export async function fail(): Promise<never> { throw new Error(); }
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes("return type is 'never'") && w.includes('@post')),
    ).toBe(true);
  });

  it('keeps @post result on async Promise<number>', () => {
    const source = `
      /**
       * @post result > 0
       */
      export async function count(): Promise<number> { return Promise.resolve(1); }
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to confirm first two fail**

```
npx jest --testPathPattern="transformer" -t "async void return type" --no-coverage
```

Expected: first two FAILs (no warning emitted), third PASS.

- [ ] **Step 3: Add a `resolvePromiseTypeArg` helper in `src/function-rewriter.ts`**

Add as a file-private helper, placed before `returnTypeDescription`:

```typescript
function resolvePromiseTypeArg(
  typeNode: typescript.TypeNode,
): typescript.SyntaxKind | undefined {
  if (!typescript.isTypeReferenceNode(typeNode)) {
    return undefined;
  }
  const typeName = typescript.isIdentifier(typeNode.typeName)
    ? typeNode.typeName.text
    : undefined;
  if (typeName !== 'Promise') {
    return undefined;
  }
  const args = typeNode.typeArguments;
  if (args === undefined || args.length !== 1) {
    return undefined;
  }
  const inner = args[0].kind;
  if (
    inner === typescript.SyntaxKind.VoidKeyword ||
    inner === typescript.SyntaxKind.NeverKeyword ||
    inner === typescript.SyntaxKind.UndefinedKeyword
  ) {
    return inner;
  }
  return undefined;
}
```

- [ ] **Step 4: Update `returnTypeDescription` to call `resolvePromiseTypeArg`**

Replace the existing `returnTypeDescription` function body with the version below, which adds the
`resolvePromiseTypeArg` check immediately before the final `return RETURN_TYPE_OK`:

```typescript
function returnTypeDescription(node: typescript.FunctionLikeDeclaration): string | undefined {
  const typeNode = node.type;
  if (typeNode === undefined) {
    return undefined;
  }
  if (
    typeNode.kind === typescript.SyntaxKind.VoidKeyword ||
    typeNode.kind === typescript.SyntaxKind.NeverKeyword ||
    typeNode.kind === typescript.SyntaxKind.UndefinedKeyword
  ) {
    return typescript.tokenToString(typeNode.kind) ?? 'void';
  }
  const innerKind = resolvePromiseTypeArg(typeNode);
  if (innerKind !== undefined) {
    return typescript.tokenToString(innerKind) ?? 'void';
  }
  return RETURN_TYPE_OK;
}
```

- [ ] **Step 5: Run the failing tests**

```
npx jest --testPathPattern="transformer" -t "async void return type" --no-coverage
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
- All three `async void return type — @post result drop` tests PASS.
- `async function foo(): Promise<void>` with `@post result` emits a warning containing
  `"return type is 'void'"`.
- `async function foo(): Promise<never>` with `@post result` emits a warning containing
  `"return type is 'never'"`.
- `async function foo(): Promise<number>` with `@post result > 0` emits no warning.
