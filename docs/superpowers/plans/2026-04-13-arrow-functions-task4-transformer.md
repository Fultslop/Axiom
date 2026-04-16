# Arrow Functions — Task 4: Wire `VariableStatement` branch in `transformer.ts`

> **Sequence:** This is step 4 of 6. Tasks 1, 2, and 3 must be complete before starting this task.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

We are adding `@pre`/`@post` contract injection support for exported `const` arrow functions and
function expressions.

**What previous tasks added (already in the codebase):**
- Task 1: `isExportedVariableInitialiser` + extended `buildLocationName` in `src/node-helpers.ts`
- Task 2: `extractContractTagsForFunctionLike` + updated `extractContractTags` in
  `src/jsdoc-parser.ts`
- Task 3: `normaliseArrowBody` + extended `applyNewBody` in `src/function-rewriter.ts`; three
  failing tests added in `test/transformer.test.ts`

**What this task does:**
Wires up the dispatch in `src/transformer.ts` so the three tests from Task 3 start passing.
Adds two helpers (`rewriteVariableDeclaration`, `visitVariableStatement`) and a new branch in
`visitNode` that handles `VariableStatement` nodes.

**Only `src/transformer.ts` changes in this task.**

---

## ESLint constraints (read before touching any `src/` file)

- `id-length: min 3` — no identifiers shorter than 3 characters.
- `complexity: 10` — keep functions small; extract helpers.
- `max-len: 100` — lines under 100 chars.
- No `console` — use the injectable `warn` callback.

---

## Steps

- [ ] **Step 1: Update imports in `src/transformer.ts`**

Update the import from `./function-rewriter` to include `normaliseArrowBody`:

```typescript
import {
  tryRewriteFunction, isPublicTarget, normaliseArrowBody,
} from './function-rewriter';
```

Update (or add) the import from `./node-helpers` to include `isExportedVariableInitialiser`:

```typescript
import { isExportedVariableInitialiser } from './node-helpers';
```

- [ ] **Step 2: Add `rewriteVariableDeclaration` helper in `src/transformer.ts`**

Add before the `visitNode` function:

```typescript
function rewriteVariableDeclaration(
  factory: typescript.NodeFactory,
  decl: typescript.VariableDeclaration,
  reparsedIndex: ReparsedIndex,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker: typescript.TypeChecker | undefined,
  allowIdentifiers: string[],
): typescript.VariableDeclaration {
  const init = decl.initializer;
  if (init === undefined) {
    return decl;
  }
  let funcNode: typescript.FunctionLikeDeclaration | undefined;
  if (typescript.isArrowFunction(init)) {
    funcNode = normaliseArrowBody(factory, init);
  } else if (typescript.isFunctionExpression(init)) {
    funcNode = init;
  }
  if (funcNode === undefined || !isExportedVariableInitialiser(funcNode)) {
    return decl;
  }
  const rewritten = tryRewriteFunction(
    factory,
    funcNode,
    reparsedIndex.functions,
    transformed,
    warn,
    checker,
    [],
    undefined,
    allowIdentifiers,
  );
  if (rewritten === funcNode) {
    return decl;
  }
  return factory.updateVariableDeclaration(
    decl,
    decl.name,
    decl.exclamationToken,
    decl.type,
    rewritten as typescript.Expression,
  );
}
```

- [ ] **Step 3: Add `visitVariableStatement` helper in `src/transformer.ts`**

Add after `rewriteVariableDeclaration`:

```typescript
function visitVariableStatement(
  factory: typescript.NodeFactory,
  node: typescript.VariableStatement,
  reparsedIndex: ReparsedIndex,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker: typescript.TypeChecker | undefined,
  allowIdentifiers: string[],
): typescript.VariableStatement {
  const modifiers = typescript.canHaveModifiers(node)
    ? typescript.getModifiers(node) ?? []
    : [];
  const isExported = modifiers.some(
    (mod) => mod.kind === typescript.SyntaxKind.ExportKeyword,
  );
  if (!isExported) {
    return node;
  }
  const newDeclarations = node.declarationList.declarations.map((decl) =>
    rewriteVariableDeclaration(
      factory, decl, reparsedIndex, transformed, warn, checker, allowIdentifiers,
    ),
  );
  const changed = newDeclarations.some(
    (decl, idx) => decl !== node.declarationList.declarations[idx],
  );
  if (!changed) {
    return node;
  }
  const newDeclList = factory.updateVariableDeclarationList(
    node.declarationList,
    newDeclarations,
  );
  return factory.updateVariableStatement(node, modifiers, newDeclList);
}
```

- [ ] **Step 4: Add `VariableStatement` branch to `visitNode` in `src/transformer.ts`**

Insert **before** the `return typescript.visitEachChild(...)` call at the end of `visitNode`:

```typescript
  if (typescript.isVariableStatement(node)) {
    return visitVariableStatement(
      factory,
      node as typescript.VariableStatement,
      reparsedIndex,
      transformed,
      warn,
      checker,
      allowIdentifiers,
    );
  }
```

- [ ] **Step 5: Run the failing tests from Task 3 — expect them to pass now**

```
npx jest --testPathPattern="transformer" -t "arrow function|function expression" --no-coverage
```

Expected: all three now PASS.

- [ ] **Step 6: Run full test suite**

```
npm test
```

Expected: all tests pass; no regressions.

- [ ] **Step 7: Run lint and typecheck**

```
npm run lint && npm run typecheck
```

Expected: no errors.

---

## Done when

- `npm run lint && npm run typecheck` exit 0.
- `npm test` exits 0 — all tests green including the three arrow/function-expression tests from
  Task 3.
- `src/transformer.ts` contains `rewriteVariableDeclaration`, `visitVariableStatement`, and the
  `isVariableStatement` branch in `visitNode`.
