# Test Coverage for `snapshot()` and `deepSnapshot()` — Design Doc

**Date:** 2026-04-22
**Covers:** Spec 004 finding #11 — No test coverage for `snapshot()` or `deepSnapshot()` runtime behavior (Medium)

---

## 1. Problem

`test/assertions.test.ts` tests `pre()` and `post()` but never tests `snapshot()` or `deepSnapshot()`. These are public API functions that users call directly or that the transformer injects via `@prev`. The JSON fallback path in `deepSnapshot()` has zero test coverage, meaning it can silently regress.

---

## 2. Goals

- `snapshot()` has tests for both its correct behaviour and its documented limitations.
- `deepSnapshot()` has tests for the `structuredClone` path and the JSON fallback path.
- The JSON fallback is exercised by simulating an environment without `structuredClone`.
- All tests live in `test/assertions.test.ts` alongside existing `pre()`/`post()` tests.

---

## 3. Approach

### 3.1 `snapshot()` tests

Add a `describe('snapshot', ...)` block:

```typescript
it('captures own enumerable properties', () => {
  const obj = { a: 1, b: 'hello' };
  expect(snapshot(obj)).toEqual({ a: 1, b: 'hello' });
});

it('does not share references with the original', () => {
  const obj = { nested: { x: 1 } };
  const snap = snapshot(obj);
  obj.nested.x = 2;
  expect(snap.nested.x).toBe(1); // shallow: top-level properties are copied
});

it('does NOT capture prototype methods', () => {
  class Foo { method() {} }
  const foo = new Foo();
  const snap = snapshot(foo) as Record<string, unknown>;
  expect(snap.method).toBeUndefined();
});

it('does NOT capture non-enumerable properties', () => {
  const obj = Object.create(null);
  Object.defineProperty(obj, 'hidden', { value: 42, enumerable: false });
  const snap = snapshot(obj) as Record<string, unknown>;
  expect(snap.hidden).toBeUndefined();
});
```

### 3.2 `deepSnapshot()` with `structuredClone`

```typescript
it('deeply clones plain objects', () => {
  const obj = { a: { b: { c: 3 } } };
  const snap = deepSnapshot(obj);
  obj.a.b.c = 99;
  expect((snap as typeof obj).a.b.c).toBe(3);
});

it('preserves undefined values', () => {
  const obj = { a: undefined, b: 1 };
  const snap = deepSnapshot(obj) as typeof obj;
  expect(snap.a).toBeUndefined();
  expect('a' in snap).toBe(true);
});
```

### 3.3 `deepSnapshot()` JSON fallback

Simulate missing `structuredClone` by temporarily deleting it from `globalThis`:

```typescript
describe('deepSnapshot JSON fallback', () => {
  let originalClone: typeof structuredClone;

  beforeEach(() => {
    originalClone = globalThis.structuredClone;
    // @ts-expect-error simulating unavailable structuredClone
    delete globalThis.structuredClone;
  });

  afterEach(() => {
    globalThis.structuredClone = originalClone;
  });

  it('falls back to JSON clone', () => {
    const obj = { a: 1, b: 'hello' };
    const snap = deepSnapshot(obj) as typeof obj;
    expect(snap).toEqual({ a: 1, b: 'hello' });
  });

  it('drops undefined values in fallback', () => {
    const obj = { a: undefined, b: 1 };
    const snap = deepSnapshot(obj) as Record<string, unknown>;
    expect('a' in snap).toBe(false); // JSON.parse drops undefined
    expect(snap.b).toBe(1);
  });

  it('emits a warning when using JSON fallback', () => {
    const warn = jest.fn();
    deepSnapshot({ a: 1 }, { warn });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('JSON fallback'));
  });
});
```

Note: the `warn` callback parameter must be added to `deepSnapshot` if not already present (see spec `2026-04-22-deep-snapshot-warning-design.md`).

---

## 4. Changes Summary

| File | Change |
|---|---|
| `test/assertions.test.ts` | Add `describe('snapshot', ...)` and `describe('deepSnapshot', ...)` blocks with tests listed above |

---

## 5. Testing Plan

This spec IS the testing plan. Success: all new tests pass and `npm run test:coverage` shows `assertions.ts` branch coverage ≥ 95%.

---

## 6. Out of Scope

- Testing circular reference handling in `deepSnapshot` — circular objects throw under JSON.stringify; documenting this is in the `deepSnapshot` warning spec.
- Testing `snapshot()` with Symbol keys — documented limitation, no test required.
- Integration tests for `@prev` end-to-end (those belong in transformer integration tests, not assertions unit tests).
