# ESM-Aware Identifier Substitution — Design Doc

**Date:** 2026-04-22
**Covers:** Spec 004 finding #5 — `exports.` prefix for module-level references breaks ESM output (Critical)

---

## 1. Problem

`substituteContractIdentifiers` in `src/ast-builder.ts` rewrites module-level exported names in contract expressions to `exports.Name`. This is a CJS-only pattern. In ESM output (`module: ESNext`, `Node16`, `NodeNext`), `exports` is not defined at runtime, causing a `ReferenceError` when the contract guard fires — at exactly the moment it should be protecting the user.

`require-injection.ts` already emits ESM `import` declarations for ESM targets; the `exports.` substitution has no corresponding awareness.

**Example:**

```typescript
const MAX_LIMIT = 100;
/** @pre n <= MAX_LIMIT */
export function cap(n: number) { ... }
```

Current output (broken for ESM):
```javascript
if (!(n <= exports.MAX_LIMIT)) throw new ContractViolationError(…);
```

Correct output for ESM targets:
```javascript
if (!(n <= MAX_LIMIT)) throw new ContractViolationError(…);
```

In ESM, the `import`/`const` declaration already makes `MAX_LIMIT` available in scope — no `exports.` prefix needed.

---

## 2. Goals

- For CJS targets (`module: CommonJS`, `AMD`, `UMD`, etc.), `exports.Name` substitution continues unchanged.
- For ESM targets (`module: ESNext`, `ES2015`–`ES2022`, `Node16`, `NodeNext`), bare identifiers are emitted — no `exports.` prefix.
- The `moduleKind` (or an `isEsm` boolean) is threaded through `TransformerContext` and used in `substituteContractIdentifiers`.
- No change to the public API or plugin config — detection is automatic from the host `CompilerOptions`.

---

## 3. Approach

### 3.1 Thread `moduleKind` through `TransformerContext`

**Location:** `src/transformer.ts` / `src/types.ts`.

The TypeScript program's `CompilerOptions.module` value is available in the transformer factory. Add `isEsm: boolean` to `TransformerContext`, computed as:

```typescript
const { module: moduleKind = typescript.ModuleKind.CommonJS } = compilerOptions;
const isEsm =
  moduleKind === typescript.ModuleKind.ES2015 ||
  moduleKind === typescript.ModuleKind.ES2020 ||
  moduleKind === typescript.ModuleKind.ES2022 ||
  moduleKind === typescript.ModuleKind.ESNext ||
  moduleKind === typescript.ModuleKind.Node16 ||
  moduleKind === typescript.ModuleKind.NodeNext;
```

### 3.2 `substituteContractIdentifiers` in `src/ast-builder.ts`

The function currently replaces every exported-name identifier with `exports.Name`. Add the `isEsm` flag as a parameter (or as part of a context object already passed in). When `isEsm` is true, skip the `exports.` substitution — return the bare identifier node unchanged.

```typescript
function substituteContractIdentifiers(
  expr: typescript.Expression,
  exportedNames: Set<string>,
  isEsm: boolean,
  factory: typescript.NodeFactory,
): typescript.Expression {
  if (isEsm) return expr; // bare identifiers are in scope via ESM imports
  // ... existing CJS substitution logic
}
```

If the substitution is more granular (per-identifier rather than whole-expression), apply the `isEsm` guard inside the identifier-level replacement.

### 3.3 Call sites

`buildPreCheck` and `buildPostCheck` call `substituteContractIdentifiers`. Both receive context (or enough information to derive `isEsm`). Thread the flag through.

### 3.4 Test coverage for ESM path

Tests using `transpileModule` can pass `compilerOptions: { module: typescript.ModuleKind.ESNext }` to exercise the ESM path.

---

## 4. Changes Summary

| File | Change |
|---|---|
| `src/types.ts` | Add `isEsm: boolean` to `TransformerContext` |
| `src/transformer.ts` | Compute `isEsm` from `compilerOptions.module`; assign to context |
| `src/ast-builder.ts` | `substituteContractIdentifiers` gains `isEsm` parameter; skips `exports.` substitution when true |
| `src/function-rewriter.ts` | Thread `isEsm` from context through to `buildPreCheck`/`buildPostCheck` call sites |

---

## 5. Testing Plan

- Module-level `const` referenced in `@pre` with CJS output → verify `exports.Name` in emitted code
- Same source with `module: ESNext` → verify bare `Name` in emitted code (no `exports.`)
- Module-level `enum` referenced in `@post` with `module: Node16` → verify bare identifier
- Module-level `const` referenced in `@pre` with `module: CommonJS` → verify `exports.Name` still emitted (regression)
- Contract that references only parameters (no module-level names) → unaffected by either path (no `exports.` was ever emitted)

---

## 6. Out of Scope

- `export const` identifier resolution for re-exported names from other modules — contracts reference names in scope in the current file only.
- Dynamic `module` detection at runtime (the check is compile-time via `compilerOptions`).
- `require-injection.ts` changes — the ESM import injection already works correctly; this spec only fixes the identifier substitution.
