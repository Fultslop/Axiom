# Compound Conditions / Type Narrowing — Design Doc

**Date:** 2026-04-13
**Issue:** #11 — Compound conditions / type narrowing

---

## 1. Problem

Type mismatch detection in `contract-validator.ts` (`collectTypeMismatches`) examines each binary sub-expression in isolation. It does not account for type narrowing that sibling clauses in a `&&` expression establish.

The remaining motivating case, after union type resolution shipped in the previous priority, is **`typeof` guard narrowing for ambiguous unions**:

```typescript
/** @pre typeof x === "string" && x === 42 */
// x: string | number — resolveSimpleType returns undefined (ambiguous union)
// collectTypeMismatches currently SKIPS the x === 42 check entirely.
export function foo(x: string | number): void { … }
```

When `resolveSimpleType` returns `undefined` for a parameter, its entry is absent from `paramTypes` and any comparison involving that parameter is silently ignored. The `typeof x === "string"` clause in the left arm of `&&` narrows `x` to `string` for the right arm, so `x === 42` should emit a `type-mismatch` warning — but it does not.

A secondary case, **null-check narrowing** (`x !== null && x === "zero"` where `x: number | null`), already works correctly through the existing union resolution path (`resolveSimpleType` strips `null` and resolves the union to `number`). No new behaviour is needed there; the design must confirm it is unaffected.

---

## 2. Goals

- `typeof param === "string" && param === 42` where `param: string | number` emits a `type-mismatch` warning on the second clause.
- `typeof param === "number" && param > 0` where `param: string | number` does **not** emit a warning (the narrowed type is correct).
- `typeof param === "boolean" && param === 1` where `param: boolean | number` emits a `type-mismatch` warning (narrowed to `boolean`, compared to number literal).
- Parameters that already resolve via `resolveSimpleType` (non-union or unambiguous-union types) continue to behave exactly as before — the new narrowing logic only adds entries for parameters that are currently absent from `paramTypes`.
- The feature is limited to `&&` chains. `||` conditions are not analysed.

---

## 3. Non-Goals

- **`||` narrowing** — `||` narrowing is asymmetric: `typeof x === "string" || x === 42` does not narrow `x` to `string` for the right arm. Skipped.
- **`instanceof` narrowing** — Out of scope. The affected contracts use primitive comparisons; class-instance narrowing does not interact with `SimpleType` comparisons.
- **Nested / non-top-level `&&` chains** — Only the top-level `&&` chain of the expression is walked. Narrowing inside a sub-expression such as `(typeof x === "string" && x === 42) || y > 0` is not inferred for `y`.
- **`!==` / `!=` typeof guards** — Narrowing from negative typeof guards (e.g. `typeof x !== "string"`) is not inferred; these narrow the _other_ branches, not the current arm.
- **Multi-hop narrowing** — Chaining narrowing through multiple assignments or re-assignments is out of scope.
- **Generic type parameters** — `resolveSimpleType` already returns `undefined` for unresolved generics; no change.

---

## 4. Approach

### 4.1 Overview

Before `collectTypeMismatches` runs, perform a lightweight pre-pass over the expression AST that builds a **narrowed type map** from `typeof` guard clauses found in the top-level `&&` chain. This map is merged with the base `paramTypes` to produce an effective type map that is passed to `collectTypeMismatches`.

The pre-pass does not modify or replace the existing `collectTypeMismatches` logic. It only augments the type map for parameters that were previously absent (ambiguous unions).

### 4.2 Algorithm for `buildNarrowedTypeMap`

**Input:** the top-level expression `node`, the base `paramTypes: Map<string, TypeMapValue>`.

**Output:** a new `Map<string, TypeMapValue>` that is a copy of `paramTypes` extended with narrowed types for any parameters matched by `typeof` guards in the `&&` chain.

Steps:

1. Collect the flat list of clauses by walking the `&&` chain:
   - If `node` is a `BinaryExpression` with operator `&&`, recursively collect clauses from `node.left` and `node.right`.
   - Otherwise, treat `node` itself as a single clause.

2. For each clause, test whether it matches the pattern `typeof <identifier> === <string-literal>`:
   - The clause must be a `BinaryExpression` with operator `===` (or `==`; see note below).
   - One side must be a `TypeOfExpression` wrapping a plain `Identifier`.
   - The other side must be a `StringLiteral` whose text is one of `"string"`, `"number"`, or `"boolean"`.
   - Extract `paramName` from the identifier and `narrowedType` (`SimpleType`) from the string literal.

3. For each matched `(paramName, narrowedType)` pair:
   - If `paramTypes.get(paramName)` is **not** `undefined` — the parameter already has a resolved type and does not need narrowing. Skip.
   - If `paramName` is not present in `paramTypes` at all — the parameter is either unknown or not tracked; skip.
   - If `paramTypes.get(paramName) === undefined` would be true but the key is absent — same as above, skip.

   The condition to add a narrowed entry is: the `paramName` key exists in `paramTypes` but its value was never stored (the parameter was an ambiguous union and therefore omitted). In the current implementation, `buildParameterTypes` only stores entries for parameters where `resolveSimpleType` returns non-`undefined`, so ambiguous-union parameters are simply absent from the map.

   Therefore: if `paramTypes` does **not** contain `paramName`, check whether the expression's known-identifier set (if available) contains the name, or — more precisely — verify that the parameter is a real parameter of the function by checking whether `paramName` appears in any `typeof` guard at all (it does, by construction at this step). Add `(paramName, narrowedType)` to the narrowed map.

   Practical rule: **add the entry unconditionally** when the `typeof` guard matches and `paramTypes` does not already contain `paramName`. If the identifier is not a real parameter, the `collectUnknownIdentifiers` pass will catch that separately.

4. Return the merged map: start from a copy of `paramTypes` and overlay all entries collected in step 3.

**Note on `==` vs `===`:** Only `===` (strict equality, `SyntaxKind.EqualsEqualsEqualsToken`) should be recognised. `==` (`SyntaxKind.EqualsEqualsToken`) is intentionally excluded to match the strict-mode coding style enforced by the project's ESLint config and to avoid ambiguity with coercions.

### 4.3 Worked example

```typescript
/** @pre typeof x === "string" && x === 42 */
// x: string | number
```

Base `paramTypes`: `{}` (x is an ambiguous union; `resolveSimpleType` returned `undefined`; key was never inserted).

`&&` chain clauses:
- Clause 1: `typeof x === "string"` → matches; `paramName = "x"`, `narrowedType = "string"`.
- Clause 2: `x === 42` → not a typeof guard; no narrowing extracted.

`x` is absent from `paramTypes` → add `("x", "string")` to the narrowed map.

Effective map passed to `collectTypeMismatches`: `{ x: "string" }`.

`collectTypeMismatches` processes `x === 42`: left side is identifier `x` (type `"string"`), right side is numeric literal (type `"number"`). `"string" !== "number"` → emits `type-mismatch` warning.

### 4.4 Non-narrowing example (correct type usage)

```typescript
/** @pre typeof x === "number" && x > 0 */
// x: string | number
```

Narrowed map after pre-pass: `{ x: "number" }`.

`collectTypeMismatches` processes `x > 0`: right side `0` is a numeric literal (`"number"`); left side `x` is `"number"`. Types match → no warning. Correct.

---

## 5. Architecture

### 5.1 New helper: `buildNarrowedTypeMap`

Location: `src/contract-validator.ts` (file-private; not exported).

```typescript
function buildNarrowedTypeMap(
  node: typescript.Expression,
  paramTypes: Map<string, TypeMapValue>,
): Map<string, TypeMapValue>
```

- Walks the top-level `&&` chain of `node`.
- Detects `typeof param === "string"/"number"/"boolean"` clauses.
- Returns a copy of `paramTypes` extended with narrowed entries for ambiguous-union parameters (those absent from `paramTypes`).
- Returns the original `paramTypes` unchanged if no narrowing is detected (avoids unnecessary map allocation in the common path — though a shallow copy is still acceptable for correctness).

Helper to flatten the `&&` chain:

```typescript
function collectAndClauses(
  node: typescript.Node,
  out: typescript.Node[],
): void {
  if (
    typescript.isBinaryExpression(node) &&
    node.operatorToken.kind === typescript.SyntaxKind.AmpersandAmpersandToken
  ) {
    collectAndClauses(node.left, out);
    collectAndClauses(node.right, out);
  } else {
    out.push(node);
  }
}
```

Helper to extract a typeof guard from a single clause:

```typescript
function extractTypeofGuard(
  node: typescript.Node,
): { paramName: string; narrowedType: SimpleType } | undefined
```

Returns `undefined` if the clause does not match the `typeof param === "string"/"number"/"boolean"` pattern.

### 5.2 Updated `validateExpression`

`validateExpression` is the sole public entry point for validation. Its signature does **not** change:

```typescript
export function validateExpression(
  node: typescript.Expression,
  expression: string,
  location: string,
  knownIdentifiers?: Set<string>,
  paramTypes?: Map<string, TypeMapValue>,
  checker?: typescript.TypeChecker,
  contextNode?: typescript.FunctionLikeDeclaration,
): ValidationError[]
```

Inside `validateExpression`, the existing block:

```typescript
if (paramTypes !== undefined) {
  collectTypeMismatches(node, expression, location, paramTypes, errors);
}
```

becomes:

```typescript
if (paramTypes !== undefined) {
  const effectiveTypes = buildNarrowedTypeMap(node, paramTypes);
  collectTypeMismatches(node, expression, location, effectiveTypes, errors);
}
```

`collectTypeMismatches` itself is unchanged.

---

## 6. Changes Summary

| File | Change |
|---|---|
| `src/contract-validator.ts` | New file-private helpers `collectAndClauses`, `extractTypeofGuard`, `buildNarrowedTypeMap` |
| `src/contract-validator.ts` | `validateExpression` — replace direct `paramTypes` pass to `collectTypeMismatches` with `buildNarrowedTypeMap(node, paramTypes)` result |
| `src/type-helpers.ts` | No changes |
| Public API | No changes — `validateExpression` signature is unchanged |

---

## 7. Testing Plan

All test cases are in `src/contract-validator.test.ts` (or a new `compound-conditions` describe block within it).

### 7.1 Primary: `typeof` narrowing enables mismatch detection

| Scenario | Parameter type | Expression | Expected |
|---|---|---|---|
| Narrowed to `string`, wrong literal | `string \| number` | `typeof x === "string" && x === 42` | warn: `x` is `string` but compared to `number` literal |
| Narrowed to `number`, correct | `string \| number` | `typeof x === "number" && x > 0` | no warning |
| Narrowed to `boolean`, wrong literal | `boolean \| number` | `typeof x === "boolean" && x === 1` | warn: `x` is `boolean` but compared to `number` literal |
| Narrowed to `string`, correct | `string \| number` | `typeof x === "string" && x === "hello"` | no warning |

### 7.2 Existing behaviour preserved: non-union parameter

| Scenario | Parameter type | Expression | Expected |
|---|---|---|---|
| Already resolves to `string` | `string` | `typeof x === "string" && x === 42` | warn (existing behaviour — `x` was already in `paramTypes` as `"string"`; narrowed map does not override) |
| Already resolves to `number` | `number` | `typeof x === "number" && x > 0` | no warning |

### 7.3 Null-check narrowing: confirm existing union resolution is unaffected

| Scenario | Parameter type | Expression | Expected |
|---|---|---|---|
| Null-check union | `number \| null` | `x !== null && x === "zero"` | warn: `x` is `number` but compared to `string` literal (resolved via existing `resolveSimpleType`, no change in behaviour) |

### 7.4 Edge cases

| Scenario | Expression | Expected |
|---|---|---|
| `typeof` guard on `||` (not `&&`) | `typeof x === "string" \|\| x === 42` where `x: string \| number` | no warning (narrowing not applied to `\|\|` chains) |
| Multiple guards in same `&&` chain | `typeof x === "string" && typeof y === "number" && x === 42` where `x: string \| number`, `y: string \| number` | warn on `x === 42`; no warn on `y` (not compared to wrong type) |
| Unknown identifier in guard | `typeof z === "string" && z === 42` where `z` is not a parameter | no type-mismatch (unknown-identifier error emitted by existing `collectUnknownIdentifiers`; `buildNarrowedTypeMap` adds `z` to effective map, but `collectUnknownIdentifiers` catches it) |
| `typeof` with `==` (loose equality) | `typeof x == "string" && x === 42` | no narrowing extracted (only `===` is recognised) |

---

## 8. Out of Scope

- **`||` narrowing** — asymmetric; not addressed in this issue.
- **`instanceof` narrowing** — does not interact with `SimpleType` comparisons.
- **Negative typeof guards** (`typeof x !== "string"`) — narrowing applies to the else-branch, not the current clause.
- **Nested `&&` sub-expressions** — only top-level `&&` chains are walked.
- **`typeof` with property chains** (`typeof obj.prop === "string"`) — `extractTypeofGuard` matches only plain `Identifier` nodes inside `typeof`; property chains are ignored.
- **Narrowing across multiple clauses of the same parameter** — e.g. `typeof x === "string" && typeof x === "number"` (contradictory guards); the first matching guard wins; no conflict detection.
