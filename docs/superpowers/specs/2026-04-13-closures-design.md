# Closure / Nested Function Contracts — Design Doc

**Date:** 2026-04-13
**Issue:** #20 — `@pre`/`@post` tags on functions defined inside another function (closures, inner helpers, nested named functions) are silently dropped

---

## 1. Problem

The transformer visits only two categories of top-level node: exported `FunctionDeclaration` nodes (via `isPublicTarget`) and `ClassDeclaration` nodes. Nested function-like nodes — those that appear inside another function's body — are currently traversed by `visitEachChild` but never rewritten.

As a result the following patterns silently drop all `@pre`/`@post` tags; no assertion is injected and (before #13) no warning is emitted:

```typescript
export function processItems(items: string[]): string[] {
  /**
   * @pre item.length > 0
   * @post result.length > 0
   */
  function sanitise(item: string): string {
    return item.trim();
  }
  return items.map(sanitise);
}

export function makeAdder(base: number) {
  /**
   * @pre x > 0
   */
  return (x: number) => base + x;
}
```

There are three compounding reasons the contracts are dropped:

1. `visitNode` in `src/transformer.ts` checks `isFunctionDeclaration(node) && isPublicTarget(node)`. A nested `FunctionDeclaration` never has an `export` modifier and therefore fails `isPublicTarget`. A returned `ArrowFunction` is not a `FunctionDeclaration` at all.

2. `buildLocationName` in `src/node-helpers.ts` only knows how to build names for `MethodDeclaration` and `FunctionDeclaration`. A nested function or closure has neither a class parent nor a top-level `FunctionDeclaration` identity.

3. `buildKnownIdentifiers` in `src/node-helpers.ts` builds the known-identifier set from the function's own parameters and optionally `result`/`prev`. It does not look at the enclosing scope, so variables captured from the outer function are treated as unknown identifiers, causing valid contracts to be dropped with spurious warnings.

Issue #13 (misuse detection) will add a warning for these cases in the interim, but the contracts themselves are never injected regardless of whether a warning is emitted.

---

## 2. Goal

- `@pre` and `@post` tags on nested named `FunctionDeclaration` nodes inside an outer exported function body are recognised, validated, and injected.
- `@pre` and `@post` tags on arrow functions or function expressions assigned to a `const` inside an outer exported function body are recognised, validated, and injected.
- `@pre` and `@post` tags on arrow functions returned directly from an outer exported function (capturing outer parameters) are recognised, validated, and injected.
- Captured outer-scope variables (outer function parameters and preceding `const`/`let`/`var` bindings) are included in the known-identifier set for contract validation — no spurious unknown-identifier warnings for captured names.
- The location string for nested forms uses `OuterName > innerName` (e.g. `processItems > sanitise`) to distinguish closure contracts from top-level contracts in warning and assertion messages.
- No behavioural change to top-level `FunctionDeclaration`, `MethodDeclaration`, or exported `ArrowFunction`/`FunctionExpression` handling.
- Once implemented, #13 must no longer warn for the nested forms covered here.

---

## 3. Supported Forms

| Form | AST shape | In scope |
|------|-----------|----------|
| Named inner function declaration | `FunctionDeclaration` inside outer `FunctionDeclaration` body | Yes |
| `const` arrow in outer function body | `VariableStatement` > `VariableDeclaration` > `ArrowFunction` inside outer function body | Yes |
| `const` function expression in outer function body | `VariableStatement` > `VariableDeclaration` > `FunctionExpression` inside outer function body | Yes |
| Returned arrow function (closure) | `ReturnStatement` > `ArrowFunction` (or `ArrowFunction` as the final expression statement) inside outer function body | Yes |
| Named inner function in class method body | `FunctionDeclaration` inside `MethodDeclaration` body | Yes |
| IIFE (immediately-invoked function expression) | `CallExpression` > `ArrowFunction`/`FunctionExpression` | No |
| Functions nested more than one level deep (grandchild) | Any function-like node inside a nested function body | No |
| Non-exported outer function containing nested functions | Outer function that is not an exported `FunctionDeclaration` or public `MethodDeclaration` | No |

The "functions nested more than one level deep" exclusion is determined by nesting depth: the pass described in section 4.2 descends exactly one level into the outer function's body and does not recurse further into any nested function-like bodies it finds.

---

## 4. Approach

### 4.1 Overview

The rewrite happens in two phases per outer function:

1. **Phase 1 (existing):** Rewrite the outer function's `@pre`/`@post` contracts as today — this produces a new function body, or leaves the body unchanged if the outer function has no contracts.

2. **Phase 2 (new):** Walk the (possibly new) function body looking for nested function-like nodes with `@pre`/`@post` JSDoc tags. Rewrite each such node in place. Return the outer function with the updated body.

Phase 2 is triggered from `tryRewriteFunction` in `src/function-rewriter.ts` after the existing rewrite is complete (or skipped). It operates on the resulting body regardless of whether Phase 1 changed anything.

This two-phase structure keeps the bounding property clean: Phase 2 walks exactly the direct contents of the outer function's body block, never recursing into any nested function-like node's own body.

### 4.2 Transformer visitor — no change required

`visitNode` in `src/transformer.ts` does not need modification for the common case. The work is entirely within `tryRewriteFunction`. When `visitNode` dispatches an exported `FunctionDeclaration` to `tryRewriteFunction`, Phase 2 handles all closure rewriting inside that function's body.

The one exception is class methods: `tryRewriteClass` delegates to `tryRewriteFunction` per method, so Phase 2 also fires for method bodies automatically once `tryRewriteFunction` implements it.

### 4.3 Nested function discovery (`src/function-rewriter.ts`)

A new helper `rewriteNestedFunctions` accepts the outer function's body block and performs the nested pass:

```typescript
function rewriteNestedFunctions(
  factory: typescript.NodeFactory,
  outerNode: typescript.FunctionLikeDeclaration,
  body: typescript.Block,
  reparsedFunctions: Map<number, typescript.FunctionLikeDeclaration>,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker: typescript.TypeChecker | undefined,
  allowIdentifiers: string[],
): typescript.Block
```

The function visits each statement in `body.statements` exactly once (no recursion into nested bodies). For each statement it applies the following detection rules:

**Rule A — Named `FunctionDeclaration` in the body:**

```
typescript.isFunctionDeclaration(statement) && statement.body !== undefined
```

Extract JSDoc tags from the statement. If `@pre` or `@post` tags are present, attempt a rewrite. Replace the statement in the output with the rewritten declaration.

**Rule B — `VariableStatement` containing an arrow function or function expression:**

```
typescript.isVariableStatement(statement)
```

For each `VariableDeclaration` in `statement.declarationList.declarations`: if the initialiser is `typescript.isArrowFunction` or `typescript.isFunctionExpression`, extract JSDoc from the `VariableDeclaration` (and its parent `VariableStatement` as a fallback — same strategy as the arrow-functions spec, section 4.5). If tags are present, attempt a rewrite; replace the initialiser with the rewritten function node; reconstruct the `VariableStatement`.

**Rule C — `ReturnStatement` containing an arrow function or function expression:**

```
typescript.isReturnStatement(statement) &&
statement.expression !== undefined &&
(typescript.isArrowFunction(statement.expression) || typescript.isFunctionExpression(statement.expression))
```

The JSDoc comment on the `ReturnStatement` is not how TypeScript attaches JSDoc in practice. For returned closures, the convention is that the JSDoc comment appears immediately before the `return` keyword (attached to the `ReturnStatement` in the reparsed AST) or on a preceding `const` assignment. Extract tags by calling `typescript.getJSDocTags(statement)` on the reparsed `ReturnStatement` node. If tags are present, attempt a rewrite of the function expression; reconstruct the `ReturnStatement` with the rewritten expression.

If no statements change, return the original `body` unchanged (reference equality preserved — avoids unnecessary AST node creation).

### 4.4 Invoking the nested pass from `tryRewriteFunction` (`src/function-rewriter.ts`)

At the end of `tryRewriteFunction`, after calling `rewriteFunction` (Phase 1), apply Phase 2 to the resulting body:

```
1. Run Phase 1 (existing): rewritten = rewriteFunction(...) — may return null (no outer contracts)
2. Determine the working node: workingNode = rewritten ?? node
3. Obtain the working body: workingBody = workingNode.body (must be a Block)
4. Run Phase 2: newBody = rewriteNestedFunctions(factory, workingNode, workingBody, ...)
5. If newBody !== workingBody (reference inequality, meaning at least one nested rewrite occurred):
     - Apply the new body to workingNode using applyNewBody
     - Set transformed.value = true
     - Return the updated node
6. Otherwise return workingNode as-is
```

The `reparsedFunctions` map already contains entries for nested function nodes (because `buildReparsedIndex` calls `typescript.isFunctionLike(node)` which includes all nested forms). No change to `reparsed-index.ts` is required.

For `ReturnStatement`-based closures (Rule C), the reparsed node lookup uses the `ArrowFunction`/`FunctionExpression`'s position: `reparsedFunctions.get(arrowOrFunctionExpr.pos) ?? arrowOrFunctionExpr`.

### 4.5 Rewriting an individual nested function-like node

Each nested candidate (from Rules A, B, C) is passed to a new helper `rewriteNestedFunctionLike`:

```typescript
function rewriteNestedFunctionLike(
  factory: typescript.NodeFactory,
  node: typescript.FunctionLikeDeclaration,
  outerNode: typescript.FunctionLikeDeclaration,
  outerName: string,
  reparsedFunctions: Map<number, typescript.FunctionLikeDeclaration>,
  warn: (msg: string) => void,
  checker: typescript.TypeChecker | undefined,
  capturedIdentifiers: Set<string>,
  allowIdentifiers: string[],
): typescript.FunctionLikeDeclaration | null
```

This helper mirrors `rewriteFunction` but:

- Uses the closure-specific location string (section 4.6).
- Merges `capturedIdentifiers` into the known-identifier sets (section 4.7).
- Calls `extractContractTags` on the reparsed node (for named `FunctionDeclaration`) or on the reparsed parent node (for arrow/function-expression, using the same fallback logic as the arrow-functions spec).
- Uses the existing `filterValidTags`, `filterPostTagsWithResult`, `filterPostTagsRequiringPrev`, and `buildGuardedStatements` helpers unchanged.
- Calls `applyNewBody` to produce the rewritten node; `applyNewBody` already handles `FunctionDeclaration` and (after the arrow-functions spec) `ArrowFunction` and `FunctionExpression`, so no further extension is needed here.

For `ArrowFunction` with an expression body, apply `normaliseArrowBody` (introduced in the arrow-functions spec) before passing the node to `rewriteNestedFunctionLike`.

### 4.6 Location string (`src/node-helpers.ts`)

`buildLocationName` is extended with a two-argument overload for the nested case. A new exported helper is added:

```typescript
export function buildNestedLocationName(
  outerNode: typescript.FunctionLikeDeclaration,
  innerNode: typescript.FunctionLikeDeclaration,
  variableName?: string,
): string
```

Logic:

1. Resolve the outer name using the existing `buildLocationName(outerNode)`.
2. Resolve the inner name:
   - If `innerNode` is a `FunctionDeclaration` and `innerNode.name` is an `Identifier`: use `innerNode.name.text`.
   - If `variableName` is supplied (the `const` name for Rule B): use `variableName`.
   - Otherwise: use `'(anonymous)'`.
3. Return `"${outerName} > ${innerName}"`.

Examples:

| Scenario | Location string |
|----------|----------------|
| Named inner function `sanitise` in `processItems` | `processItems > sanitise` |
| `const helper = () => ...` in `processItems` | `processItems > helper` |
| Returned arrow in `makeAdder` | `makeAdder > (anonymous)` |
| Inner function in class method `MyClass.process` | `MyClass.process > sanitise` |

### 4.7 Captured variables as known identifiers (`src/node-helpers.ts`)

A new exported helper `buildCapturedIdentifiers` collects identifiers from the enclosing scope that are visible at the nested function's declaration site:

```typescript
export function buildCapturedIdentifiers(
  outerNode: typescript.FunctionLikeDeclaration,
  innerStatementIndex: number,
): Set<string>
```

This does **not** require a `TypeChecker`. It performs a syntactic walk:

1. **Outer function parameters:** iterate `outerNode.parameters` and call the existing `extractBindingNames` helper on each `param.name`. All parameter names are in scope regardless of position.

2. **Preceding variable declarations:** iterate `outerNode.body.statements` (if `outerNode.body` is a `Block`) from index `0` up to and including `innerStatementIndex - 1`. For each `VariableStatement`, iterate `declarationList.declarations` and call `extractBindingNames` on each `declaration.name`. This captures `const`/`let`/`var` bindings declared before the nested function.

The resulting `Set<string>` is passed to `rewriteNestedFunctionLike` as `capturedIdentifiers`.

Inside `rewriteNestedFunctionLike`, the known-identifier sets are built as follows:

```
preKnown  = buildKnownIdentifiers(innerNode, false)  // inner params + 'this'
postKnown = buildKnownIdentifiers(innerNode, true)   // inner params + 'this' + 'result' + 'prev'

// Add captured outer identifiers to both sets
for (const id of capturedIdentifiers) {
  preKnown.add(id);
  postKnown.add(id);
}

// Then mergeIdentifiers(...) runs as normal (checker scope + allowIdentifiers + exportedNames)
```

The `innerStatementIndex` is the index of the statement in the outer function's body where the nested function-like node was found. For `rewriteNestedFunctions`, this is the loop index `i` over `body.statements`.

### 4.8 `result` and `@prev` in closures

The same rules that apply to top-level standalone functions apply to closures:

- **`result`:** Requires an explicit return type annotation on the closure. `filterPostTagsWithResult` already enforces this; no change needed. The location string in the warning will be the nested form (e.g. `processItems > sanitise`).

- **`@prev`:** Closures do not have `this`. `resolvePrevCapture` returns `null` for non-method nodes (existing rule: standalone function — no default). For a returned closure that captures outer state, a user who needs `@prev` must provide an explicit `@prev` expression in the JSDoc. The existing `filterPostTagsRequiringPrev` then handles this correctly.

- **`@invariant`:** No meaning for a closure. If present, the tag is ignored (same as for top-level `FunctionDeclaration`). No new warning is needed — #13 covers `@invariant` on non-class nodes.

No new `@prev`/`result` logic is needed in this spec.

### 4.9 JSDoc resolution for nested nodes

`buildReparsedIndex` in `src/reparsed-index.ts` visits all `FunctionLike` nodes, including nested ones, and stores them by position. This means `reparsedFunctions.get(node.pos)` works for nested `FunctionDeclaration` nodes as-is.

For nested arrow functions or function expressions under a `VariableDeclaration` (Rule B), the same parent-walk fallback used in the arrow-functions spec applies: if `extractContractTags(reparsedNode)` returns an empty list and the parent is a `VariableDeclaration`, also call `extractContractTags` on the reparsed `VariableDeclaration`'s parent `VariableStatement`. This is the `extractContractTagsForFunctionLike` helper introduced in the arrow-functions spec — it is reused here without modification.

For returned `ArrowFunction`/`FunctionExpression` nodes (Rule C), the reparsed `ReturnStatement` is retrieved from the index (keyed by the statement's position, not the function's). The existing `extractContractTags` helper calls `typescript.getJSDocTags`, which walks up to the nearest JSDoc-eligible ancestor from the reparsed node's position. If the reparsed `ReturnStatement` carries no tags, check the reparsed `ArrowFunction`/`FunctionExpression` directly as a fallback.

### 4.10 Interaction with #13 (misuse detection)

Issue #13 adds warnings for unsupported nested function patterns. Once #20 is implemented, the supported forms (named inner `FunctionDeclaration`, `const`-assigned arrow/function-expression, and returned arrow function) should no longer trigger the #13 warning.

The #13 detection logic in `src/transformer.ts` uses `isPublicTarget` to distinguish supported from unsupported `FunctionDeclaration` nodes. For nested forms, #13's warning fires at the top-level visitor pass (before Phase 2 would rewrite them). This ordering means the warning fires on the original AST, before the rewrite.

The fix: the #13 check for nested `FunctionDeclaration` and closure nodes must be made conditional on whether Phase 2 will handle them. A straightforward approach is to move the nested-form #13 check into `rewriteNestedFunctions`: if a nested node has `@pre`/`@post` tags but cannot be rewritten (for reasons other than "no tags" — e.g. no body, expression body without return type for `result`), the rewriter emits a targeted warning via the existing `warn` callback. The #13 top-level check is then scoped only to forms that Phase 2 does not cover: IIFEs and grandchild functions.

In practice this means:

| Pattern | After #20 |
|---------|-----------|
| Named inner `FunctionDeclaration` with `@pre`/`@post` | Contracts injected; no #13 warning |
| `const` arrow with `@pre`/`@post` inside outer function body | Contracts injected; no #13 warning |
| Returned `ArrowFunction` with `@pre`/`@post` | Contracts injected; no #13 warning |
| IIFE with `@pre`/`@post` | #13 warning still emitted; no injection |
| Grandchild function with `@pre`/`@post` | #13 warning still emitted; no injection |
| Non-exported top-level function with `@pre`/`@post` | #13 warning still emitted; no injection |

### 4.11 TypeChecker availability

The TypeChecker, when available, is passed through `tryRewriteFunction` → `rewriteNestedFunctionLike` → `mergeIdentifiers` and `filterValidTags` in the same way it is for top-level functions. Deep property chain validation, type mismatch detection, and scope-based identifier resolution all work identically. No new TypeChecker API surface is needed.

---

## 5. Changes Summary

| File | Change |
|------|--------|
| `src/function-rewriter.ts` | Add `rewriteNestedFunctions` helper (nested pass); add `rewriteNestedFunctionLike` helper (single nested node rewrite); extend `tryRewriteFunction` to invoke the nested pass after Phase 1 |
| `src/node-helpers.ts` | Add `buildNestedLocationName` helper; add `buildCapturedIdentifiers` helper; export `extractBindingNames` (currently private) so it can be called from `buildCapturedIdentifiers` |
| `src/transformer.ts` | No changes required for the core rewrite; update the #13 conditional check to exclude the nested forms now handled by #20 (see section 4.10) |
| `src/reparsed-index.ts` | No change — nested nodes are already indexed |
| `src/ast-builder.ts` | No change |
| `src/contract-validator.ts` | No change |
| `src/jsdoc-parser.ts` | No change — `extractContractTagsForFunctionLike` (from the arrow-functions spec) is reused for Rules B and C |
| `src/class-rewriter.ts` | No change — class methods already delegate to `tryRewriteFunction`, which gains Phase 2 automatically |
| `src/type-helpers.ts` | No change — `buildParameterTypes` and `buildPostParamTypes` operate on `FunctionLikeDeclaration`; nested nodes already satisfy this type |

---

## 6. Testing Plan

All test cases should be exercised in transpileModule mode (no TypeChecker) unless marked "with checker". Cases marked "with checker" require a full `ts.Program`.

### 6.1 Named inner `FunctionDeclaration` — `@pre` injected

```typescript
export function processItems(items: string[]): string[] {
  /** @pre item.length > 0 */
  function sanitise(item: string): string { return item.trim(); }
  return items.map(sanitise);
}
```

- Calling `sanitise('')` from within `processItems` throws `ContractError`.
- Location string in the error is `processItems > sanitise`.
- `processItems` itself has no contracts — no outer-level assertion injected.

### 6.2 Named inner function — `@post` using `result`

```typescript
export function processItems(items: string[]): string[] {
  /** @post result.length > 0 */
  function sanitise(item: string): string { return item.trim(); }
  return items.map(sanitise);
}
```

- `@post` injected on `sanitise`; passing a whitespace-only string throws `ContractError` on the post-condition.

### 6.3 Named inner function — `@post` using `result` with no return type — warning, tag dropped

```typescript
export function outer(): void {
  /** @post result.length > 0 */
  function inner(s: string) { return s.trim(); }
  inner('  ');
}
```

- Warning emitted: `'result' used but no return type is declared; @post dropped` with location `outer > inner`.
- No post-condition assertion injected; function body unchanged.

### 6.4 `const` arrow inside outer function — `@pre` injected

```typescript
export function makeAdder(base: number) {
  /** @pre x > 0 */
  const add = (x: number): number => base + x;
  return add;
}
```

- `@pre` injected on `add`; calling `add(-1)` throws `ContractError`.
- Location string is `makeAdder > add`.

### 6.5 Returned arrow function — `@pre` using captured outer parameter

```typescript
export function makeAdder(base: number) {
  /**
   * @pre x > 0
   * @pre base >= 0
   */
  return (x: number): number => base + x;
}
```

- Both `@pre` checks injected. `base` is recognised as a known identifier (captured from outer scope); no unknown-identifier warning.
- Location string is `makeAdder > (anonymous)`.
- Calling the returned function with `x = -1` throws `ContractError`.
- Calling with `base = -1` (i.e. `makeAdder(-1)(1)`) throws `ContractError`.

### 6.6 Returned arrow — `base` without `buildCapturedIdentifiers` would be unknown — no spurious warning

Same as 6.5. Confirm that without the captured-identifiers fix, `base` produces a warning; with the fix, no warning is emitted and the contract is injected.

### 6.7 `const` function expression inside outer function — `@pre` injected

```typescript
export function outer(): void {
  /** @pre n > 0 */
  const square = function(n: number): number { return n * n; };
  square(4);
}
```

- `@pre` injected; `square(-1)` throws `ContractError`.
- Location string is `outer > square`.

### 6.8 Both outer and inner contracts — both injected independently

```typescript
export function processItems(items: string[]): string[] {
  /** @pre item.length > 0 */
  function sanitise(item: string): string { return item.trim(); }
  return items.map(sanitise);
}
```

Outer function has `@pre items.length > 0`:

```typescript
export function processItems(items: string[]): string[] {
  /** @pre item.length > 0 */
  function sanitise(item: string): string { return item.trim(); }
  return items.map(sanitise);
}
```

- Outer `@pre` injected at the start of `processItems` body; inner `@pre` injected into `sanitise` body.
- Both assertions present in output.

### 6.9 Outer function has contracts; inner also has contracts

```typescript
/** @pre items.length > 0 */
export function processItems(items: string[]): string[] {
  /** @pre item.length > 0 */
  function sanitise(item: string): string { return item.trim(); }
  return items.map(sanitise);
}
```

- `processItems` assertion fires on empty `items`.
- `sanitise` assertion fires on empty `item`.
- Both operate independently.

### 6.10 Inner function with `@prev` — no default, explicit `@prev` required

```typescript
export function outer(state: { count: number }): () => number {
  /**
   * @prev { count: state.count }
   * @post result >= prev.count
   */
  return (): number => ++state.count;
}
```

- `@prev` expression `{ count: state.count }` uses `state` from outer scope; `state` recognised as captured identifier.
- `@post` injected with `prev` capture.

### 6.11 `@prev` without explicit `@prev` tag on closure — warning, `@post` dropped

```typescript
export function outer(state: { count: number }): () => number {
  /** @post result >= prev.count */
  return (): number => ++state.count;
}
```

- Warning emitted: `'prev' used but no @prev capture available; @post dropped` with location `outer > (anonymous)`.

### 6.12 Unknown identifier in inner contract — warning, tag dropped

```typescript
export function outer(): void {
  /** @pre ghost > 0 */
  function inner(x: number): number { return x; }
  inner(1);
}
```

- Warning emitted citing `ghost` as unknown and location `outer > inner`.
- `@pre` not injected; body unchanged.

### 6.13 Identifier captured from outer — not treated as unknown

```typescript
export function outer(limit: number): void {
  /** @pre x < limit */
  function check(x: number): void { /* ... */ }
  check(5);
}
```

- `limit` is an outer parameter; no unknown-identifier warning.
- `@pre` injected.

### 6.14 Identifier from preceding `const` in outer body — not treated as unknown

```typescript
export function outer(): void {
  const MAX = 100;
  /** @pre x <= MAX */
  function check(x: number): void { /* ... */ }
  check(50);
}
```

- `MAX` is a preceding binding in the outer body; no unknown-identifier warning.
- `@pre` injected.

### 6.15 Grandchild function — not rewritten, #13 warning still emitted

```typescript
export function outer(): void {
  function middle(): void {
    /** @pre x > 0 */
    function inner(x: number): void { /* ... */ }
    inner(1);
  }
  middle();
}
```

- Phase 2 descends into `outer`'s body and finds `middle` (no tags on `middle` — skipped).
- `inner` is inside `middle`'s body — not visited by Phase 2 (bounded to one level).
- #13 warning emitted for `inner` (grandchild, not supported).
- No assertion injected for `inner`.

### 6.16 IIFE — not rewritten, #13 warning still emitted

```typescript
export function outer(): void {
  (/** @pre x > 0 */ (x: number) => x)(-1);
}
```

- Phase 2 finds the IIFE call expression; the `ArrowFunction` is the callee of a `CallExpression`, not a `VariableDeclaration` initialiser or `ReturnStatement` expression — not matched by Rules A, B, or C.
- #13 warning emitted.
- No assertion injected.

### 6.17 Named inner function with expression-body arrow at same depth — both rewritten

```typescript
export function outer(): void {
  /** @pre x > 0 */
  function named(x: number): number { return x * 2; }
  /** @pre y > 0 */
  const arrow = (y: number): number => y * 3;
  named(2);
  arrow(3);
}
```

- Both `named` and `arrow` have `@pre` injected.
- `named(-1)` throws; `arrow(-1)` throws.

### 6.18 Inner function with no tags — no injection, no warning

```typescript
export function outer(): void {
  function helper(x: number): number { return x; }
  helper(1);
}
```

- `helper` has no JSDoc tags; Phase 2 skips it without modification.
- No assertion injected, no warning emitted, no unnecessary `require` import.

### 6.19 Location string for class method with inner function (with checker)

```typescript
class Processor {
  public process(items: string[]): string[] {
    /** @pre item.length > 0 */
    function sanitise(item: string): string { return item.trim(); }
    return items.map(sanitise);
  }
}
```

- Location string is `Processor.process > sanitise`.
- `@pre` injected.

### 6.20 `require` import injected only when at least one assertion is added

- File with only an outer exported function and a tagged inner function (no outer tags) → `require('@fultslop/fs-axiom')` injected once.
- File with neither outer nor inner tags → no `require` injected.

---

## 7. Out of Scope

- **IIFEs (immediately-invoked function expressions):** The pattern `((...) => ...)()` does not assign the function to a name and is called immediately; there is no stable location string and the call semantics differ from a reusable function. Out of scope.
- **Grandchild functions (nested more than one level deep):** Phase 2 is deliberately bounded to a single level of descent. Supporting multiple levels of nesting would require unbounded recursion and risks processing unintended code. Out of scope.
- **Non-exported outer functions:** The outer function must be a public target (exported `FunctionDeclaration` or public `MethodDeclaration`). Private, protected, or non-exported outer functions are not visited by `visitNode`, so their nested functions are never reached. Out of scope.
- **Generator functions as closures:** `function*` inner declarations and `async function*` closures are syntactically valid in TypeScript but interact in complex ways with the `result` capture mechanism (generators return iterators, not values). Out of scope; deferred.
- **`@invariant` on closures:** Invariants are a class-level concept. A `@invariant` tag on a nested function has no meaningful interpretation. The #13 warning handles this case; no injection is attempted.
- **Closures that re-export or escape via module-level assignment:** The spec does not attempt to track whether a closure is eventually exported indirectly. Only the lexical structure (nested inside an outer exported function) determines eligibility.
- **`@prev` default for closures capturing `this`:** Arrow functions inherit `this` from the enclosing scope; if the outer function is a method, `this` is available. However, applying the method default (`{ ...this }`) for a closure's `@prev` would be misleading — the closure's own state concept may differ. No default `@prev` is applied for closures; an explicit `@prev` tag is always required.
