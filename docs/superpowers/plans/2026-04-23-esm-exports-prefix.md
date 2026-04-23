# ESM Exports Prefix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For ESM module targets, emit bare identifiers in contract guards instead of `exports.Name` prefix, while CJS targets remain unchanged.

**Architecture:** Add `isEsm: boolean` to `TransformerContext`, computed from `compilerOptions.module` in the transformer factory; thread it through `ast-builder.ts`'s guard-building chain so `substituteContractIdentifiers` skips the `exports.` prefix when targeting ESM.

**Tech Stack:** TypeScript AST transformer API, Jest

---

### Task 1: Add `isEsm` to `TransformerContext` and compute it in `transformer.ts`

**Files:**
- Modify: `src/transformer-context.ts`
- Modify: `src/transformer.ts`

- [ ] **Step 1: Verify baseline typecheck passes**

Run: `npm run typecheck`
Expected: PASS (confirms clean starting state)

- [ ] **Step 2: Add `isEsm` to `TransformerContext`**

In `src/transformer-context.ts`, replace the full file content with:

```typescript
import type typescript from 'typescript';
import type { KeepContracts } from './keep-contracts';
import type { ParamMismatchMode } from './interface-resolver';
import type { ReparsedIndex } from './reparsed-index';

export type TransformerContext = {
  factory: typescript.NodeFactory;
  warn: (msg: string) => void;
  checker: typescript.TypeChecker | undefined;
  allowIdentifiers: string[];
  keepContracts: KeepContracts;
  paramMismatch: ParamMismatchMode;
  reparsedIndex: ReparsedIndex;
  reparsedCache: Map<string, typescript.SourceFile>;
  transformed: { value: boolean };
  isEsm: boolean;
};
```

- [ ] **Step 3: Verify typecheck reports the expected error**

Run: `npm run typecheck`
Expected: FAIL — `src/transformer.ts` reports `baseCtx` is missing property `isEsm`

- [ ] **Step 4: Compute `isEsm` and add it to `baseCtx` in `transformer.ts`**

In `src/transformer.ts`, find the factory closure (the `return (tsContext: typescript.TransformationContext) => {` block at line ~459) and replace it with:

```typescript
  return (tsContext: typescript.TransformationContext) => {
    const { module: moduleKind = typescript.ModuleKind.CommonJS } = tsContext.getCompilerOptions();
    const isEsm =
      moduleKind === typescript.ModuleKind.ES2015 ||
      moduleKind === typescript.ModuleKind.ES2020 ||
      moduleKind === typescript.ModuleKind.ES2022 ||
      moduleKind === typescript.ModuleKind.ESNext ||
      moduleKind === typescript.ModuleKind.Node16 ||
      moduleKind === typescript.ModuleKind.NodeNext;
    const baseCtx: TransformerContext = {
      factory: tsContext.factory,
      warn,
      checker,
      allowIdentifiers,
      keepContracts,
      paramMismatch,
      reparsedIndex: { functions: new Map(), classes: new Map() }, // replaced per file
      reparsedCache,
      transformed: { value: false },                               // replaced per file
      isEsm,
    };
    return (sourceFile: typescript.SourceFile): typescript.SourceFile =>
      transformSourceFile(sourceFile, tsContext, baseCtx);
  };
```

- [ ] **Step 5: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Run tests to confirm no regressions**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/transformer-context.ts src/transformer.ts
git commit -m "feat: add isEsm to TransformerContext, compute from compilerOptions.module"
```

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

---

### Task 3: Thread `isEsm` through `function-rewriter.ts` and add integration tests

**Files:**
- Modify: `src/function-rewriter.ts`
- Create: `test/transformer.esm-exports.test.ts`

- [ ] **Step 1: Write failing integration tests**

Create `test/transformer.esm-exports.test.ts`:

```typescript
import typescript from 'typescript';
import createTransformer from '@src/transformer';

function transformWithModuleKind(source: string, moduleKind: typescript.ModuleKind): string {
  const result = typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2020,
      module: moduleKind,
    },
    transformers: {
      before: [createTransformer()],
    },
  });
  return result.outputText;
}

describe('transformer — ESM exports prefix', () => {
  describe('CJS target regression', () => {
    it('emits exports. prefix for exported const in @pre with CommonJS output', () => {
      const source = `
        export const MAX_LIMIT = 100;
        /**
         * @pre n <= MAX_LIMIT
         */
        export function cap(n: number): number { return n; }
      `;
      const output = transformWithModuleKind(source, typescript.ModuleKind.CommonJS);
      expect(output).toContain('exports.MAX_LIMIT');
      expect(output).toContain('!(n <= exports.MAX_LIMIT)');
    });

    it('emits exports. prefix for exported enum in @pre with CommonJS output', () => {
      const source = `
        export enum Mode { Fast = 0, Slow = 1 }
        /**
         * @pre mode === Mode.Fast
         */
        export function checkMode(mode: number): void {}
      `;
      const output = transformWithModuleKind(source, typescript.ModuleKind.CommonJS);
      expect(output).toContain('!(mode === exports.Mode.Fast)');
    });
  });

  describe('ESM targets — ESNext', () => {
    it('emits bare identifier for exported const in @pre with ESNext output', () => {
      const source = `
        export const MAX_LIMIT = 100;
        /**
         * @pre n <= MAX_LIMIT
         */
        export function cap(n: number): number { return n; }
      `;
      const output = transformWithModuleKind(source, typescript.ModuleKind.ESNext);
      expect(output).toContain('!(n <= MAX_LIMIT)');
      expect(output).not.toContain('!(n <= exports.MAX_LIMIT)');
    });

    it('emits bare identifier for exported const in @post with ESNext output', () => {
      const source = `
        export const MAX = 50;
        /**
         * @post result <= MAX
         */
        export function clamp(n: number): number { return Math.min(n, MAX); }
      `;
      const output = transformWithModuleKind(source, typescript.ModuleKind.ESNext);
      expect(output).toContain('!(result <= MAX)');
      expect(output).not.toContain('!(result <= exports.MAX)');
    });

    it('does not emit exports. in guard for parameter-only @pre with ESNext output', () => {
      const source = `
        /**
         * @pre n > 0
         */
        export function positive(n: number): number { return n; }
      `;
      const output = transformWithModuleKind(source, typescript.ModuleKind.ESNext);
      expect(output).toContain('!(n > 0)');
    });
  });

  describe('ESM targets — ES2022', () => {
    it('emits bare identifier for exported const in @pre with ES2022 output', () => {
      const source = `
        export const CAP = 200;
        /**
         * @pre x < CAP
         */
        export function limit(x: number): number { return x; }
      `;
      const output = transformWithModuleKind(source, typescript.ModuleKind.ES2022);
      expect(output).toContain('!(x < CAP)');
      expect(output).not.toContain('!(x < exports.CAP)');
    });
  });

  describe('ESM targets — Node16', () => {
    it('emits bare identifier in guard for exported enum in @post with Node16', () => {
      const source = `
        export enum Status { Ok = 0, Fail = 1 }
        /**
         * @post result === Status.Ok
         */
        export function run(): number { return 0; }
      `;
      const output = transformWithModuleKind(source, typescript.ModuleKind.Node16);
      expect(output).toContain('!(result === Status.Ok)');
      expect(output).not.toContain('!(result === exports.Status.Ok)');
    });
  });
});
```

- [ ] **Step 2: Run the new tests to confirm the ESM tests fail**

Run: `npm test -- --testPathPattern=transformer.esm-exports`
Expected: The CJS regression tests pass; the ESM tests fail because `buildGuardedStatements` still calls `buildPreCheck`/`buildPostCheck` without `isEsm`, defaulting to `false` (CJS behaviour).

- [ ] **Step 3: Add `isEsm` parameter to `buildGuardedStatements` and thread through calls**

In `src/function-rewriter.ts`, replace the `buildGuardedStatements` function signature and its two call sites for `buildPreCheck`/`buildPostCheck` (lines 100–139):

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
  keepContracts: KeepContracts,
  isAsync: boolean,
  isEsm: boolean,
): typescript.Statement[] {
  const statements: typescript.Statement[] = [];

  const activePre = shouldEmitPre(keepContracts) ? preTags : [];
  const activePost = shouldEmitPost(keepContracts) ? postTags : [];
  const activeInvariant = shouldEmitInvariant(keepContracts) ? invariantCall : null;

  for (const tag of activePre) {
    statements.push(buildPreCheck(tag.expression, location, factory, exportedNames, isEsm));
  }

  if (activePost.length > 0 || activeInvariant !== null) {
    if (prevCapture !== null) {
      statements.push(buildPrevCapture(prevCapture, factory));
    }
    statements.push(buildBodyCapture(originalBody.statements, factory, isAsync));
    for (const tag of activePost) {
      statements.push(buildPostCheck(tag.expression, location, factory, exportedNames, isEsm));
    }
    if (activeInvariant !== null) {
      statements.push(activeInvariant);
    }
    statements.push(buildResultReturn(factory));
  } else {
    statements.push(...Array.from(originalBody.statements));
  }

  return statements;
}
```

- [ ] **Step 4: Pass `ctx.isEsm` to `buildGuardedStatements` in `rewriteFunction`**

In `src/function-rewriter.ts`, in the `rewriteFunction` function (around line 525), replace the call:

```typescript
  const newStatements = buildGuardedStatements(
    factory, preTags, postTags, originalBody, location, invariantCall,
    prevCapture, exportedNames, keepContracts, asyncFlag,
  );
```

With:

```typescript
  const newStatements = buildGuardedStatements(
    factory, preTags, postTags, originalBody, location, invariantCall,
    prevCapture, exportedNames, keepContracts, asyncFlag, ctx.isEsm,
  );
```

- [ ] **Step 5: Pass `ctx.isEsm` to `buildGuardedStatements` in `rewriteNestedFunctionLike`**

In `src/function-rewriter.ts`, in the `rewriteNestedFunctionLike` function (around line 321), replace the call:

```typescript
  const newStatements = buildGuardedStatements(
    factory, preTags, postTags, originalBody, location,
    null, prevCapture, exportedNames, keepContracts, asyncFlag,
  );
```

With:

```typescript
  const newStatements = buildGuardedStatements(
    factory, preTags, postTags, originalBody, location,
    null, prevCapture, exportedNames, keepContracts, asyncFlag, ctx.isEsm,
  );
```

- [ ] **Step 6: Run the integration tests to confirm they all pass**

Run: `npm test -- --testPathPattern=transformer.esm-exports`
Expected: PASS — all 7 tests pass

- [ ] **Step 7: Run all tests to confirm no regressions**

Run: `npm test`
Expected: All tests pass (including existing `exports.` tests in `test/transformer.identifier-scoping.test.ts`)

- [ ] **Step 8: Commit**

```bash
git add src/function-rewriter.ts test/transformer.esm-exports.test.ts
git commit -m "feat: thread isEsm through function-rewriter, skip exports. prefix for ESM targets"
```
