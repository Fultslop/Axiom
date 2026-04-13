# Async Functions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `@post` contracts on `async` functions and async class methods so that the post-condition check operates on the **resolved** value of the promise, not the `Promise` object itself. Pre-conditions are already correct and remain unchanged.

**Architecture:** Three files change. `src/ast-builder.ts`: `buildBodyCapture` gains an `isAsync: boolean` parameter — when true, the inner IIFE arrow gets an `async` modifier and the call is wrapped in `await`. `src/function-rewriter.ts`: a new file-private `isAsyncFunction` helper detects the `AsyncKeyword` modifier; `buildGuardedStatements` gains an `isAsync` flag threaded from `rewriteFunction`; `returnTypeDescription` gains detection for `Promise<void | never | undefined>` so those post-tags are warned and dropped. `src/type-helpers.ts`: `buildPostParamTypes` unwraps `Promise<T>` via `checker.getTypeArguments` before calling `resolveSimpleType`, so type-mismatch checking for `result` operates on the resolved type `T` rather than `Promise<T>`.

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
| `src/ast-builder.ts` | `buildBodyCapture` gains `isAsync: boolean` parameter; async path wraps arrow in `async` and call in `await` |
| `src/function-rewriter.ts` | New `isAsyncFunction` helper; `buildGuardedStatements` gains `isAsync` flag; `returnTypeDescription` detects `Promise<void\|never\|undefined>` |
| `src/type-helpers.ts` | `buildPostParamTypes` unwraps `Promise<T>` for async functions before resolving result type |
| `test/transformer.test.ts` | New describe blocks for each case |

---

## Task 1: `isAsyncFunction` helper and `buildBodyCapture` async path

**Files:**
- Modify: `src/function-rewriter.ts`
- Modify: `src/ast-builder.ts`
- Test: `test/transformer.test.ts`

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

In `src/function-rewriter.ts`, update `buildGuardedStatements`:

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

- [ ] **Step 7: Run full suite**

```
npm test
```

Expected: all tests pass, no regressions.

- [ ] **Step 8: Commit**

```
git add src/ast-builder.ts src/function-rewriter.ts test/transformer.test.ts
git commit -m "feat: async IIFE body capture — await resolved value for @post checks"
```

---

## Task 2: `returnTypeDescription` unwraps `Promise<void | never | undefined>`

**Files:**
- Modify: `src/function-rewriter.ts`
- Test: `test/transformer.test.ts`

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

Add a check before the existing `return RETURN_TYPE_OK` line:

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

- [ ] **Step 6: Run full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```
git add src/function-rewriter.ts test/transformer.test.ts
git commit -m "feat: drop @post result with warning for async Promise<void|never|undefined>"
```

---

## Task 3: `buildPostParamTypes` unwraps `Promise<T>` for result type checking

**Files:**
- Modify: `src/type-helpers.ts`
- Test: `test/transformer.test.ts`

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

Expected: first test FAILs (no warning, because `Promise<number>` resolves to `non-primitive` rather than `number`), others PASS.

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

Replace the `returnType` resolution block inside `buildPostParamTypes`:

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

- [ ] **Step 6: Run full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```
git add src/type-helpers.ts test/transformer.test.ts
git commit -m "feat: unwrap Promise<T> in buildPostParamTypes for async result type checking"
```

---

## Task 4: Async class methods

**Files:**
- Test: `test/transformer.test.ts`

The body-capture fix from Task 1 already covers async class methods because `rewriteMember` → `tryRewriteFunction` → `rewriteFunction` → `buildGuardedStatements` with `isAsync` threaded through. This task adds explicit coverage.

- [ ] **Step 1: Write the tests**

Add to `test/transformer.test.ts`:

```typescript
describe('async class method post-condition', () => {
  it('checks resolved value for @post result !== null on async method', async () => {
    const source = `
      interface User { id: number }
      export class Repo {
        /**
         * @post result !== null
         */
        async find(id: number): Promise<User | null> {
          return Promise.resolve(null);
        }
      }
    `;
    const warnings: string[] = [];
    const js = transformWithProgram(source, (msg) => warnings.push(msg));
    expect(js).toContain('await');
    expect(js).toContain('async ()');
    const RepoClass = evalTransformed<new () => { find: (id: number) => Promise<unknown> }>(
      js, 'Repo',
    );
    const repo = new RepoClass();
    await expect(repo.find(1)).rejects.toThrow();
  });

  it('invariant fires after await resolves, not on unresolved promise', async () => {
    const source = `
      /**
       * @invariant this.count >= 0
       */
      export class Counter {
        count = 0;
        async increment(): Promise<void> {
          this.count += 1;
        }
      }
    `;
    const warnings: string[] = [];
    const js = transformWithProgram(source, (msg) => warnings.push(msg));
    const CounterClass = evalTransformed<new () => { increment: () => Promise<void> }>(
      js, 'Counter',
    );
    const counter = new CounterClass();
    await expect(counter.increment()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests**

```
npx jest --testPathPattern="transformer" -t "async class method post-condition" --no-coverage
```

Expected: both PASSes (covered by Tasks 1 and 2).

If any fail, verify that `isAsyncFunction` correctly detects `AsyncKeyword` on `MethodDeclaration` nodes.

- [ ] **Step 3: Run full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```
git add test/transformer.test.ts
git commit -m "test: add coverage for async class method post-condition and invariant"
```

---

## Task 5: `@prev` with async method regression

**Files:**
- Test: `test/transformer.test.ts`

`buildPrevCapture` is injected before `buildBodyCapture`, so `prev` is captured before `await`. This task verifies that invariant.

- [ ] **Step 1: Write the test**

Add to `test/transformer.test.ts`:

```typescript
describe('@prev with async method', () => {
  it('captures prev before await and compares against resolved result', async () => {
    const source = `
      export class Queue {
        length = 0;
        /**
         * @post result > prev.length
         */
        async push(item: string): Promise<number> {
          this.length += 1;
          return Promise.resolve(this.length);
        }
      }
    `;
    const warnings: string[] = [];
    const js = transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
    const QueueClass = evalTransformed<new () => { push: (item: string) => Promise<number> }>(
      js, 'Queue',
    );
    const queue = new QueueClass();
    await expect(queue.push('a')).resolves.toBe(1);
  });
});
```

- [ ] **Step 2: Run the test**

```
npx jest --testPathPattern="transformer" -t "@prev with async method" --no-coverage
```

Expected: PASS.

- [ ] **Step 3: Run full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```
git add test/transformer.test.ts
git commit -m "test: verify @prev capture semantics with async method"
```

---

## Task 6: Regression — synchronous path unchanged

**Files:**
- Test: `test/transformer.test.ts`

Confirm the `isAsync: false` path through `buildBodyCapture` is identical to the pre-change behaviour for all existing sync cases.

- [ ] **Step 1: Run the full suite**

```
npm test
```

Expected: all previously passing tests still pass. The synchronous IIFE emitted by `buildBodyCapture` when `isAsync = false` must be bit-for-bit identical to the original output (no `await`, no `async` modifier on the arrow).

- [ ] **Step 2: Run coverage**

```
npm run test:coverage
```

Expected: coverage thresholds met (≥ 80%).

- [ ] **Step 3: Lint check**

```
npm run lint
```

Expected: no errors.

- [ ] **Step 4: Type check**

```
npm run typecheck
```

Expected: no errors.

---

## Acceptance Checklist

Human QA steps to verify the feature is complete and correct:

- [ ] An `async` standalone function with `@post result !== null` is rewritten to `await (async () => { … })()` — verify by inspecting emitted JS that `await` and `async ()` are both present on the capture line.
- [ ] Invoking the rewritten async function at runtime with a value that violates the post-condition (e.g. returns `null`) throws a `ContractViolationError` with `kind: 'POST'`.
- [ ] A synchronous function with `@post` is **not** rewritten with `await` — confirm no `await` appears in its emitted capture line.
- [ ] A `@pre` on an async function fires synchronously and throws before the async body runs (i.e. the rejection is immediate, not after a tick).
- [ ] `async function foo(): Promise<void>` with `@post result !== undefined` emits a warning containing `"return type is 'void'"` and the post tag is not present in the output.
- [ ] `async function foo(): Promise<never>` with `@post result !== null` emits a warning containing `"return type is 'never'"` and the post tag is dropped.
- [ ] `async function foo(): Promise<number>` with `@post result === "ok"` emits a type-mismatch warning mentioning `result`.
- [ ] `async function foo(): Promise<number>` with `@post result > 0` emits **no** warning.
- [ ] An async class method with `@post result !== null` resolves the post-condition against the awaited value — same runtime behaviour as the standalone function case.
- [ ] A class with `@invariant` and an async public method: after `await method()`, the invariant check runs without error and does not throw on a valid instance.
- [ ] `@prev` capture on an async method stores state before the body runs; `@post result > prev.length` compares the resolved return value against the pre-call snapshot.
- [ ] All existing synchronous test cases continue to pass without modification.
- [ ] `npm run lint` passes with no errors after all changes.
- [ ] `npm run typecheck` passes with no errors after all changes.
- [ ] `npm run test:coverage` reports ≥ 80% across all thresholds.
