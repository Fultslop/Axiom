# Type Checking Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four type-mismatch detection gaps: non-primitive parameter types (#2), union-typed parameters (#3), non-primitive return types (#7), and unary operands like `-amount` (#10).

**Architecture:** Two files change. `src/type-helpers.ts` gains a `resolveSimpleType` helper that uses the TypeChecker to resolve union and non-primitive types to a `SimpleType | 'non-primitive'` result; `buildParameterTypes` and `buildPostParamTypes` are updated to use it. `src/contract-validator.ts` gains an `extractIdentifierOperand` helper that unwraps prefix unary expressions before type-checking; `collectTypeMismatches` and its callers are updated to handle the `'non-primitive'` sentinel. The `'non-primitive'` value flows through internal maps only — it is never exported.

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
| `src/type-helpers.ts` | Add `resolveSimpleType`; update `buildParameterTypes` and `buildPostParamTypes` to use it and return `Map<string, SimpleType \| 'non-primitive'>` |
| `src/contract-validator.ts` | Add `extractIdentifierOperand`; update `collectTypeMismatches` to use it and handle `'non-primitive'`; widen `paramTypes` type in `validateExpression` |
| `src/function-rewriter.ts` | Update `filterValidTags` signature to accept wider map type |
| `test/transformer.test.ts` | New describe blocks for each gap |

---

## Task 1: `resolveSimpleType` for union types (Fix #3)

**Files:**
- Modify: `src/type-helpers.ts`
- Test: `test/transformer.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/transformer.test.ts` (uses `transformWithProgram`):

```typescript
describe('union type parameter mismatch detection', () => {
  it('warns when number|undefined param is compared to string literal', () => {
    const source = `
      /**
       * @pre amount === "zero"
       */
      export function pay(amount: number | undefined): void {}
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes('type mismatch') && w.includes('amount'))).toBe(true);
  });

  it('warns when string|null param is compared to number literal', () => {
    const source = `
      /**
       * @pre label === 42
       */
      export function tag(label: string | null): void {}
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes('type mismatch') && w.includes('label'))).toBe(true);
  });

  it('does not warn for ambiguous union (number|string)', () => {
    const source = `
      /**
       * @pre val === 1
       */
      export function foo(val: number | string): void {}
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to confirm first two fail**

```
npx jest --testPathPattern="transformer" -t "union type parameter mismatch detection" --no-coverage
```

Expected: first two FAILs (no warning), third PASS.

- [ ] **Step 3: Add `resolveSimpleType` to `src/type-helpers.ts`**

Add after the `simpleTypeFromFlags` function:

```typescript
export function resolveSimpleType(
  paramType: typescript.Type,
  checker: typescript.TypeChecker,
): SimpleType | 'non-primitive' | undefined {
  const direct = simpleTypeFromFlags(paramType.flags);
  if (direct !== undefined) {
    return direct;
  }
  /* eslint-disable no-bitwise */
  if (paramType.flags & typescript.TypeFlags.Union) {
    const union = paramType as typescript.UnionType;
    const nonNullable = union.types.filter(
      (constituent) => !(
        constituent.flags & typescript.TypeFlags.Null ||
        constituent.flags & typescript.TypeFlags.Undefined
      ),
    );
    if (nonNullable.length === 0) {
      return undefined;
    }
    const resolved = nonNullable.map((constituent) => simpleTypeFromFlags(constituent.flags));
    const allSame = resolved.every((val) => val !== undefined && val === resolved[0]);
    if (allSame && resolved[0] !== undefined) {
      return resolved[0];
    }
    const anyPrimitive = resolved.some((val) => val !== undefined);
    if (!anyPrimitive) {
      return 'non-primitive';
    }
    return undefined; // mixed primitive union — too ambiguous
  }
  if (
    paramType.flags & typescript.TypeFlags.Object ||
    paramType.flags & typescript.TypeFlags.Intersection
  ) {
    return 'non-primitive';
  }
  /* eslint-enable no-bitwise */
  return undefined;
}
```

- [ ] **Step 4: Update `buildParameterTypes` in `src/type-helpers.ts` to use `resolveSimpleType`**

Change the return type and the inner logic:

```typescript
export function buildParameterTypes(
  node: typescript.FunctionLikeDeclaration,
  checker: typescript.TypeChecker,
): Map<string, SimpleType | 'non-primitive'> {
  const types = new Map<string, SimpleType | 'non-primitive'>();
  for (const param of node.parameters) {
    if (typescript.isIdentifier(param.name)) {
      const paramType = checker.getTypeAtLocation(param);
      const simple = simpleTypeFromFlags(paramType.flags) ??
        resolveSimpleType(paramType, checker);
      if (simple !== undefined) {
        types.set(param.name.text, simple);
      }
    }
  }
  return types;
}
```

Note: if the identifier-scope-gaps plan has already been merged, `buildParameterTypes` will also call `extractBindingTypes`. In that case, update `extractBindingTypes`'s map type to `Map<string, SimpleType | 'non-primitive'>` and replace its `simpleTypeFromFlags` call with `simpleTypeFromFlags(type.flags) ?? resolveSimpleType(type, checker)`.

- [ ] **Step 5: Run failing tests to confirm they now pass**

```
npx jest --testPathPattern="transformer" -t "union type parameter mismatch detection" --no-coverage
```

Expected: all three PASSes — but `collectTypeMismatches` in `contract-validator.ts` doesn't know about `'non-primitive'` yet, so the tests may still fail. Continue to Task 2 before re-running if needed.

---

## Task 2: Handle `'non-primitive'` in `collectTypeMismatches` and update `validateExpression` (Fix #2, #3)

**Files:**
- Modify: `src/contract-validator.ts:82-121`
- Modify: `src/function-rewriter.ts` (widen `filterValidTags` param type)

- [ ] **Step 1: Update `checkSideMismatch` in `src/contract-validator.ts` to handle `'non-primitive'`**

Replace the current `checkSideMismatch` function:

```typescript
function checkSideMismatch(
  paramId: typescript.Identifier | undefined,
  paramType: SimpleType | 'non-primitive' | undefined,
  litType: SimpleType | undefined,
  expression: string,
  location: string,
  errors: ValidationError[],
): void {
  if (paramId === undefined || paramType === undefined || litType === undefined) {
    return;
  }
  if (paramType === 'non-primitive') {
    errors.push({
      kind: 'type-mismatch',
      expression,
      location,
      message: `type mismatch: '${paramId.text}' is not a primitive type`
        + ` but compared to ${litType} literal`,
    });
    return;
  }
  if (paramType !== litType) {
    errors.push({
      kind: 'type-mismatch',
      expression,
      location,
      message: `type mismatch: '${paramId.text}' is ${paramType}`
        + ` but compared to ${litType} literal`,
    });
  }
}
```

- [ ] **Step 2: Update `collectTypeMismatches` signature to accept the wider map type**

```typescript
function collectTypeMismatches(
  node: typescript.Node,
  expression: string,
  location: string,
  paramTypes: Map<string, SimpleType | 'non-primitive'>,
  errors: ValidationError[],
): void {
  if (typescript.isBinaryExpression(node)) {
    const leftId = typescript.isIdentifier(node.left) ? node.left : undefined;
    const rightId = typescript.isIdentifier(node.right) ? node.right : undefined;
    const leftParamType = leftId !== undefined ? paramTypes.get(leftId.text) : undefined;
    const rightParamType = rightId !== undefined ? paramTypes.get(rightId.text) : undefined;
    const leftLit = getLiteralSimpleType(node.left);
    const rightLit = getLiteralSimpleType(node.right);
    checkSideMismatch(leftId, leftParamType, rightLit, expression, location, errors);
    checkSideMismatch(rightId, rightParamType, leftLit, expression, location, errors);
  }
  typescript.forEachChild(node, (child) => {
    collectTypeMismatches(child, expression, location, paramTypes, errors);
  });
}
```

- [ ] **Step 3: Update `validateExpression` signature in `src/contract-validator.ts`**

```typescript
export function validateExpression(
  node: typescript.Expression,
  expression: string,
  location: string,
  knownIdentifiers?: Set<string>,
  paramTypes?: Map<string, SimpleType | 'non-primitive'>,
): ValidationError[] {
```

- [ ] **Step 4: Update `filterValidTags` in `src/function-rewriter.ts`**

The import at the top of `function-rewriter.ts` already imports `SimpleType` from `type-helpers`. Update the `filterValidTags` signature:

```typescript
export function filterValidTags(
  tags: ContractTag[],
  kind: 'pre' | 'post',
  location: string,
  warn: (msg: string) => void,
  knownIdentifiers: Set<string>,
  paramTypes?: Map<string, SimpleType | 'non-primitive'>,
): ContractTag[] {
```

Also update `buildPostParamTypes` in `src/type-helpers.ts` to use the wider type:

```typescript
export function buildPostParamTypes(
  node: typescript.FunctionLikeDeclaration,
  checker: typescript.TypeChecker | undefined,
  base: Map<string, SimpleType | 'non-primitive'> | undefined,
): Map<string, SimpleType | 'non-primitive'> | undefined {
  if (checker === undefined || base === undefined) {
    return base;
  }
  const sig = checker.getSignatureFromDeclaration(node);
  if (sig === undefined) {
    return base;
  }
  const returnType = checker.getReturnTypeOfSignature(sig);
  const resultType = simpleTypeFromFlags(returnType.flags) ??
    resolveSimpleType(returnType, checker);
  if (resultType === undefined) {
    return base;
  }
  const extended = new Map(base);
  extended.set('result', resultType);
  return extended;
}
```

- [ ] **Step 5: Run the union type tests**

```
npx jest --testPathPattern="transformer" -t "union type parameter mismatch detection" --no-coverage
```

Expected: all three PASSes.

- [ ] **Step 6: Run full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```
git add src/type-helpers.ts src/contract-validator.ts src/function-rewriter.ts test/transformer.test.ts
git commit -m "feat: detect type mismatch for union and non-primitive parameter types"
```

---

## Task 3: Non-primitive parameter types (Fix #2)

**Files:**
- Test: `test/transformer.test.ts`

`resolveSimpleType` already returns `'non-primitive'` for `TypeFlags.Object`. This task just verifies the end-to-end behaviour with tests and adds the array/object cases from the spec.

- [ ] **Step 1: Write the tests**

Add to `test/transformer.test.ts`:

```typescript
describe('non-primitive parameter type mismatch detection', () => {
  it('warns when array parameter is compared to number literal', () => {
    const source = `
      /**
       * @pre items === 42
       */
      export function process(items: string[]): void {}
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes('type mismatch') && w.includes('items')),
    ).toBe(true);
  });

  it('warns when object parameter is compared to string literal', () => {
    const source = `
      interface Point { x: number; y: number }
      /**
       * @pre pt === "hello"
       */
      export function move(pt: Point): void {}
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes('type mismatch') && w.includes('pt')),
    ).toBe(true);
  });

  it('does not warn when checking a property of an object parameter', () => {
    const source = `
      /**
       * @pre items.length > 0
       */
      export function process(items: string[]): void {}
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests**

```
npx jest --testPathPattern="transformer" -t "non-primitive parameter type mismatch detection" --no-coverage
```

Expected: all three PASSes (covered by Task 2's implementation).

If any fail, debug `resolveSimpleType` — ensure `TypeFlags.Object` is being matched for arrays and interfaces.

- [ ] **Step 3: Run full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```
git add test/transformer.test.ts
git commit -m "test: add coverage for non-primitive parameter type mismatch detection"
```

---

## Task 4: Non-primitive return type mismatch for `result` (Fix #7)

**Files:**
- Test: `test/transformer.test.ts`

`buildPostParamTypes` was updated in Task 2 to use `resolveSimpleType` for the return type. This task verifies the end-to-end behaviour.

- [ ] **Step 1: Write the tests**

Add to `test/transformer.test.ts`:

```typescript
describe('non-primitive return type mismatch for result', () => {
  it('warns when result is compared to number literal but return type is string', () => {
    const source = `
      /**
       * @post result === 42
       */
      export function getName(): string { return ""; }
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes('type mismatch') && w.includes('result')),
    ).toBe(true);
  });

  it('warns when result is compared to string literal but return type is a record', () => {
    const source = `
      /**
       * @post result === "ok"
       */
      export function getMap(): Record<string, unknown> { return {}; }
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes('type mismatch') && w.includes('result')),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests**

```
npx jest --testPathPattern="transformer" -t "non-primitive return type mismatch for result" --no-coverage
```

Expected: both PASSes. If not, check that `buildPostParamTypes` is calling `resolveSimpleType` correctly and that the `'result'` entry is being set in the map.

- [ ] **Step 3: Run full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```
git add test/transformer.test.ts
git commit -m "test: add coverage for non-primitive return type mismatch (result)"
```

---

## Task 5: Unary operand unwrapping (Fix #10)

**Files:**
- Modify: `src/contract-validator.ts:101-121` (`collectTypeMismatches`)
- Test: `test/transformer.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/transformer.test.ts`:

```typescript
describe('unary operand type-mismatch detection', () => {
  it('warns when negated string parameter appears in numeric comparison', () => {
    const source = `
      /**
       * @pre -amount > 0
       */
      export function pay(amount: string): void {}
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes('type mismatch') && w.includes('amount')),
    ).toBe(true);
  });

  it('warns when negated boolean parameter is compared to number literal', () => {
    const source = `
      /**
       * @pre !flag === 1
       */
      export function run(flag: boolean): void {}
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes('type mismatch') && w.includes('flag')),
    ).toBe(true);
  });

  it('does not warn when negated number parameter is used in numeric comparison', () => {
    const source = `
      /**
       * @pre -amount > 0
       */
      export function pay(amount: number): void {}
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to confirm first two fail**

```
npx jest --testPathPattern="transformer" -t "unary operand type-mismatch detection" --no-coverage
```

Expected: first two FAILs (no warning), third PASS.

- [ ] **Step 3: Add `extractIdentifierOperand` helper to `src/contract-validator.ts`**

Add before `collectTypeMismatches`:

```typescript
function extractIdentifierOperand(
  node: typescript.Node,
): typescript.Identifier | undefined {
  if (typescript.isIdentifier(node)) {
    return node;
  }
  if (
    typescript.isPrefixUnaryExpression(node) &&
    (
      node.operator === typescript.SyntaxKind.MinusToken ||
      node.operator === typescript.SyntaxKind.PlusToken ||
      node.operator === typescript.SyntaxKind.ExclamationToken
    ) &&
    typescript.isIdentifier(node.operand)
  ) {
    return node.operand;
  }
  return undefined;
}
```

- [ ] **Step 4: Update `collectTypeMismatches` to use `extractIdentifierOperand`**

Replace the `leftId`/`rightId` lines inside the `isBinaryExpression` block:

```typescript
function collectTypeMismatches(
  node: typescript.Node,
  expression: string,
  location: string,
  paramTypes: Map<string, SimpleType | 'non-primitive'>,
  errors: ValidationError[],
): void {
  if (typescript.isBinaryExpression(node)) {
    const leftId = extractIdentifierOperand(node.left);
    const rightId = extractIdentifierOperand(node.right);
    const leftParamType = leftId !== undefined ? paramTypes.get(leftId.text) : undefined;
    const rightParamType = rightId !== undefined ? paramTypes.get(rightId.text) : undefined;
    const leftLit = getLiteralSimpleType(node.left);
    const rightLit = getLiteralSimpleType(node.right);
    checkSideMismatch(leftId, leftParamType, rightLit, expression, location, errors);
    checkSideMismatch(rightId, rightParamType, leftLit, expression, location, errors);
  }
  typescript.forEachChild(node, (child) => {
    collectTypeMismatches(child, expression, location, paramTypes, errors);
  });
}
```

- [ ] **Step 5: Run tests to confirm they pass**

```
npx jest --testPathPattern="transformer" -t "unary operand type-mismatch detection" --no-coverage
```

Expected: all three PASSes.

- [ ] **Step 6: Run full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```
git add src/contract-validator.ts test/transformer.test.ts
git commit -m "feat: unwrap prefix unary operands before type-mismatch checking"
```
