# Arrow Functions — Task 6: Remaining spec test cases

> **Sequence:** This is step 6 of 6 (final task). Tasks 1–5 must be complete before starting.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

We are adding `@pre`/`@post` contract injection support for exported `const` arrow functions and
function expressions.

**What previous tasks added (already in the codebase):**
- Task 1: `isExportedVariableInitialiser` + extended `buildLocationName` in `src/node-helpers.ts`
- Task 2: JSDoc fallback in `src/jsdoc-parser.ts`
- Task 3: `normaliseArrowBody` + extended `applyNewBody` in `src/function-rewriter.ts`
- Task 4: `VariableStatement` dispatch wired in `src/transformer.ts`
- Task 5: Location-string assertion test added and passing

**What this task does:**
Adds the remaining edge-case tests to achieve full spec coverage. All tests in this task should
pass immediately without any source changes — the implementation is already complete.

**Only `test/transformer.test.ts` changes in this task.**

---

## Steps

- [ ] **Step 1: Add the remaining tests to `test/transformer.test.ts`**

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
    // No contract injection means no require() call for the runtime.
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
    const fn = loadFunction<(numerator: number, denominator: number) => number>(
      compiled, 'divide',
    );
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

- [ ] **Step 2: Run only the new tests**

```
npx jest --testPathPattern="transformer" -t "@post with result|named function expression|non-exported|no tags|multiple contracts|unknown identifier|multiple declarations" --no-coverage
```

Expected: all PASS. If any fail, debug against the implementation — no source changes should be
needed; the issue will be in the test expectation or in an edge-case missed by Tasks 1–4.

- [ ] **Step 3: Run full suite with coverage**

```
npm run test:coverage
```

Expected: all tests pass; coverage ≥ 80%.

- [ ] **Step 4: Run lint and typecheck**

```
npm run lint && npm run typecheck
```

Expected: no errors.

---

## Acceptance Checklist (human QA — verify before merging)

- [ ] `export const validate = /** @pre x > 0 */ (x: number): boolean => x > 0` — `validate(-1)` throws; `validate(1)` returns `true`.
- [ ] Expression-body arrow with `@post result >= 0` — `@post` is injected; result assertion passes.
- [ ] Block-body arrow with `@pre min <= max` — contract injected correctly.
- [ ] `export const trim = /** @pre input.length > 0 */ function(input: string) {...}` — `trim('')` throws.
- [ ] Named function expression: location string in error is `"factorial"`, not `"fact"` or `"anonymous"`.
- [ ] Non-exported `const internal = /** @pre x > 0 */ (x) => x` — no injection, no warning, no `require(...)`.
- [ ] `export const noop = (x: number): number => x` (no tags) — no `require(...)` in output.
- [ ] Arrow with both `@pre denominator !== 0` and `@post result !== Infinity` — both checks injected.
- [ ] Arrow with `@post result > 0` but no return type annotation — warning emitted; no injection.
- [ ] `VariableStatement` with two declarations, only one annotated — only the annotated one is rewritten.
- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm run test:coverage` reports ≥ 80% coverage and all tests green.

---

## Done when

- `npm run lint && npm run typecheck` exit 0.
- `npm run test:coverage` exits 0 with ≥ 80% coverage.
- All acceptance checklist items verified.
