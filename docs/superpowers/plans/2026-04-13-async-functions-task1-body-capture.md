# Async Functions — Task 1: `isAsyncFunction` helper and `buildBodyCapture` async path

> **Sequence:** This is step 1 of 6. No prior tasks required.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

We are fixing `@post` contracts on `async` functions and async class methods so that the
post-condition check operates on the **resolved** value of the promise, not the `Promise` object
itself. Pre-conditions are already correct and remain unchanged.

**What this task does:**

- Adds `isAsyncFunction` — a file-private helper in `src/function-rewriter.ts` that detects the
  `AsyncKeyword` modifier on any `FunctionLikeDeclaration`.
- Extends `buildBodyCapture` in `src/ast-builder.ts` with an `isAsync: boolean` parameter. When
  `true`, the inner IIFE arrow gets an `async` modifier and the call is wrapped in `await`, so the
  captured `result` is the resolved value rather than the `Promise` object.
- Threads `isAsync` through `buildGuardedStatements` down to the `buildBodyCapture` call site.

**Files changed in this task:**

- `src/ast-builder.ts`
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
describe('async function post-condition body capture', () => {
  it('checks resolved value for @post result !== null on async function', async () => {
    const source = `
      interface User { id: number }
      /**
       * @post result !== null
       */
      export async function findUser(id: number): Promise<User | null> {
        return Promise.resolve(null);
      }
    `;
    const warnings: string[] = [];
    const js = transformWithProgram(source, (msg) => warnings.push(msg));
    // The transformed function must be async and await the IIFE
    expect(js).toContain('await');
    expect(js).toContain('async ()');
    // Invoking it should throw because null !== null is false (i.e. result IS null)
    const fn = evalTransformed<() => Promise<unknown>>(js, 'findUser');
    await expect(fn(1)).rejects.toThrow();
  });

  it('does not wrap synchronous function body in await', () => {
    const source = `
      /**
       * @post result > 0
       */
      export function count(): number { return 1; }
    `;
    const warnings: string[] = [];
    const js = transformWithProgram(source, (msg) => warnings.push(msg));
    expect(js).not.toContain('await (async');
  });

  it('@pre fires synchronously before async body', async () => {
    const source = `
      /**
       * @pre id > 0
       */
      export async function findUser(id: number): Promise<void> {
        return Promise.resolve();
      }
    `;
    const warnings: string[] = [];
    const js = transformWithProgram(source, (msg) => warnings.push(msg));
    const fn = evalTransformed<(id: number) => Promise<void>>(js, 'findUser');
    await expect(fn(0)).rejects.toThrow();
    await expect(fn(1)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to confirm failures**

```
npx jest --testPathPattern="transformer" -t "async function post-condition body capture" --no-coverage
```

Expected: first test FAILs (no `await` in output), second and third may PASS.

- [ ] **Step 3: Add `isAsyncFunction` helper to `src/function-rewriter.ts`**

Add as a file-private function after `isStaticMethod`:

```typescript
function isAsyncFunction(node: typescript.FunctionLikeDeclaration): boolean {
  const modifiers = typescript.canHaveModifiers(node)
    ? typescript.getModifiers(node) ?? []
    : [];
  return modifiers.some((mod) => mod.kind === typescript.SyntaxKind.AsyncKeyword);
}
```

- [ ] **Step 4: Update `buildBodyCapture` in `src/ast-builder.ts` to accept `isAsync`**

Change the signature and body:

```typescript
export function buildBodyCapture(
  originalStatements: typescript.NodeArray<typescript.Statement>,
  factory: typescript.NodeFactory = typescript.factory,
  isAsync: boolean = false,
): typescript.VariableStatement {
  const reifiedStatements = Array.from(originalStatements).map(
    (stmt) => reifyStatement(factory, stmt),
  );

  const asyncModifiers = isAsync
    ? [factory.createModifier(typescript.SyntaxKind.AsyncKeyword)]
    : undefined;

  const iife = factory.createCallExpression(
    factory.createArrowFunction(
      asyncModifiers,
      undefined,
      [],
      undefined,
      factory.createToken(typescript.SyntaxKind.EqualsGreaterThanToken),
      factory.createBlock(reifiedStatements, true),
    ),
    undefined,
    [],
  );

  const initialiser: typescript.Expression = isAsync
    ? factory.createAwaitExpression(iife)
    : iife;

  return factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [factory.createVariableDeclaration(
        factory.createIdentifier(AXIOM_RESULT_VAR),
        undefined,
        undefined,
        initialiser,
      )],
      typescript.NodeFlags.Const,
    ),
  );
}
```

- [ ] **Step 5: Thread `isAsync` through `buildGuardedStatements` and its call site**

In `src/function-rewriter.ts`, update the `buildGuardedStatements` signature to add `isAsync` as
the last parameter:

```typescript
function buildGuardedStatements(
  factory: typescript.NodeFactory,
  preTags: ContractTag[],
  postTags: ContractTag[],
  originalBody: typescript.Block,
  location: string,
  invariantCall: typescript.ExpressionStatement | null,
  prevCapture: string | null,
  exportedNames: Set<string>,
  isAsync: boolean,
): typescript.Statement[] {
```

Inside the function, update the `buildBodyCapture` call:

```typescript
statements.push(buildBodyCapture(originalBody.statements, factory, isAsync));
```

In `rewriteFunction`, compute the flag and pass it:

```typescript
const asyncFlag = isAsyncFunction(node);

const newStatements = buildGuardedStatements(
  factory, preTags, postTags, originalBody, location,
  invariantCall, prevCapture, exportedNames, asyncFlag,
);
```

- [ ] **Step 6: Run the failing tests**

```
npx jest --testPathPattern="transformer" -t "async function post-condition body capture" --no-coverage
```

Expected: all three PASSes.

- [ ] **Step 7: Run lint and typecheck**

```
npm run lint && npm run typecheck
```

Expected: no errors.

- [ ] **Step 8: Run full suite**

```
npm test
```

Expected: all tests pass, no regressions.

---

## Done when

- `npm run lint && npm run typecheck` exit 0.
- `npm test` exits 0 with no regressions.
- All three `async function post-condition body capture` tests PASS.
- `buildBodyCapture` accepts an `isAsync` parameter; when `true`, emits `await (async () => { … })()`.
- `isAsyncFunction` is a file-private helper in `src/function-rewriter.ts`.
- Synchronous functions are unaffected — no `await` in their emitted output.
