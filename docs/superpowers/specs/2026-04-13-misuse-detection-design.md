# Misuse Detection: Silent Failures on Unsupported Targets — Design Doc

**Date:** 2026-04-13
**Covers:** #13 — `@pre`/`@post`/`@invariant` on unsupported node types produce no contracts and no warnings

---

## 1. Problem

Five patterns are silently ignored by the transformer: no contract is injected and no warning is emitted. Users who annotate these patterns believe their contracts are active; they are not.

| Pattern | Current behaviour |
|---|---|
| `@pre`/`@post` on a **constructor** | Tags extracted during invariant processing inside `class-rewriter.ts`, but `rewriteMember` only calls `rewriteConstructor` for invariant injection — contract tags are never evaluated |
| `@pre`/`@post` on an **arrow function or function expression** | `visitNode` in `transformer.ts` only enters `tryRewriteFunction` for `FunctionDeclaration` nodes that pass `isPublicTarget`; arrow and function-expression nodes are passed to `visitEachChild` unchanged |
| `@pre`/`@post` on a **nested/closure function** | Same root cause — a `FunctionDeclaration` that is not top-level exported does not pass `isPublicTarget`, so `visitEachChild` descends into it but never rewrites it |
| `@pre`/`@post` on a **class body** (not on a method) | The `ClassDeclaration` node itself can carry JSDoc; `rewriteClass` reads invariants from it but never checks for `@pre`/`@post` tags |
| `@invariant` on a **non-class** node | `visitNode` only routes `ClassDeclaration` nodes to `tryRewriteClass`; `@invariant` on a function, variable, or interface is never read |

None of these cases currently produce any diagnostic output.

---

## 2. Goals

- Every tag that cannot be acted on emits exactly one targeted `[axiom] Warning:` message on the `warn` callback, naming the annotation, the location, and the recommended alternative.
- No new warnings are emitted for supported patterns (methods, exported functions, class-level invariants).
- The existing `warn` callback pattern (`options?: { warn?: (msg: string) => void }`, defaulting to `process.stderr.write`) is the only mechanism used. No new plumbing is introduced.
- The transformer output for all unsupported patterns remains unchanged (the node is returned unmodified).

---

## 3. Approach

### 3.1 `@pre`/`@post` on a constructor

**Location:** `src/class-rewriter.ts`, function `rewriteMember`.

`rewriteMember` already has a branch for `isConstructorDeclaration`. Before returning the existing `rewriteConstructor(...)` result (or the bare `{ element: member, changed: false }` when there are no invariants), extract contract tags from the constructor node using `extractContractTagsFromNode` (already exported from `jsdoc-parser.ts`). If any `@pre` or `@post` tags are present, call `warn` once.

The check must happen regardless of whether `effectiveInvariants.length > 0`, because a constructor with no invariants but with `@pre`/`@post` tags currently falls through to the default `{ element: member, changed: false }` branch without any inspection.

### 3.2 `@pre`/`@post` on an arrow function, function expression, or closure

**Location:** `src/transformer.ts`, function `visitNode`.

After the `isFunctionDeclaration` branch (which handles public targets), add detection for the unsupported cases before the fall-through to `visitEachChild`:

1. **Arrow functions and function expressions** — `typescript.isArrowFunction(node)` or `typescript.isFunctionExpression(node)`. Extract contract tags using `extractContractTagsFromNode`. If any are present, emit a warning. Then fall through to `visitEachChild` so nested supported nodes are still processed.

2. **Non-exported function declarations** — `typescript.isFunctionDeclaration(node)` where `isPublicTarget` returned `false`. Extract contract tags from the node. If any are present, emit a warning. Then fall through to `visitEachChild`.

Both cases use the same warning message (arrow functions, function expressions, and non-exported function declarations share the same unsupported-closure category).

A helper is needed to extract a display name for the location. For a named arrow/function-expression assigned to a variable (`const foo = () => {}`), the parent `VariableDeclarator` name is the best available label. For anonymous cases, use `'(anonymous)'`. Use `typescript.isVariableDeclaration(node.parent)` and `typescript.isIdentifier(node.parent.name)` to attempt name resolution. This helper can be a private function inside `transformer.ts`.

### 3.3 `@pre`/`@post` on a class body

**Location:** `src/class-rewriter.ts`, function `rewriteClass`.

After computing `className`, extract contract tags from the `ClassDeclaration` node itself using `extractContractTagsFromNode(node)`. If any `@pre` or `@post` tags are present, emit a warning before proceeding. This fires before any member rewriting so the class-level contract tags are caught even if the class has no methods.

Note: `extractContractTagsFromNode(node)` operates on the original (pre-reparsed) node. For consistency with how invariants are resolved (from `reparsedClass`), also check `extractContractTagsFromNode(reparsedClass)`. Emit a warning if either has contract tags. In practice reparsed and original nodes carry the same JSDoc at the class level, but checking both prevents the warning from being silenced by AST reparsing.

### 3.4 `@invariant` on a non-class node

**Location:** `src/transformer.ts`, function `visitNode`.

`extractInvariantExpressions` is already imported (transitively) via `class-rewriter.ts`, but is not used directly in `transformer.ts`. Import it directly from `jsdoc-parser.ts`.

After the `isClassDeclaration` branch, and before the `isFunctionDeclaration` branch, add checks for nodes that could plausibly carry a `@invariant` tag:

- `typescript.isFunctionDeclaration(node)` — already has a branch; if the node has invariant tags, emit a warning after the function rewrite (or before, if the function is not a public target).
- `typescript.isVariableStatement(node)` — visit child declarations; if any `VariableDeclaration` has invariant tags, emit a warning.
- `typescript.isInterfaceDeclaration(node)` — if invariant tags are present, emit a warning.

For `FunctionDeclaration` nodes: the warning can be emitted inside the existing `isFunctionDeclaration` branch — after the public-target check, add an `extractInvariantExpressions` call and warn if non-empty. For non-public function declarations (not visited by `tryRewriteFunction`), the same check in the `visitEachChild` fallthrough applies — add a dedicated branch for `isFunctionDeclaration(node) && !isPublicTarget(node)` before the `visitEachChild` call.

For simplicity, a single catch-all approach is workable: in the `visitEachChild` fallthrough (and after the `isFunctionDeclaration` public-target branch), call `extractInvariantExpressions(node)` on any node that is not a `ClassDeclaration`. Emit a warning if the result is non-empty. This avoids enumerating every possible node kind.

---

## 4. Changes Summary

| File | Change |
|---|---|
| `src/transformer.ts` | Add unsupported-pattern detection in `visitNode` for: arrow functions with `@pre`/`@post`; function expressions with `@pre`/`@post`; non-exported function declarations with `@pre`/`@post`; any non-class node with `@invariant`. Import `extractInvariantExpressions` and `extractContractTagsFromNode` directly. Add private `resolveDisplayName` helper. |
| `src/class-rewriter.ts` | In `rewriteClass`: detect `@pre`/`@post` on the `ClassDeclaration` node itself and warn. In `rewriteMember`: detect `@pre`/`@post` on `ConstructorDeclaration` and warn. Import `extractContractTagsFromNode` (already available from `jsdoc-parser.ts`). |
| `src/jsdoc-parser.ts` | No changes required. `extractContractTagsFromNode` is already exported. |

No new source files are needed. No changes to exported public API signatures.

---

## 5. Warning Messages

All messages follow the existing `[axiom] Warning: ...` prefix convention established in the codebase.

**Constructor `@pre`/`@post`:**
```
[axiom] Warning: @pre/@post on constructors is not supported — use @invariant on the class or call pre()/post() manually inside the constructor body (in ClassName.constructor)
```

**Arrow function / function expression / closure `@pre`/`@post`:**
```
[axiom] Warning: @pre/@post on arrow functions, function expressions, and closures is not supported — contracts were not injected (in foo)
```
Where `foo` is the resolved display name, or `(anonymous)` if none is available.

**Class body `@pre`/`@post`:**
```
[axiom] Warning: @pre/@post on a class declaration is not supported — annotate individual methods instead (in ClassName)
```

**`@invariant` on a non-class:**
```
[axiom] Warning: @invariant is only supported on class declarations — tag has no effect (in foo)
```
Where `foo` is the function/variable/interface name, or `(anonymous)` if none is available.

---

## 6. Testing Plan

All tests should be written as transformer integration tests using `transpileModule` (no `TypeChecker` required for warning emission — warnings are JSDoc-driven, not type-driven).

**Constructor `@pre`/`@post`:**
- Class with `@pre x > 0` on constructor → warning emitted containing `constructors is not supported` and the class name
- Class with `@post result !== null` on constructor → warning emitted
- Class with `@pre` on a regular method → no unsupported-target warning (contracts injected normally)
- Class with both `@invariant` on the class and `@pre` on the constructor → invariant injected into constructor; `@pre` warning emitted

**Arrow function / function expression `@pre`/`@post`:**
- `const foo = /** @pre x > 0 */ (x: number) => x + 1;` → warning containing `arrow functions` and `foo`
- `const bar = /** @post result > 0 */ function(x: number) { return x; };` → warning containing `function expressions` and `bar`
- Anonymous IIFE `(/** @pre x > 0 */ (x: number) => x)()` → warning containing `(anonymous)`
- Named exported function declaration with `@pre` → no unsupported-target warning (contracts injected normally)

**Nested / closure function declaration `@pre`/`@post`:**
- Unexported top-level function with `@pre` → warning emitted
- Function declaration inside another function body with `@pre` → warning emitted

**Class body `@pre`/`@post`:**
- Class with `/** @pre this.x > 0 */` JSDoc on the class declaration itself → warning containing `class declaration is not supported` and the class name
- Class with `@pre` on the class and `@pre` on a method → class-level warning emitted; method contracts injected normally (two independent outcomes)

**`@invariant` on non-class:**
- Exported function with `@invariant x > 0` → warning containing `only supported on class declarations` and the function name
- `const x = /** @invariant ... */ 5;` → warning emitted
- Interface with `@invariant` tag → warning emitted
- Class with valid `@invariant` → no unsupported-target warning (invariant injected normally)

**No double-warnings / no regression:**
- A supported method with valid `@pre`/`@post` and a class with valid `@invariant` — run the full transformer; confirm no unsupported-target warnings appear.

---

## 7. Out of Scope

- Implementing `@pre`/`@post` support for constructors, arrow functions, or closures. This spec covers detection and reporting only.
- `@invariant` support on interfaces or functions. Detection only.
- Detecting `@prev` or `@type` tags on unsupported nodes — those tags are only meaningful in a function context and are not part of the silent-failure surface described in #13.
- Positional information (line/column numbers) in warning messages — the existing warning format does not include source positions.
- Suppression mechanisms (e.g. an `// axiom-ignore` comment) — out of scope for this issue.
