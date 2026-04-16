# Arrow Functions — Task 2: JSDoc fallback in `jsdoc-parser.ts`

> **Sequence:** This is step 2 of 6. Task 1 must be complete before starting this task.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

We are adding `@pre`/`@post` contract injection support for exported `const` arrow functions and
function expressions.

**What Task 1 added (already in the codebase):**
- `isExportedVariableInitialiser` predicate in `src/node-helpers.ts`
- Extended `buildLocationName` to resolve variable name from parent `VariableDeclaration`

**What this task does:**
The TypeScript compiler does not propagate JSDoc from a `VariableStatement` to its inner
`ArrowFunction` or `FunctionExpression` when `getJSDocTags` is called on the function node
directly. This task adds a fallback so tags placed on the enclosing `const` statement are found.

We add `extractContractTagsForFunctionLike` to `src/jsdoc-parser.ts` and update
`extractContractTags` to call it. **No other files change in this task.**

---

## ESLint constraints (read before touching any `src/` file)

- `id-length: min 3` — no identifiers shorter than 3 characters.
- `complexity: 10` — keep functions small; extract helpers.
- `max-len: 100` — lines under 100 chars.
- No `console` — use the injectable `warn` callback.

---

## Steps

- [ ] **Step 1: Add `extractContractTagsForFunctionLike` to `src/jsdoc-parser.ts`**

Add after the existing `extractContractTags` function:

```typescript
export function extractContractTagsForFunctionLike(
  node: typescript.FunctionLikeDeclaration,
): ContractTag[] {
  const direct = extractContractTagsFromNode(node);
  if (direct.length > 0) {
    return direct;
  }
  // For ArrowFunction / FunctionExpression the JSDoc comment is attached to
  // the enclosing VariableStatement, not to the function node itself.
  if (
    (typescript.isArrowFunction(node) || typescript.isFunctionExpression(node)) &&
    typescript.isVariableDeclaration(node.parent) &&
    typescript.isVariableDeclarationList(node.parent.parent) &&
    typescript.isVariableStatement(node.parent.parent.parent)
  ) {
    return extractContractTagsFromNode(node.parent.parent.parent);
  }
  return [];
}
```

- [ ] **Step 2: Update `extractContractTags` to delegate to the new helper**

Replace the body of `extractContractTags` so it calls through to the new function:

```typescript
export function extractContractTags(
  node: typescript.FunctionLikeDeclaration,
): ContractTag[] {
  return extractContractTagsForFunctionLike(node);
}
```

- [ ] **Step 3: Run lint and typecheck**

```
npm run lint && npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Run full test suite**

```
npm test
```

Expected: all existing tests pass; no regressions.
The new function is exercised end-to-end in Task 3 and Task 4, so no new test is added here.

---

## Done when

- `npm run lint && npm run typecheck` exit 0.
- `npm test` exits 0 with no regressions.
- `src/jsdoc-parser.ts` exports `extractContractTagsForFunctionLike`.
- `extractContractTags` delegates to `extractContractTagsForFunctionLike`.
