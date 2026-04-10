# Multi-Level Property Chain Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a TypeChecker is available, validate that each property name in a chain like `this.config.limit` actually exists on the accessed type, emitting a targeted warning and dropping the contract when a property is misspelled or absent.

**Architecture:** All new logic lives in `src/contract-validator.ts`. Contract expressions are re-parsed from strings and have no TS program context, so the approach walks the chain structure (root identifier + list of property names) and resolves each step against the TypeChecker using the *original* AST node as the anchor. `validateExpression` gains two optional parameters (`checker`, `contextNode`) that existing call sites can ignore. `filterValidTags` in `src/function-rewriter.ts` passes those two new arguments when they are available.

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
| `src/contract-validator.ts` | Add `PropertyChain` interface; add `extractPropertyChain`, `resolveRootType`, `collectDeepPropertyErrors`; extend `validateExpression` with optional `checker` and `contextNode` params |
| `src/function-rewriter.ts` | Update `filterValidTags` to accept and forward `checker` and `node`; update the two call sites in `rewriteFunction` |
| `test/transformer.test.ts` | New describe block for property chain validation |

---

## Task 1: Chain extraction helper

**Files:**
- Modify: `src/contract-validator.ts`
- Test: (inline — verified as part of Task 3's integration tests)

- [ ] **Step 1: Add the `PropertyChain` interface and `extractPropertyChain` to `src/contract-validator.ts`**

Add after the `ASSIGNMENT_OPERATORS` block (after line 35), before `collectUnknownIdentifiers`:

```typescript
interface PropertyChain {
  root: string;
  properties: string[];
}

function extractPropertyChain(
  node: typescript.Node,
): PropertyChain | undefined {
  if (typescript.isPropertyAccessExpression(node)) {
    const inner = extractPropertyChain(node.expression);
    if (inner === undefined) {
      return undefined;
    }
    return { root: inner.root, properties: [...inner.properties, node.name.text] };
  }
  if (typescript.isIdentifier(node)) {
    return { root: node.text, properties: [] };
  }
  return undefined; // call expressions, element access, etc. — not handled
}
```

- [ ] **Step 2: Run full suite to confirm nothing is broken**

```
npm test
```

Expected: all tests pass (no behaviour change yet).

- [ ] **Step 3: Commit**

```
git add src/contract-validator.ts
git commit -m "refactor: add extractPropertyChain helper to contract-validator"
```

---

## Task 2: Root type resolution

**Files:**
- Modify: `src/contract-validator.ts`

- [ ] **Step 1: Add `resolveRootType` to `src/contract-validator.ts`**

Add after `extractPropertyChain`:

```typescript
function resolveRootType(
  rootName: string,
  checker: typescript.TypeChecker,
  contextNode: typescript.FunctionLikeDeclaration,
): typescript.Type | undefined {
  if (rootName === 'this') {
    if (
      typescript.isClassDeclaration(contextNode.parent) &&
      contextNode.parent.name !== undefined
    ) {
      const classSymbol = checker.getSymbolAtLocation(contextNode.parent.name);
      if (classSymbol !== undefined) {
        return checker.getDeclaredTypeOfSymbol(classSymbol);
      }
    }
    return undefined;
  }
  for (const param of contextNode.parameters) {
    if (typescript.isIdentifier(param.name) && param.name.text === rootName) {
      return checker.getTypeAtLocation(param);
    }
  }
  return undefined;
}
```

- [ ] **Step 2: Run full suite**

```
npm test
```

Expected: all tests pass (no behaviour change yet).

- [ ] **Step 3: Commit**

```
git add src/contract-validator.ts
git commit -m "refactor: add resolveRootType helper to contract-validator"
```

---

## Task 3: `collectDeepPropertyErrors`, extend `validateExpression`, thread through `filterValidTags`

This is the main wiring task. Write tests first, then add `collectDeepPropertyErrors`, extend `validateExpression`, and update `filterValidTags`.

**Files:**
- Modify: `src/contract-validator.ts:147-163` (`validateExpression`)
- Modify: `src/function-rewriter.ts:165-192` (`filterValidTags`)
- Test: `test/transformer.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/transformer.test.ts` (uses `transformWithProgram`):

```typescript
describe('property chain validation', () => {
  it('drops @pre with a misspelled this-property and emits a warning', () => {
    const source = `
      class BankAccount {
        balance: number = 0;
        /**
         * @pre this.balanc > 0
         */
        withdraw(amount: number): void {}
      }
    `;
    const warnings: string[] = [];
    const output = transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes('balanc'))).toBe(true);
    expect(output).not.toContain('!(this.balanc > 0)');
  });

  it('injects @pre with a correctly spelled this-property without warning', () => {
    const source = `
      class BankAccount {
        balance: number = 0;
        /**
         * @pre this.balance > 0
         */
        withdraw(amount: number): void {}
      }
    `;
    const warnings: string[] = [];
    const output = transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
    expect(output).toContain('!(this.balance > 0)');
  });

  it('drops @pre when an intermediate chain property is missing', () => {
    const source = `
      interface Config { timeout: number }
      class Service {
        cfg: Config = { timeout: 10 };
        /**
         * @pre this.cfg.limit > 0
         */
        run(): void {}
      }
    `;
    const warnings: string[] = [];
    const output = transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes('limit'))).toBe(true);
    expect(output).not.toContain('!(this.cfg.limit > 0)');
  });

  it('injects @pre when all properties in a two-level chain exist', () => {
    const source = `
      interface Config { timeout: number }
      class Service {
        cfg: Config = { timeout: 10 };
        /**
         * @pre this.cfg.timeout > 0
         */
        run(): void {}
      }
    `;
    const warnings: string[] = [];
    const output = transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
    expect(output).toContain('!(this.cfg.timeout > 0)');
  });

  it('injects @pre with misspelled this-property in transpileModule mode (no checker)', () => {
    // In transpileModule mode, deep chain validation is skipped — no warning, contract injected
    const source = `
      class BankAccount {
        balance: number = 0;
        /**
         * @pre this.balanc > 0
         */
        withdraw(amount: number): void {}
      }
    `;
    const warnings: string[] = [];
    const output = transform(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
    expect(output).toContain('!(this.balanc > 0)');
  });
});
```

- [ ] **Step 2: Run to confirm the right tests fail**

```
npx jest --testPathPattern="transformer" -t "property chain validation" --no-coverage
```

Expected: tests 1, 3 FAIL (no warning, contract injected); tests 2, 4, 5 PASS.

- [ ] **Step 3: Add `collectDeepPropertyErrors` to `src/contract-validator.ts`**

Add after `resolveRootType`:

```typescript
function collectDeepPropertyErrors(
  node: typescript.Node,
  expression: string,
  location: string,
  checker: typescript.TypeChecker,
  contextNode: typescript.FunctionLikeDeclaration,
  errors: ValidationError[],
): void {
  if (typescript.isPropertyAccessExpression(node)) {
    const chain = extractPropertyChain(node);
    if (chain !== undefined && chain.properties.length > 0) {
      const rootType = resolveRootType(chain.root, checker, contextNode);
      if (rootType !== undefined) {
        let currentType: typescript.Type = rootType;
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
            break; // stop at first missing step
          }
          currentType = checker.getTypeOfSymbol(symbol);
        }
      }
    }
  }
  typescript.forEachChild(node, (child) =>
    collectDeepPropertyErrors(child, expression, location, checker, contextNode, errors));
}
```

- [ ] **Step 4: Extend `validateExpression` in `src/contract-validator.ts`**

Replace the current `validateExpression` signature and body:

```typescript
export function validateExpression(
  node: typescript.Expression,
  expression: string,
  location: string,
  knownIdentifiers?: Set<string>,
  paramTypes?: Map<string, SimpleType>,
  checker?: typescript.TypeChecker,
  contextNode?: typescript.FunctionLikeDeclaration,
): ValidationError[] {
  const errors: ValidationError[] = [];
  collectAssignments(node, expression, location, errors);
  if (knownIdentifiers !== undefined) {
    collectUnknownIdentifiers(node, expression, location, knownIdentifiers, errors);
  }
  if (paramTypes !== undefined) {
    collectTypeMismatches(node, expression, location, paramTypes, errors);
  }
  if (checker !== undefined && contextNode !== undefined) {
    collectDeepPropertyErrors(node, expression, location, checker, contextNode, errors);
  }
  return errors;
}
```

Note: if the type-checking-gaps plan has already been merged, the `paramTypes` parameter type will already be `Map<string, SimpleType | 'non-primitive'>` — keep that wider type here.

- [ ] **Step 5: Update `filterValidTags` in `src/function-rewriter.ts`**

Add two optional parameters at the end:

```typescript
export function filterValidTags(
  tags: ContractTag[],
  kind: 'pre' | 'post',
  location: string,
  warn: (msg: string) => void,
  knownIdentifiers: Set<string>,
  paramTypes?: Map<string, SimpleType>,
  checker?: typescript.TypeChecker,
  contextNode?: typescript.FunctionLikeDeclaration,
): ContractTag[] {
  return tags.filter((tag) => {
    const errors = validateExpression(
      parseContractExpression(tag.expression),
      tag.expression,
      location,
      knownIdentifiers,
      paramTypes,
      checker,
      contextNode,
    );
    if (errors.length > 0) {
      errors.forEach((err) => {
        warn(
          `[axiom] Contract validation warning in ${location}:`
          + `\n  @${kind} ${err.expression} — ${err.message}`,
        );
      });
      return false;
    }
    return true;
  });
}
```

Note: same `Map<string, SimpleType | 'non-primitive'>` widening applies if type-checking-gaps plan is already merged.

- [ ] **Step 6: Pass `checker` and `node` when calling `filterValidTags` in `rewriteFunction`**

In `src/function-rewriter.ts`, the two `filterValidTags` calls inside `rewriteFunction` (around lines 333-354) become:

```typescript
const preTags = filterValidTags(
  allPreInput, KIND_PRE, location, warn, preKnown, paramTypes, checker, node,
);
```

```typescript
const postTags = filterValidTags(
  postTagsFiltered, KIND_POST, location, warn, postKnown, postParamTypes, checker, node,
);
```

- [ ] **Step 7: Run tests to confirm they pass**

```
npx jest --testPathPattern="transformer" -t "property chain validation" --no-coverage
```

Expected: all five PASSes.

- [ ] **Step 8: Run full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```
git add src/contract-validator.ts src/function-rewriter.ts test/transformer.test.ts
git commit -m "feat: validate multi-level property chains against TypeChecker in contract expressions"
```
