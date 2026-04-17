# Async Functions — Task 5: `@prev` with async method regression

Status: Done

> **Sequence:** This is step 5 of 6. Tasks 1–4 must be complete before starting this task.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

We are fixing `@post` contracts on `async` functions and async class methods so that the
post-condition check operates on the **resolved** value of the promise, not the `Promise` object
itself.

**What previous tasks added (already in the codebase):**

- Task 1: `isAsyncFunction` helper + `buildBodyCapture` `isAsync` parameter + threading through
  `buildGuardedStatements`.
- Task 2: `resolvePromiseTypeArg` + updated `returnTypeDescription`.
- Task 3: `unwrapPromiseType` + updated `buildPostParamTypes`.
- Task 4: Test coverage for async class methods and invariants.

**What this task does:**

- Verifies the ordering invariant for `@prev`: `buildPrevCapture` is injected **before**
  `buildBodyCapture`, so the `prev` snapshot is taken before the `await`. This means
  `@post result > prev.length` correctly compares the resolved return value against the pre-call
  snapshot.
- No source files change — this task is test-only.

**Files changed in this task:**

- `test/transformer.test.ts` only

---

## ESLint constraints

No source files change; ESLint constraints do not apply.

---

## Steps

- [x] **Step 1: Write the test**

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
    const QueueClass = evalTransformedWith(
      js, 'Queue',
    ) as new () => { push: (item: string) => Promise<number> };
    const queue = new QueueClass();
    await expect(queue.push('a')).resolves.toBe(1);
  });
});
```

- [x] **Step 2: Run the test**

```
npx jest --testPathPattern="transformer" -t "@prev with async method" --no-coverage
```

Expected: PASS.

- [x] **Step 3: Run full suite**

```
npm test
```

Expected: all tests pass, no regressions.

---

## Done when

- `npm test` exits 0 with no regressions.
- The `@prev with async method` test PASS.
- No source files were modified (this task is test-only).
