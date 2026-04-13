# Arrow Functions and Function Expressions — Design Doc

**Date:** 2026-04-13
**Issue:** #14 — `@pre`/`@post` tags on arrow functions and function expressions are silently skipped

---

## 1. Problem

The transformer only visits `FunctionDeclaration` and `MethodDeclaration` nodes. In `src/transformer.ts`, `visitNode` checks `typescript.isFunctionDeclaration(node)` and `typescript.isClassDeclaration(node)` — there is no branch for `VariableStatement` nodes that contain arrow function or function expression initialisers.

As a result, the following are silently skipped — tags are parsed and then discarded with no warning, and the output is unchanged:

```typescript
// Arrow function assigned to exported const
export const validate = /** @pre x > 0 */ (x: number): boolean => x > 0;

// Function expression assigned to exported const
export const process = /** @pre input.length > 0 */ function(input: string): string {
  return input.trim();
};
```

The `reparsed-index.ts` visitor does call `typescript.isFunctionLike(node)` which visits `ArrowFunction` and `FunctionExpression`, so the reparsed index is populated. The problem is exclusively in the transformer dispatch in `visitNode`.

A secondary problem: `applyNewBody` in `function-rewriter.ts` only handles `MethodDeclaration` and `FunctionDeclaration`; it returns `null` for any other node kind, meaning a rewrite of an `ArrowFunction` or `FunctionExpression` would be silently abandoned even if the dispatch were fixed.

---

## 2. Goal

- `@pre` and `@post` tags on `ArrowFunction` and `FunctionExpression` nodes that are assigned to `export const` declarations are recognised, validated, and injected.
- The location string in generated assertions uses the variable name from the enclosing `VariableDeclaration`.
- Arrow functions with expression bodies (`(x) => x + 1`) are normalised to block bodies before rewriting so `result` capture works identically to the existing block-body path.
- No behavioural change to `FunctionDeclaration` or `MethodDeclaration` handling.
- No support added for non-exported or deeply nested arrow/function-expression forms (deferred — see section 8).

---

## 3. Supported Forms

The following forms are in scope for this spec:

| Form | AST shape | In scope |
|------|-----------|----------|
| `export const foo = (x) => expr` | `VariableStatement` > `VariableDeclaration` > `ArrowFunction` (expression body) | Yes |
| `export const foo = (x) => { ... }` | `VariableStatement` > `VariableDeclaration` > `ArrowFunction` (block body) | Yes |
| `export const foo = function(x) { ... }` | `VariableStatement` > `VariableDeclaration` > `FunctionExpression` | Yes |
| `export const foo = function named(x) { ... }` | As above, with optional name on the `FunctionExpression` | Yes |
| Class field arrow: `foo = (x) => ...` | `PropertyDeclaration` > `ArrowFunction` | No (see section 8) |
| Non-exported `const foo = ...` | `VariableStatement` without `export` | No (see section 8) |
| Nested/closure functions | `FunctionDeclaration` / `ArrowFunction` inside another function body | No (see section 8) |

JSDoc is attached to the `VariableStatement` in the TypeScript AST. For exported `const` declarations, the JSDoc comment must precede the `const` keyword, not the arrow/function keyword, for TypeScript's JSDoc resolver to attach it.

---

## 4. Approach

### 4.1 Transformer dispatch (`src/transformer.ts`)

Add a new branch in `visitNode` that fires when the node is a `VariableStatement` carrying at least one `ArrowFunction` or `FunctionExpression` initialiser on an exported `const` declaration.

The check is:

1. `typescript.isVariableStatement(node)` — node is a variable statement
2. The statement has an `export` modifier (same `isNodeExported` helper already in `function-rewriter.ts`)
3. `node.declarationList.declarations` is iterated; for each `VariableDeclaration` whose initialiser is `typescript.isArrowFunction` or `typescript.isFunctionExpression`, a rewrite is attempted

If a rewrite produces a new function node the `VariableDeclaration`'s initialiser is replaced, and the containing `VariableStatement` is updated. If no declarations change, the original node is returned unchanged.

The existing `FunctionDeclaration` and `ClassDeclaration` branches are not touched.

### 4.2 Location string (`src/node-helpers.ts`)

`buildLocationName` currently handles `MethodDeclaration` and `FunctionDeclaration`. It must be extended to resolve the name from the enclosing context when given an `ArrowFunction` or `FunctionExpression`.

The extended lookup chain:

1. If the function node's parent is a `VariableDeclaration` and `parent.name` is an `Identifier`, return `parent.name.text`.
2. If the `FunctionExpression` itself has a `name` property (named function expression), use `node.name.text` as a fallback if parent resolution fails.
3. Otherwise return `'<anonymous>'`.

This means `export const validate = (x) => ...` produces location string `"validate"`, consistent with how `FunctionDeclaration` named `validate` would behave.

### 4.3 Expression body normalisation (`src/function-rewriter.ts`)

The existing `rewriteFunction` helper begins with:

```typescript
const originalBody = node.body;
if (!originalBody || !typescript.isBlock(originalBody)) {
  return null;
}
```

For `ArrowFunction` with an expression body, `node.body` is an `Expression`, not a `Block`, so the guard returns `null` immediately.

The fix is: before passing an `ArrowFunction` to `rewriteFunction`, convert an expression body to a block body:

```typescript
// Expression: (x) => x > 0
// Block equivalent: (x) => { return x > 0; }
```

This normalisation is performed in a new helper `normaliseArrowBody`:

```typescript
function normaliseArrowBody(
  factory: typescript.NodeFactory,
  node: typescript.ArrowFunction,
): typescript.ArrowFunction {
  if (typescript.isBlock(node.body)) {
    return node; // already a block body — nothing to do
  }
  const returnStmt = factory.createReturnStatement(node.body as typescript.Expression);
  const block = factory.createBlock([returnStmt], /* multiLine */ true);
  return factory.updateArrowFunction(
    node,
    typescript.getModifiers(node),
    node.typeParameters,
    node.parameters,
    node.type,
    node.equalsGreaterThanToken,
    block,
  );
}
```

The normalised `ArrowFunction` is then passed to `rewriteFunction`. Because `rewriteFunction` receives a `FunctionLikeDeclaration`, `ArrowFunction` already satisfies that union type — no signature change is needed.

### 4.4 `applyNewBody` extension (`src/function-rewriter.ts`)

`applyNewBody` must handle `ArrowFunction` and `FunctionExpression`:

```typescript
if (typescript.isArrowFunction(node)) {
  return factory.updateArrowFunction(
    node,
    typescript.getModifiers(node),
    node.typeParameters,
    node.parameters,
    node.type,
    node.equalsGreaterThanToken,
    newBody,
  );
}
if (typescript.isFunctionExpression(node)) {
  return factory.updateFunctionExpression(
    node,
    typescript.getModifiers(node),
    node.asteriskToken,
    node.name,      // preserve optional name of named function expression
    node.typeParameters,
    node.parameters,
    node.type,
    newBody,
  );
}
```

Both branches sit before the existing `null` fallback return.

### 4.5 JSDoc resolution (`src/jsdoc-parser.ts` / `src/reparsed-index.ts`)

`extractContractTags` calls `typescript.getJSDocTags(node)` on the reparsed function node. In the TypeScript compiler, `getJSDocTags` walks up to the nearest JSDoc-eligible ancestor. For an `ArrowFunction` or `FunctionExpression` that is the initialiser of a `VariableDeclaration`, the JSDoc comment is attached to the `VariableStatement`, not to the function node itself.

In testing this must be confirmed. If `getJSDocTags` on the `ArrowFunction`/`FunctionExpression` node does not walk up to the `VariableStatement`, the extraction will return an empty tag list and contracts will be silently dropped.

Two strategies to handle this:

**Strategy A (preferred — minimal change):** After `reparsedNode = reparsedFunctions.get(node.pos) ?? node`, check whether `extractContractTags(reparsedNode)` returns an empty list and the parent is a `VariableDeclaration` whose parent is a `VariableStatement`. If so, call `extractContractTags` on the reparsed `VariableStatement` node instead.

**Strategy B (alternative):** In `buildReparsedIndex`, when a `VariableStatement` is encountered with an arrow/function-expression initialiser, also record the `VariableStatement` in the index keyed by the function node's position, so the lookup in `rewriteFunction` retrieves a node for which JSDoc is accessible.

Strategy A is preferred because it is localised and does not require reparsed-index changes. Implementation detail: a helper `extractContractTagsForFunctionLike(reparsedNode)` in `jsdoc-parser.ts` encapsulates the parent walk.

### 4.6 `isPublicTarget` extension (`src/node-helpers.ts`)

The current `isPublicTarget` check requires `isExportedFunction` (function declaration with `export`) or `isPublicMethod` (method declaration without `private`/`protected`). Arrow functions and function expressions are not function declarations, so they never pass this check.

A new exported helper `isExportedVariableInitialiser(node: typescript.FunctionLikeDeclaration): boolean` returns `true` when:

1. `node` is an `ArrowFunction` or `FunctionExpression`
2. `node.parent` is a `VariableDeclaration`
3. `node.parent.parent` is a `VariableDeclarationList`
4. `node.parent.parent.parent` is a `VariableStatement` with an `export` modifier

The transformer dispatch (section 4.1) performs this check inline rather than calling `isPublicTarget`, since the transformer has already confirmed it is visiting an exported `VariableStatement`; `isPublicTarget` is still used for `FunctionDeclaration` as before.

---

## 5. Changes Summary

| File | Change |
|------|--------|
| `src/transformer.ts` | Add `VariableStatement` branch in `visitNode`; iterate declarations, normalise arrow bodies, attempt rewrite, reconstruct updated `VariableStatement` |
| `src/function-rewriter.ts` | Add `normaliseArrowBody` helper; extend `applyNewBody` for `ArrowFunction` and `FunctionExpression` |
| `src/node-helpers.ts` | Extend `buildLocationName` with parent-walk for `ArrowFunction`/`FunctionExpression`; add `isExportedVariableInitialiser` helper |
| `src/jsdoc-parser.ts` | Add `extractContractTagsForFunctionLike` that falls back to the parent `VariableStatement` when the function node itself carries no JSDoc tags |
| `src/reparsed-index.ts` | No change (Strategy A is used for JSDoc resolution) |
| `src/ast-builder.ts` | No change |
| `src/contract-validator.ts` | No change |
| `src/type-helpers.ts` | No change — `buildParameterTypes` and `buildPostParamTypes` operate on `FunctionLikeDeclaration`; `ArrowFunction` and `FunctionExpression` already satisfy this type |

---

## 6. Testing Plan

All test cases should be exercised both in transpileModule mode (no checker) and, where stated, with a full program (checker available).

### 6.1 Arrow function with expression body

```typescript
export const double = /** @pre x > 0 */ (x: number): number => x * 2;
```

- `@pre` check injected; calling `double(-1)` throws `ContractError`.
- Calling `double(2)` returns `4` (no regression).

### 6.2 Arrow function with block body

```typescript
export const clamp = /** @pre min <= max */ (n: number, min: number, max: number): number => {
  return Math.min(Math.max(n, min), max);
};
```

- `@pre` injected; `clamp(5, 10, 1)` throws `ContractError`.

### 6.3 Arrow function with `@post` using `result`

```typescript
export const abs = /** @post result >= 0 */ (x: number): number => Math.abs(x);
```

- `@post` injected; result assertion passes for all valid inputs.

### 6.4 `@post` with `result` but no return type annotation — warning, tag dropped

```typescript
export const broken = /** @post result > 0 */ (x: number) => x;
```

- Warning emitted: `'result' used but no return type is declared; @post dropped`.
- No injection; function body unchanged.

### 6.5 Function expression

```typescript
export const trim = /** @pre input.length > 0 */ function(input: string): string {
  return input.trim();
};
```

- `@pre` injected; `trim('')` throws `ContractError`.

### 6.6 Named function expression

```typescript
export const factorial = /** @pre n >= 0 */ function fact(n: number): number {
  return n <= 1 ? 1 : n * fact(n - 1);
};
```

- `@pre` injected; location string is `"factorial"` (from the variable name, not `"fact"`).

### 6.7 Location string

For all of the above, the error message location should use the variable name, e.g. `"validate"`, not `"anonymous"`.

### 6.8 Non-exported arrow — no injection

```typescript
const internal = /** @pre x > 0 */ (x: number): number => x;
```

- No injection; function left unchanged; no warning emitted.

### 6.9 No tags — no injection, no unnecessary `require` import

```typescript
export const noop = (x: number): number => x;
```

- Function unchanged; no `require('...')` injected into the file.

### 6.10 Multiple contracts on one arrow

```typescript
export const divide = /** @pre denominator !== 0 @post result !== Infinity */
  (numerator: number, denominator: number): number => numerator / denominator;
```

- Both `@pre` and `@post` injected.

### 6.11 Unknown identifier in contract on arrow — warning, tag dropped

```typescript
export const foo = /** @pre ghost > 0 */ (x: number): number => x;
```

- Warning emitted; `@pre` dropped; function otherwise unchanged.

### 6.12 `VariableStatement` with multiple declarations — only annotated one rewritten

```typescript
export const a = 1, validate = /** @pre x > 0 */ (x: number): boolean => x > 0;
```

- Only `validate` is rewritten; `a` is left unchanged.

---

## 7. Out of Scope

- **Class field arrows** (`class Foo { bar = (x: number) => x; }`): The `PropertyDeclaration` path is handled by `class-rewriter.ts` and requires separate design work. JSDoc attachment for class fields differs from `VariableStatement`.
- **Non-exported `const` arrows**: There is no mechanical barrier to supporting these, but the project convention (matching `isPublicTarget` for `FunctionDeclaration`) is to only instrument exported functions. This can be revisited if a use case arises.
- **Nested functions inside other functions**: These cannot be directly exported and would require a recursive visitor change that touches the function body rewrite phase, not just the top-level dispatch.
- **Generator arrow functions**: Not valid TypeScript syntax — `async` arrows are in scope, `function*` expressions are technically supported by the AST path but are not explicitly tested; they may produce unusual behaviour with the `result` capture and are deferred.
- **Overloaded function declarations mimicked by multiple `const` assignments**: Not a TypeScript pattern; out of scope.
- **`@prev` / `@invariant` on arrow functions**: `prev` makes sense only for methods with mutable `this`. `invariant` applies to class invariants. Neither concept has a meaningful interpretation for a standalone exported arrow. Both are silently ignored (existing behaviour for `FunctionDeclaration` standalone functions; no change needed).
