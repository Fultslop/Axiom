# Optional Chaining False-Positive Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the false-positive "property does not exist" warning emitted when a contract expression uses optional chaining (`obj?.value`) on a nullable parameter type (e.g. `ValueCarrier | null`). The bug is in `collectDeepPropertyErrors` in `src/contract-validator.ts` — the root type and each intermediate type must be stripped of `null`/`undefined` constituents before calling `getPropertyOfType`.

**Architecture:** One file changes. In `collectDeepPropertyErrors` (`src/contract-validator.ts`), replace the `let currentType: typescript.Type = rootType` initialisation with `let currentType: typescript.Type = checker.getNonNullableType(rootType)`, and replace `currentType = checker.getTypeOfSymbol(symbol)` with `currentType = checker.getNonNullableType(checker.getTypeOfSymbol(symbol))`. No other files change. `extractPropertyChain`, `resolveRootType`, `validateExpression`, and `function-rewriter.ts` are untouched.

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
| `src/contract-validator.ts` | Two one-line changes inside `collectDeepPropertyErrors`: strip nullability at root initialisation and at each step of the property walk |
| `test/transformer.test.ts` | New `describe` block inside the existing `'property chain validation'` describe: optional-chaining cases |

---

## Task 1: Fix false-positive on nullable root type and multi-step optional chains

**Files:**
- Modify: `src/contract-validator.ts`
- Test: `test/transformer.test.ts`

### Step 1: Write the failing tests

- [ ] Add a new `describe` block to the existing `'property chain validation'` describe in `test/transformer.test.ts`, immediately before the final closing `});` of that describe:

```typescript
describe('optional chaining on nullable parameter', () => {
  it('injects @pre for obj?.value when obj is ValueCarrier | null (no warning)', () => {
    const source = `
      interface ValueCarrier { value: number }
      /**
       * @pre obj?.value > 0
       */
      export function doOptionalFn(obj: ValueCarrier | null): number | null { return null; }
    `;
    const warnings: string[] = [];
    const output = transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
    expect(output).toContain('!(obj?.value > 0)');
  });

  it('injects @pre for obj.value when obj is ValueCarrier (non-nullable, regression)', () => {
    const source = `
      interface ValueCarrier { value: number }
      /**
       * @pre obj.value > 0
       */
      export function doFn(obj: ValueCarrier): number { return 0; }
    `;
    const warnings: string[] = [];
    const output = transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
    expect(output).toContain('!(obj.value > 0)');
  });

  it('warns for obj.balanc when obj is BankAccount (typo, regression)', () => {
    const source = `
      interface BankAccount { balance: number }
      /**
       * @pre obj.balanc > 0
       */
      export function doFn(obj: BankAccount): number { return 0; }
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes('balanc'))).toBe(true);
  });

  it('injects @pre for multi-step obj?.a?.b with all types nullable (no warning)', () => {
    const source = `
      interface Inner { bbb: number }
      interface Outer { aaa: Inner | undefined }
      /**
       * @pre obj?.aaa?.bbb > 0
       */
      export function deepFn(obj: Outer | null): number { return 0; }
    `;
    const warnings: string[] = [];
    const output = transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
    expect(output).toContain('!(obj?.aaa?.bbb > 0)');
  });

  it('warns for obj?.a?.missing when the final property does not exist', () => {
    const source = `
      interface Inner { bbb: number }
      interface Outer { aaa: Inner | undefined }
      /**
       * @pre obj?.aaa?.missing > 0
       */
      export function deepFn(obj: Outer | null): number { return 0; }
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes('missing'))).toBe(true);
  });

  it('injects @pre for obj?.value in transpileModule mode (no checker, no warning)', () => {
    const source = `
      interface ValueCarrier { value: number }
      /**
       * @pre obj?.value > 0
       */
      export function doOptionalFn(obj: ValueCarrier | null): number | null { return null; }
    `;
    const warnings: string[] = [];
    const output = transform(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
    expect(output).toContain('!(obj?.value > 0)');
  });
});
```

### Step 2: Run the tests to confirm the primary case fails

- [ ] Run:

```
npx jest --testPathPattern="transformer" -t "optional chaining on nullable parameter" --no-coverage
```

Expected: the first and fourth tests FAIL (false-positive warning emitted, contract not injected); the second, third, fifth, and sixth tests PASS.

### Step 3: Apply the fix to `src/contract-validator.ts`

- [ ] In `collectDeepPropertyErrors`, change the root type initialisation from:

```typescript
let currentType: typescript.Type = rootType;
```

to:

```typescript
let currentType: typescript.Type = checker.getNonNullableType(rootType);
```

- [ ] In the same function, change the per-step type update from:

```typescript
currentType = checker.getTypeOfSymbol(symbol);
```

to:

```typescript
currentType = checker.getNonNullableType(checker.getTypeOfSymbol(symbol));
```

The complete updated inner block of `collectDeepPropertyErrors` should look like this:

```typescript
if (rootType !== undefined) {
  let currentType: typescript.Type = checker.getNonNullableType(rootType);
  for (const prop of chain.properties) {
    const symbol = checker.getPropertyOfType(currentType, prop);
    if (symbol === undefined) {
      errors.push({
        kind: 'unknown-identifier',
        expression,
        location,
        message: `property '${prop}' does not exist`
          + ` on type '${checker.typeToString(currentType)}'`,
      });
      break;
    }
    currentType = checker.getNonNullableType(checker.getTypeOfSymbol(symbol));
  }
}
```

### Step 4: Run the targeted tests to confirm they all pass

- [ ] Run:

```
npx jest --testPathPattern="transformer" -t "optional chaining on nullable parameter" --no-coverage
```

Expected: all six tests PASS.

### Step 5: Run the full test suite

- [ ] Run:

```
npm test
```

Expected: all tests pass, coverage thresholds met.

### Step 6: Commit

- [ ] Stage and commit:

```
git add src/contract-validator.ts test/transformer.test.ts
git commit -m "fix: strip nullable constituents before property chain walk to suppress optional-chaining false positive"
```

---

## Acceptance Checklist

A human QA / acceptance tester should verify the following after the plan is implemented:

- In a consuming project, declare a function with a `ValueCarrier | null` parameter and write a `@pre obj?.value > 0` contract. After compilation with the transformer enabled, confirm no warning is printed to stderr and the emitted JS contains the contract guard.
- In the same consuming project, declare a function with a non-nullable `ValueCarrier` parameter and write `@pre obj.value > 0`. Confirm no warning and the contract guard is present (regression).
- Write `@pre obj.balanc > 0` (deliberate typo) on a function accepting `BankAccount`. Confirm a warning mentioning `balanc` is printed to stderr and the contract guard is absent from the emitted JS (regression).
- Write a multi-step optional chain `@pre obj?.aaa?.bbb > 0` where `obj: Outer | null` and `Outer.aaa: Inner | undefined` and `Inner.bbb: number`. Confirm no warning and the contract guard is injected.
- Write `@pre obj?.aaa?.missing > 0` on the same signature where `Inner` has no `missing` property. Confirm a warning mentioning `missing` is printed and the contract guard is absent.
- Run the project in transpileModule mode (no TypeChecker). Write `@pre obj?.value > 0` on a nullable-parameter function. Confirm no warning and the contract guard is injected (same as any other contract in that mode).
