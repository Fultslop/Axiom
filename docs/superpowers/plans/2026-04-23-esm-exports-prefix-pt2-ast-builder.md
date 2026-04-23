# Plan: ESM Exports Prefix — Part 2: AST Builder Implementation Plan

Status: complete

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `isEsm` parameter to `substituteContractIdentifiers`, `buildGuardIf`, `buildPreCheck`, and `buildPostCheck` in `ast-builder.ts` so guard builders can skip the `exports.` prefix when targeting ESM.

**Architecture:** `isEsm` is threaded as a default-`false` parameter through the guard-building chain. The `substituteContractIdentifiers` function skips the `exports.` prefix substitution when `isEsm` is `true`. All existing callers that omit the parameter continue to use CJS behaviour unchanged.

**Tech Stack:** TypeScript AST transformer API, Jest

**Depends on:** Part 1 (`isEsm` must exist on `TransformerContext`) — but unit tests in this part can be written and run independently since they call `buildPreCheck`/`buildPostCheck` directly with the new parameter.

**Unlocks:** Part 3 can proceed once this merges (it calls `buildPreCheck`/`buildPostCheck` with `isEsm`).

---

### Task 2: Update `ast-builder.ts` — skip `exports.` substitution in ESM mode

**Files:**
- Modify: `src/ast-builder.ts`
- Test: `test/ast-builder.test.ts`

- [ ] **Step 1: Write failing unit tests**

In `test/ast-builder.test.ts`, add these two describe blocks after the existing `buildPostCheck` describe block:

```typescript
describe('buildPreCheck — ESM exported name handling', () => {
  it('uses exports. prefix for exported name in CJS mode (isEsm=false)', () => {
    const exportedNames = new Set(['MAX_LIMIT']);
    const node = buildPreCheck('x < MAX_LIMIT', 'cap', typescript.factory, exportedNames, false);
    const output = printNode(node);
    expect(output).toContain('exports.MAX_LIMIT');
    expect(output).toContain('!(x < exports.MAX_LIMIT)');
  });

  it('uses bare identifier for exported name in ESM mode (isEsm=true)', () => {
    const exportedNames = new Set(['MAX_LIMIT']);
    const node = buildPreCheck('x < MAX_LIMIT', 'cap', typescript.factory, exportedNames, true);
    const output = printNode(node);
    expect(output).not.toContain('exports.MAX_LIMIT');
    expect(output).toContain('!(x < MAX_LIMIT)');
  });
});

describe('buildPostCheck — ESM exported name handling', () => {
  it('uses exports. prefix for exported name in CJS mode (isEsm=false)', () => {
    const exportedNames = new Set(['MAX']);
    const node = buildPostCheck('result <= MAX', 'clamp', typescript.factory, exportedNames, false);
    const output = printNode(node);
    expect(output).toContain('exports.MAX');
  });

  it('uses bare identifier for exported name in ESM mode (isEsm=true)', () => {
    const exportedNames = new Set(['MAX']);
    const node = buildPostCheck('result <= MAX', 'clamp', typescript.factory, exportedNames, true);
    const output = printNode(node);
    expect(output).not.toContain('exports.');
    expect(output).toContain(`!(${AXIOM_RESULT_VAR} <= MAX)`);
  });
});
```

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `npm test -- --testPathPattern=ast-builder`
Expected: TypeScript compile error — `Expected 2-4 arguments, but got 5` (the `isEsm` parameter does not yet exist)

- [ ] **Step 3: Add `isEsm` parameter to `substituteContractIdentifiers`**

In `src/ast-builder.ts`, replace the `substituteContractIdentifiers` function (lines 28–51):

```typescript
function substituteContractIdentifiers(
  factory: typescript.NodeFactory,
  node: typescript.Expression,
  exportedNames: Set<string> = new Set(),
  isEsm: boolean = false,
): typescript.Expression {
  const visitor = (child: typescript.Node): typescript.Node => {
    if (typescript.isIdentifier(child)) {
      if (child.text === IDENTIFIER_RESULT) {
        return factory.createIdentifier(AXIOM_RESULT_VAR);
      }
      if (child.text === IDENTIFIER_PREV) {
        return factory.createIdentifier(AXIOM_PREV_VAR);
      }
      if (!isEsm && exportedNames.has(child.text)) {
        return factory.createPropertyAccessExpression(
          factory.createIdentifier('exports'),
          factory.createIdentifier(child.text),
        );
      }
    }
    return typescript.visitEachChild(child, visitor, undefined);
  };
  return typescript.visitNode(node, visitor) as typescript.Expression;
}
```

- [ ] **Step 4: Add `isEsm` parameter to `buildGuardIf`**

In `src/ast-builder.ts`, replace the `buildGuardIf` function (lines 72–101):

```typescript
function buildGuardIf(
  factory: typescript.NodeFactory,
  expression: string,
  body: typescript.ThrowStatement,
  substituteIdentifiers = false,
  exportedNames: Set<string> = new Set(),
  isEsm: boolean = false,
): typescript.IfStatement {
  const tempSourceFile = typescript.createSourceFile(
    'expr.ts',
    `!(${expression})`,
    typescript.ScriptTarget.ES2020,
    true,
  );

  const parsedCondition = tempSourceFile.statements[0];

  if (!parsedCondition || !typescript.isExpressionStatement(parsedCondition)) {
    throw new Error(`Failed to parse contract expression: ${expression}`);
  }

  let expressionToReify = parsedCondition.expression;
  if (substituteIdentifiers || exportedNames.size > 0) {
    expressionToReify = substituteContractIdentifiers(
      factory, parsedCondition.expression, exportedNames, isEsm,
    );
  }
  const synthesizedCondition = reifyExpression(factory, expressionToReify);

  return factory.createIfStatement(synthesizedCondition, body);
}
```

- [ ] **Step 5: Add `isEsm` parameter to `buildPreCheck`**

In `src/ast-builder.ts`, replace the `buildPreCheck` function (lines 103–116):

```typescript
export function buildPreCheck(
  expression: string,
  location: string,
  factory: typescript.NodeFactory = typescript.factory,
  exportedNames: Set<string> = new Set(),
  isEsm: boolean = false,
): typescript.IfStatement {
  return buildGuardIf(
    factory,
    expression,
    buildThrowContractViolation(factory, PRE_CONTRACT, expression, location),
    false,
    exportedNames,
    isEsm,
  );
}
```

- [ ] **Step 6: Add `isEsm` parameter to `buildPostCheck`**

In `src/ast-builder.ts`, replace the `buildPostCheck` function (lines 118–131):

```typescript
export function buildPostCheck(
  expression: string,
  location: string,
  factory: typescript.NodeFactory = typescript.factory,
  exportedNames: Set<string> = new Set(),
  isEsm: boolean = false,
): typescript.IfStatement {
  return buildGuardIf(
    factory,
    expression,
    buildThrowContractViolation(factory, POST_CONTRACT, expression, location),
    true,
    exportedNames,
    isEsm,
  );
}
```

- [ ] **Step 7: Run the new tests to confirm they pass**

Run: `npm test -- --testPathPattern=ast-builder`
Expected: PASS — all ast-builder tests pass

- [ ] **Step 8: Run all tests to confirm no regressions**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 9: Commit**

```bash
git add src/ast-builder.ts test/ast-builder.test.ts
git commit -m "feat: add isEsm to substituteContractIdentifiers and guard builders"
```
