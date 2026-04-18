# Async Functions — Task 4: Async class methods

Status: Done

> **Sequence:** This is step 4 of 6. Tasks 1, 2, and 3 must be complete before starting this task.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

We are fixing `@post` contracts on `async` functions and async class methods so that the
post-condition check operates on the **resolved** value of the promise, not the `Promise` object
itself.

**What previous tasks added (already in the codebase):**

- Task 1: `isAsyncFunction` helper + `buildBodyCapture` `isAsync` parameter + threading through
  `buildGuardedStatements`. The fix covers async class methods because
  `rewriteMember` → `tryRewriteFunction` → `rewriteFunction` → `buildGuardedStatements` with
  `isAsync` already threaded through.
- Task 2: `resolvePromiseTypeArg` + updated `returnTypeDescription` (warns and drops `@post result`
  for `Promise<void|never|undefined>`).
- Task 3: `unwrapPromiseType` + updated `buildPostParamTypes` (type-mismatch detection resolves
  against `T` rather than `Promise<T>`).

**What this task does:**

- Adds explicit test coverage for async class methods — no source files change.
- Verifies that `isAsyncFunction` correctly detects `AsyncKeyword` on `MethodDeclaration` nodes.
- Verifies invariant-check semantics for async methods.

**Files changed in this task:**

- `test/transformer.test.ts` only

---

## ESLint constraints

No source files change; ESLint constraints do not apply.

---

## Steps

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

If either fails, verify that `isAsyncFunction` in `src/function-rewriter.ts` correctly detects
`AsyncKeyword` on `MethodDeclaration` nodes, not just `FunctionDeclaration`.

- [ ] **Step 3: Run full suite**

```
npm test
```

Expected: all tests pass, no regressions.

---

## Done when

- `npm test` exits 0 with no regressions.
- Both `async class method post-condition` tests PASS.
- No source files were modified (this task is test-only).
