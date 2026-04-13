# Compound Conditions / Type Narrowing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `typeof` guard narrowing for ambiguous-union parameters so that `typeof x === "string" && x === 42` (where `x: string | number`) emits a `type-mismatch` warning on the second clause. Currently `resolveSimpleType` returns `undefined` for mixed primitive unions, leaving the parameter absent from `paramTypes` and silently skipping the comparison.

**Architecture:** One file changes. `src/contract-validator.ts` gains three new file-private helpers — `collectAndClauses`, `extractTypeofGuard`, and `buildNarrowedTypeMap` — and `validateExpression` calls `buildNarrowedTypeMap` to produce an effective type map before passing it to `collectTypeMismatches`. `src/type-helpers.ts` and all public API signatures are unchanged.

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
| `src/contract-validator.ts` | Add file-private helpers `collectAndClauses`, `extractTypeofGuard`, `buildNarrowedTypeMap`; update `validateExpression` to call `buildNarrowedTypeMap` before `collectTypeMismatches` |
| `src/type-helpers.ts` | No changes |
| Public API | No changes — `validateExpression` signature is unchanged |

---

## Task 1: `collectAndClauses` and `extractTypeofGuard` helpers

**Files:**
- Modify: `src/contract-validator.ts`
- Test: `src/contract-validator.test.ts` (or `test/transformer.test.ts` — whichever holds the existing type-mismatch tests)

### Step 1: Write failing tests for `typeof` narrowing

Add a new `describe` block for compound condition narrowing. These tests exercise the full transformer pipeline and will fail until `buildNarrowedTypeMap` is wired in.

```typescript
describe('typeof guard narrowing in && chains', () => {
  it('warns when typeof-narrowed-to-string param is compared to number literal', () => {
    // x: string | number — resolveSimpleType returns undefined (ambiguous union)
    // typeof x === "string" narrows x to string; x === 42 should warn
    const source = `
      /**
       * @pre typeof x === "string" && x === 42
       */
      export function foo(x: string | number): void {}
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes('type mismatch') && w.includes("'x'"))).toBe(true);
  });

  it('does not warn when typeof-narrowed-to-number param is used in numeric comparison', () => {
    const source = `
      /**
       * @pre typeof x === "number" && x > 0
       */
      export function foo(x: string | number): void {}
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
  });

  it('warns when typeof-narrowed-to-boolean param is compared to number literal', () => {
    const source = `
      /**
       * @pre typeof x === "boolean" && x === 1
       */
      export function foo(x: boolean | number): void {}
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes('type mismatch') && w.includes("'x'"))).toBe(true);
  });

  it('does not warn when typeof-narrowed-to-string param is compared to string literal', () => {
    const source = `
      /**
       * @pre typeof x === "string" && x === "hello"
       */
      export function foo(x: string | number): void {}
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
  });
});
```

### Step 2: Run to confirm all four fail

```
npx jest --testPathPattern="transformer" -t "typeof guard narrowing in && chains" --no-coverage
```

Expected: all four FAIL (no warnings emitted, first and third tests find no warning, second and fourth tests pass vacuously if warnings is empty — watch the assertion direction). Confirm at least the first and third tests fail.

### Step 3: Add `collectAndClauses` to `src/contract-validator.ts`

Add this file-private helper before `collectTypeMismatches`:

```typescript
function collectAndClauses(
  node: typescript.Node,
  out: typescript.Node[],
): void {
  if (
    typescript.isBinaryExpression(node) &&
    node.operatorToken.kind === typescript.SyntaxKind.AmpersandAmpersandToken
  ) {
    collectAndClauses(node.left, out);
    collectAndClauses(node.right, out);
  } else {
    out.push(node);
  }
}
```

### Step 4: Add `extractTypeofGuard` to `src/contract-validator.ts`

Add this file-private helper immediately after `collectAndClauses`:

```typescript
const TYPEOF_NARROWABLE = new Set<string>(['string', 'number', 'boolean']);

function extractTypeofGuard(
  node: typescript.Node,
): { paramName: string; narrowedType: SimpleType } | undefined {
  if (!typescript.isBinaryExpression(node)) {
    return undefined;
  }
  if (node.operatorToken.kind !== typescript.SyntaxKind.EqualsEqualsEqualsToken) {
    return undefined;
  }
  // Allow typeof on either side of ===
  const tryExtract = (
    lhs: typescript.Node,
    rhs: typescript.Node,
  ): { paramName: string; narrowedType: SimpleType } | undefined => {
    if (
      typescript.isTypeOfExpression(lhs) &&
      typescript.isIdentifier(lhs.expression) &&
      typescript.isStringLiteral(rhs) &&
      TYPEOF_NARROWABLE.has(rhs.text)
    ) {
      return {
        paramName: lhs.expression.text,
        narrowedType: rhs.text as SimpleType,
      };
    }
    return undefined;
  };
  return tryExtract(node.left, node.right) ?? tryExtract(node.right, node.left);
}
```

Note: `TYPEOF_NARROWABLE` uses a `Set<string>` rather than `Set<SimpleType>` to avoid the need for a type assertion inside the `has` check, which would require a cast. The `as SimpleType` cast on `rhs.text` is safe because the `has` check already verifies membership.

---

## Task 2: `buildNarrowedTypeMap` and wiring into `validateExpression`

**Files:**
- Modify: `src/contract-validator.ts`

### Step 1: Add `buildNarrowedTypeMap` to `src/contract-validator.ts`

Add immediately after `extractTypeofGuard`:

```typescript
function buildNarrowedTypeMap(
  node: typescript.Expression,
  paramTypes: Map<string, TypeMapValue>,
): Map<string, TypeMapValue> {
  const clauses: typescript.Node[] = [];
  collectAndClauses(node, clauses);

  const narrowed = new Map<string, TypeMapValue>();
  for (const clause of clauses) {
    const guard = extractTypeofGuard(clause);
    if (guard === undefined) {
      continue;
    }
    // Only inject narrowed type for parameters absent from the base map.
    // Parameters already resolved by resolveSimpleType are not overridden.
    if (!paramTypes.has(guard.paramName)) {
      narrowed.set(guard.paramName, guard.narrowedType);
    }
  }

  if (narrowed.size === 0) {
    return paramTypes;
  }

  const effective = new Map(paramTypes);
  for (const [name, type] of narrowed) {
    effective.set(name, type);
  }
  return effective;
}
```

### Step 2: Wire `buildNarrowedTypeMap` into `validateExpression`

In `validateExpression`, replace the existing `collectTypeMismatches` call:

Current code (lines 286–288 of `src/contract-validator.ts`):

```typescript
  if (paramTypes !== undefined) {
    collectTypeMismatches(node, expression, location, paramTypes, errors);
  }
```

Replace with:

```typescript
  if (paramTypes !== undefined) {
    const effectiveTypes = buildNarrowedTypeMap(node, paramTypes);
    collectTypeMismatches(node, expression, location, effectiveTypes, errors);
  }
```

`validateExpression`'s signature does not change.

### Step 3: Run the narrowing tests

```
npx jest --testPathPattern="transformer" -t "typeof guard narrowing in && chains" --no-coverage
```

Expected: all four tests PASS.

### Step 4: Run full suite

```
npm test
```

Expected: all tests pass, coverage threshold met.

### Step 5: Commit

```
git add src/contract-validator.ts test/transformer.test.ts
git commit -m "feat: typeof guard narrowing for ambiguous-union params in && chains"
```

---

## Task 3: Preserved-behaviour and edge-case tests

**Files:**
- Test: `test/transformer.test.ts`

These tests verify that existing behaviour is undisturbed and that the edge cases listed in the spec produce the correct outcome.

### Step 1: Write the tests

```typescript
describe('typeof narrowing — existing behaviour preserved', () => {
  it('warns on non-union string param in typeof guard expression (existing path)', () => {
    // x already resolves to "string"; narrowed map does not override
    const source = `
      /**
       * @pre typeof x === "string" && x === 42
       */
      export function foo(x: string): void {}
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes('type mismatch') && w.includes("'x'"))).toBe(true);
  });

  it('does not warn for non-union number param in valid numeric comparison', () => {
    const source = `
      /**
       * @pre typeof x === "number" && x > 0
       */
      export function foo(x: number): void {}
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
  });
});

describe('typeof narrowing — null-check union unaffected', () => {
  it('warns when number|null param is compared to string literal (existing union resolution)', () => {
    // resolveSimpleType strips null and returns "number"; no change in behaviour
    const source = `
      /**
       * @pre x !== null && x === "zero"
       */
      export function foo(x: number | null): void {}
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes('type mismatch') && w.includes("'x'"))).toBe(true);
  });
});

describe('typeof narrowing — edge cases', () => {
  it('does not apply narrowing from || chains', () => {
    // || is not walked; x remains absent from effective map; no type-mismatch
    const source = `
      /**
       * @pre typeof x === "string" || x === 42
       */
      export function foo(x: string | number): void {}
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings.filter((w) => w.includes('type mismatch'))).toHaveLength(0);
  });

  it('narrows multiple params independently in same && chain', () => {
    // x narrowed to "string", y narrowed to "number"; x === 42 warns, y > 0 does not
    const source = `
      /**
       * @pre typeof x === "string" && typeof y === "number" && x === 42
       */
      export function foo(x: string | number, y: string | number): void {}
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes('type mismatch') && w.includes("'x'"))).toBe(true);
    expect(warnings.filter((w) => w.includes("'y'"))).toHaveLength(0);
  });

  it('does not extract narrowing from loose-equality typeof guard (== not ===)', () => {
    // typeof x == "string" uses == — not recognised; no narrowing; no type-mismatch
    const source = `
      /**
       * @pre typeof x == "string" && x === 42
       */
      export function foo(x: string | number): void {}
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings.filter((w) => w.includes('type mismatch'))).toHaveLength(0);
  });
});
```

### Step 2: Run the edge-case tests

```
npx jest --testPathPattern="transformer" -t "typeof narrowing" --no-coverage
```

Expected: all tests PASS.

### Step 3: Run full suite

```
npm test
```

Expected: all tests pass, coverage threshold met.

### Step 4: Commit

```
git add test/transformer.test.ts
git commit -m "test: add preserved-behaviour and edge-case coverage for typeof narrowing"
```

---

## Acceptance Checklist

Human QA — verify each item manually after implementation:

- `typeof x === "string" && x === 42` on a `string | number` parameter emits a `type-mismatch` warning that mentions `'x'`.
- `typeof x === "number" && x > 0` on a `string | number` parameter emits no warning.
- `typeof x === "boolean" && x === 1` on a `boolean | number` parameter emits a `type-mismatch` warning that mentions `'x'`.
- `typeof x === "string" && x === "hello"` on a `string | number` parameter emits no warning.
- A non-union `string` parameter with `typeof x === "string" && x === 42` still warns — the pre-existing `paramTypes` entry is not overridden by narrowing.
- `x !== null && x === "zero"` on `number | null` still warns — existing union resolution path is unaffected.
- `typeof x === "string" || x === 42` on `string | number` emits no type-mismatch warning — `||` is not walked.
- Two parameters in the same `&&` chain each narrow independently — wrong comparison on one warns without affecting the other.
- `typeof x == "string" && x === 42` (loose `==`) does not inject narrowing — only `===` is recognised.
- `npm test` passes with all tests green and coverage above the 80% threshold.
- `npm run lint` passes with no new ESLint errors.
- `npm run typecheck` passes with no type errors.
