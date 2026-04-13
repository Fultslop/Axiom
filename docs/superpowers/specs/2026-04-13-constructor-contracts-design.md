# Constructor Contracts — Design Doc

**Date:** 2026-04-13
**Covers issue:** #16 (constructor `@pre`/`@post` silently dropped)

---

## 1. Problem

`@pre` and `@post` JSDoc tags on constructors are silently dropped. No contract check is injected and no warning is emitted. The class rewriter (`src/class-rewriter.ts`) visits the constructor to inject the invariant check at the end of the body, but the `rewriteConstructor` function ignores any `@pre`/`@post` tags entirely.

```typescript
export class Account {
  /**
   * @pre initialBalance >= 0        ← silently dropped
   * @post this.balance === initialBalance  ← silently dropped
   */
  constructor(initialBalance: number) {
    this.balance = initialBalance;
  }
}
```

The user has no indication that their contracts were not applied. The code compiles and runs without enforcement.

---

## 2. Goal

Constructors with `@pre` and/or `@post` tags should have those contracts injected, with the same validation, warning, and injection quality that applies to regular methods and standalone functions. Specifically:

- `@pre` expressions are checked at the top of the constructor body (before any user code runs).
- `@post` expressions are checked after the constructor body completes (before the invariant check).
- `result` is not meaningful in a constructor. Any `@post` tag that references `result` emits a warning and is dropped.
- `this` is valid in both `@pre` and `@post` (it refers to the partially-constructed object at each point).
- `prev` is not applicable to constructors. Any `@post` tag that references `prev` emits a warning and is dropped. No `@prev` tag is parsed from the constructor JSDoc.
- When invariants are also present, the invariant check runs after `@post` checks.
- The location string used in error messages and warnings is `ClassName` (the class name alone, no `.constructor` suffix), matching the convention for invariant violations already reported on constructors.

---

## 3. Approach

### 3.1 Parsing `@pre`/`@post` tags from the constructor

The existing `extractContractTags` function (used in `function-rewriter.ts`) parses all `@pre` and `@post` JSDoc tags from a `FunctionLikeDeclaration`. `ConstructorDeclaration` is a `FunctionLikeDeclaration`, so the same call works without modification.

In `rewriteConstructor`, retrieve the reparsed constructor node from the `reparsedIndex.functions` map (keyed by `node.pos`) before calling `extractContractTags`, exactly as `rewriteFunction` does for methods. The reparsed node is used to read JSDoc tags because the original AST node post-transform may have had its JSDoc stripped. Fall back to the original node if no reparsed entry exists.

```
reparsedNode = reparsedIndex.functions.get(constructor.pos) ?? constructor
contractTags = extractContractTags(reparsedNode)
preTags = contractTags.filter(tag => tag.kind === 'pre')
postTags = contractTags.filter(tag => tag.kind === 'post')
```

### 3.2 Filtering `@post` tags that reference `result`

Constructors return `void` implicitly. The `result` binding is not injected in constructor rewrites and has no meaning. Any `@post` tag whose expression contains the identifier `result` must be dropped with a warning.

Reuse the existing `expressionUsesResult` helper (currently private in `function-rewriter.ts`). Export it or extract it to a shared utility, then call it from the constructor rewrite path. The warning message format follows the established pattern:

```
[axiom] Contract validation warning in ClassName:
  @post <expression> — 'result' used in constructor @post; @post dropped
```

### 3.3 Filtering `@post` tags that reference `prev`

`prev` is only meaningful when a pre-execution snapshot is taken. For methods, the snapshot is `{ ...this }` by default. For constructors, no pre-construction state of `this` is available, and a shallow clone of an uninitialized object would be misleading. Therefore `@prev` is not supported on constructors and no default prev capture is injected.

If any `@post` expression references the identifier `prev`, emit a warning and drop the tag:

```
[axiom] Contract validation warning in ClassName:
  @post <expression> — 'prev' used in constructor @post; @post dropped
```

This check should occur after the `result` filter, so both filters run independently.

### 3.4 Identifier validation

After filtering for `result` and `prev`, the remaining pre- and post-tags must be validated against known identifiers via `filterValidTags` (exported from `function-rewriter.ts`).

The known identifier sets for a constructor are built the same way as for methods — using `buildKnownIdentifiers` from `node-helpers.ts`:

- **Pre-check scope** (`pre = false`): parameters of the constructor plus `this`.
- **Post-check scope** (`pre = true`): parameters plus `this`. (`result` is not added because constructors return void.)

Pass `checker` and the constructor node as `contextNode` to `validateExpression` so that deep property chain validation (issue #9) applies to constructor contracts when a TypeChecker is available.

### 3.5 Injection ordering

The final constructor body is assembled in this order:

```
1. [validated @pre checks]         ← top of body, before user statements
2. [original body statements]      ← unchanged user code
3. [validated @post checks]        ← after body, before invariant
4. [#checkInvariants() call]       ← invariant check, only if invariants exist
```

This ordering ensures:
- Preconditions catch invalid inputs before any mutation occurs.
- Postconditions verify the object state that the user code produced.
- Invariants validate the fully-constructed object's class-level properties last.

For the common case where only `@pre` tags are present (no `@post`, no invariants), the body is simply the pre-checks followed by the original statements — no wrapping needed.

For the case where `@post` tags or an invariant call are present, the body uses the same pattern as `buildGuardedStatements` in `function-rewriter.ts`, but adapted for constructors:

- No `buildBodyCapture` / `buildResultReturn` wrapping is used (those exist to capture a return value; constructors have none).
- The original body statements are inlined directly.
- `@post` checks are appended after the original statements.
- The invariant call (if any) is appended after the `@post` checks.

```
statements = []
for each pre tag:
    statements.push(buildPreCheck(expression, location, factory, exportedNames))
statements.push(...originalBody.statements)
for each post tag:
    statements.push(buildPostCheck(expression, location, factory, exportedNames))
if invariants present:
    statements.push(buildCheckInvariantsCall(location, factory))
```

### 3.6 Location string

Use `className` (the class name alone) as the `location` argument passed to `buildPreCheck`, `buildPostCheck`, and `buildCheckInvariantsCall`. This is consistent with how invariant violations from constructors are currently reported (the existing `rewriteConstructor` passes `${className}.constructor` as the location for the invariant call today — this should be corrected to just `className` for consistency with the goal stated above).

Update the `location` variable in `rewriteConstructor` from `${className}.constructor` to `className`.

### 3.7 Signature changes to `rewriteConstructor`

The current signature:

```typescript
function rewriteConstructor(
  factory: typescript.NodeFactory,
  node: typescript.ConstructorDeclaration,
  className: string,
): typescript.ConstructorDeclaration
```

The new signature:

```typescript
function rewriteConstructor(
  factory: typescript.NodeFactory,
  node: typescript.ConstructorDeclaration,
  className: string,
  reparsedIndex: ReparsedIndex,
  effectiveInvariants: string[],
  warn: (msg: string) => void,
  checker: typescript.TypeChecker | undefined,
  allowIdentifiers: string[],
): typescript.ConstructorDeclaration
```

The `effectiveInvariants` parameter replaces the implicit guard `if (effectiveInvariants.length > 0)` currently in `rewriteMember`. The invariant call is now always delegated to `rewriteConstructor`, which is responsible for appending it when the array is non-empty. This removes the current split of responsibility where `rewriteMember` decides whether to call `rewriteConstructor` based on invariants while ignoring contracts.

### 3.8 Changes to `rewriteMember`

Currently `rewriteMember` only calls `rewriteConstructor` when `effectiveInvariants.length > 0`:

```typescript
if (typescript.isConstructorDeclaration(member) && effectiveInvariants.length > 0) {
  return { element: rewriteConstructor(factory, member, className), changed: true };
}
```

The new logic calls `rewriteConstructor` whenever the constructor has `@pre`/`@post` tags OR invariants are present. `rewriteConstructor` itself returns the original node unchanged if there is nothing to inject (no pre tags, no post tags, no invariant), so `rewriteMember` can call it unconditionally for every constructor:

```typescript
if (typescript.isConstructorDeclaration(member)) {
  const rewritten = rewriteConstructor(
    factory, member, className, reparsedIndex,
    effectiveInvariants, warn, checker, allowIdentifiers,
  );
  return { element: rewritten, changed: rewritten !== member };
}
```

`rewriteMember`'s own signature must be updated to accept and forward the additional parameters.

---

## 4. Changes Summary

| File | Change |
|---|---|
| `src/class-rewriter.ts` | Extend `rewriteConstructor` to parse, filter, and inject `@pre`/`@post` tags; update `rewriteMember` to always delegate to `rewriteConstructor`; thread `reparsedIndex`, `warn`, `checker`, `allowIdentifiers` through. |
| `src/function-rewriter.ts` | Export `expressionUsesResult` (or extract to a shared helper) so the constructor rewrite path can reuse it. |
| `src/node-helpers.ts` | No changes expected; `buildKnownIdentifiers` already works for any `FunctionLikeDeclaration`. |
| `src/ast-builder.ts` | No changes expected; `buildPreCheck` and `buildPostCheck` are already generic. |

---

## 5. Warning Messages

All warnings follow the existing `[axiom] Contract ... warning in <location>:` prefix convention.

| Situation | Message |
|---|---|
| `@post` uses `result` | `[axiom] Contract validation warning in ClassName:\n  @post <expr> — 'result' used in constructor @post; @post dropped` |
| `@post` uses `prev` | `[axiom] Contract validation warning in ClassName:\n  @post <expr> — 'prev' used in constructor @post; @post dropped` |
| `@pre` or `@post` expression fails identifier/property validation | `[axiom] Contract validation warning in ClassName:\n  @pre <expr> — <validation message>` (same format as method validation warnings) |

---

## 6. Testing Plan

All new tests belong in the existing class-rewriter test file (or a constructor-specific test file if the existing file is already large).

**Basic injection:**
- Constructor with `@pre initialBalance >= 0` → pre-check thrown at top of body; no warning emitted.
- Constructor with `@post this.balance === initialBalance` → post-check appended after original statements; no warning emitted.
- Constructor with both `@pre` and `@post` → pre at top, post after body statements; original code in between.

**Ordering with invariants:**
- Class with `@invariant this.balance >= 0` and constructor with `@post this.balance === initialBalance` → post-check appears before the `#checkInvariants()` call.
- Class with invariants and constructor with only `@pre` → pre at top, original statements, then invariant call (no post-check block).

**`result` filter:**
- Constructor with `@post result > 0` → warning emitted naming `result`, tag dropped; other valid contracts in the same constructor still injected.

**`prev` filter:**
- Constructor with `@post this.balance === prev.balance` → warning emitted naming `prev`, tag dropped.

**`this` in `@pre`:**
- Constructor with `@pre this.balance === 0` (checked before `initialBalance` assigned) → injected without warning (expression validated against known identifiers; `this` is in scope).

**Identifier validation:**
- Constructor with `@pre unknownVar > 0` where `unknownVar` is not a parameter or known identifier → validation warning, tag dropped.
- Constructor with `@pre this.balanc >= 0` (typo) when TypeChecker available → deep property chain warning, tag dropped.

**No-op case:**
- Constructor with no `@pre`/`@post` and class with no invariants → constructor node returned unchanged (no transformation, no `changed: true`).
- Constructor with no `@pre`/`@post` but class with invariants → only invariant call injected (existing behaviour preserved).

**Edge cases:**
- Constructor with no body (`declare` constructor or abstract constructor) → return node unchanged, no attempt to inject.
- All `@post` tags filtered out (all reference `result` or `prev`) → only pre-checks injected; if no pre-checks either, and no invariants, return unchanged.

---

## 7. Out of Scope

- **`@prev` on constructors.** There is no meaningful pre-construction snapshot of `this`. Supporting it (e.g. by allowing an explicit `@prev someExternalValue`) is deferred.
- **Private/protected constructors.** The injection applies regardless of constructor visibility. Access control on the constructor is orthogonal to contract enforcement.
- **Constructor overloads.** TypeScript constructor overloads use implementation signatures; only the implementation body exists in the AST. Contracts on overload signatures (if any) are not parsed. This is consistent with how method overloads are handled.
- **`super()` call interaction.** In derived classes, `this` is not accessible before `super()` is called. The `@pre` check is injected at the very top of the body, before `super()`. If the `@pre` expression references `this`, it will fail at runtime with a ReferenceError in derived classes. A future spec should address derived-class constructors separately (e.g. detecting `super()` and inserting pre-checks after it, or emitting a warning when the class extends another).
- **Interface-inherited constructor contracts.** Interfaces cannot declare constructors with `@pre`/`@post` in a meaningful way that the class rewriter merges. Deferred.
