# Plan: `@prev` capture for `@post` conditions

**Date:** 2026-04-09
**Status:** Ready to implement

## Summary

Add a `@prev` JSDoc tag that captures state before the function body executes, making it available as `prev` inside `@post` expressions. This enables postconditions like:

```typescript
/** @post this.balance === prev.balance + x */
addToBalance(x: number): void { ... }
```

## Design

### Three-tier `@prev` syntax

| Tag | Injected code | When to use |
|---|---|---|
| No `@prev` tag (method only) | `const prev = { ...this };` | Default — shallow clone of `this` |
| `@prev deep` | `const prev = deepSnapshot(this);` | Full clone via `structuredClone` with JSON fallback |
| `@prev <expression>` | `const prev = <expression>;` | User-controlled — any valid TS expression |

### Rules

- `prev` in a `@post` on a **method** with no `@prev` tag → auto shallow clone
- `prev` in a `@post` on a **standalone function** with no `@prev` tag → warn + drop that `@post`
- `@prev deep` on a standalone function → warn + drop (no `this` to clone)
- `@prev <expr>` on a standalone function → works (expr may reference parameters)
- Multiple `@prev` tags → warn, use first
- `@prev` on interface method signatures → inherited by implementing classes; parameter rename applied to the expression
- Both interface and class define `@prev` → warn, class-level wins

### Utilities

Export `snapshot` and `deepSnapshot` from `fsprepost`:

```typescript
export function snapshot<T extends object>(obj: T): T {
  return { ...obj } as T;
}

export function deepSnapshot<T>(obj: T): T {
  return typeof structuredClone !== 'undefined'
    ? structuredClone(obj)
    : JSON.parse(JSON.stringify(obj)) as T;
}
```

Usable directly in `@prev` expressions:

```typescript
/** @prev snapshot(this.items) */
/** @prev deepSnapshot(this) */
/** @prev { balance: this.balance, x } */
/** @prev this.balance */
```

Parameters are in scope for any `@prev` expression — captured before the body runs.

### Generated output shape

```typescript
const prev = { ...this };           // @prev expression (conditional)
const result = (() => {
  this.balance += x;
  return this.balance;
})();
if (!(this.balance === prev.balance + x)) throw new ContractViolationError(...);
return result;
```

---

## Implementation phases

### Phase 1 — Runtime utilities (`src/assertions.ts`, `src/index.ts`)

- Add `snapshot<T extends object>(obj: T): T` — spread shallow clone
- Add `deepSnapshot<T>(obj: T): T` — `structuredClone` with `JSON.parse/stringify` fallback
- Export both from `src/index.ts`

### Phase 2 — `@prev` tag parsing (`src/jsdoc-parser.ts`)

Add `extractPrevExpression(node: typescript.Node): string | undefined`:

- Scans `getJSDocTags(node)` for tag named `prev`
- Comment is `deep` → returns `'deepSnapshot(this)'`
- Comment is non-empty string → returns it verbatim as the capture expression
- Tag absent or comment empty → returns `undefined` (caller decides default)

No new type needed — prev is a single string, not a `ContractTag`.

### Phase 3 — Interface contracts carry `prevExpression` (`src/interface-resolver.ts`)

Extend `InterfaceMethodContracts`:

```typescript
export interface InterfaceMethodContracts {
  preTags: ContractTag[];
  postTags: ContractTag[];
  sourceInterface: string;
  prevExpression?: string;   // new
}
```

In `extractMethodContracts`:
- Call `extractPrevExpression(sig)` on the interface method signature
- Apply parameter rename to the expression (same logic as tag expressions)
- Store in the returned object

In `mergeMethodContracts`:
- If both `existing` and `incoming` have `prevExpression` → warn, keep `existing`
- Otherwise first-defined wins

### Phase 4 — Resolve prev capture (`src/function-rewriter.ts`)

New function `resolvePrevCapture`:

```typescript
function resolvePrevCapture(
  node: typescript.FunctionLikeDeclaration,
  reparsedNode: typescript.FunctionLikeDeclaration,
  interfaceMethodContracts: InterfaceMethodContracts | undefined,
  location: string,
  warn: (msg: string) => void,
): string | null
```

Logic (in order):
1. Class-level `@prev` tag from `extractPrevExpression(reparsedNode)` → use it
2. `interfaceMethodContracts?.prevExpression` → use it
3. Neither, and node is a method → default `'{ ...this }'`
4. Neither, and node is a standalone function → `null`

New filter `filterPostTagsRequiringPrev`:
- Walk each `@post` expression AST (same approach as `expressionUsesResult`) to detect `prev` identifier usage
- If capture is `null` → warn + drop those `@post` tags
- Called after `filterPostTagsWithResult`, before `filterValidTags`

### Phase 5 — AST injection (`src/ast-builder.ts`)

New function:

```typescript
export function buildPrevCapture(
  expression: string,
  factory: typescript.NodeFactory,
): typescript.VariableStatement
```

Generates `const prev = <expression>;` by parsing `expression` through the same reifier path used for contract expressions.

### Phase 6 — Wire into `buildGuardedStatements` (`src/function-rewriter.ts`)

Add `prevCapture: string | null` parameter to `buildGuardedStatements`.

When `postTags.length > 0 || invariantCall !== null`:
1. If `prevCapture !== null` → emit `buildPrevCapture(prevCapture, factory)` **before** the IIFE
2. Then emit `buildBodyCapture(...)` as today

### Phase 7 — Known identifiers (`src/node-helpers.ts`)

Add `'prev'` to the post known identifiers set in `buildKnownIdentifiers` (alongside `result`). This allows the contract validator to accept `prev` references in `@post` expressions without unknown-identifier warnings.

### Phase 8 — Require injection (`src/require-injection.ts`)

Add `snapshot` and `deepSnapshot` to the destructured `require('axiom')` binding.

Strategy: always include both when contract checks are being injected. The overhead is negligible and avoids tracking whether the user's `@prev` expression references them by name.

### Phase 9 — Merge warning (`src/class-rewriter.ts`)

In `emitMethodMergeWarnings`: if both interface and class define a `@prev` expression → emit a warning that class-level takes precedence.

### Phase 10 — Tests

New cases in `test/transformer.test.ts`:

| Case | Expected |
|---|---|
| Method, `prev` in `@post`, no `@prev` tag | `const prev = { ...this }` injected |
| Method, `@prev deep` | `const prev = deepSnapshot(this)` injected |
| Method, `@prev { balance: this.balance, x }` | verbatim expression injected |
| Method, `@prev this.balance`, `@post this.balance === prev + x` | `prev` is a scalar |
| Standalone function, `prev` in `@post`, no `@prev` | warn + drop |
| Standalone function, `@prev { x }`, `@post result === prev.x + 1` | works |
| `@post` with no `prev` reference, no `@prev` tag | no `const prev` injected |
| Multiple `@prev` tags | warn, first used |

New cases in `test/interface-resolver.test.ts`:

| Case | Expected |
|---|---|
| Interface `@prev` inherited by class | class gets capture expression |
| Interface `@prev` with param rename | expression updated |
| Both interface and class define `@prev` | warn, class wins |

### Phase 11 — README

- Add `@prev` to Supported cases
- New subsection under `@post` docs: "Capturing previous state with `@prev`"
  - Three-tier table
  - `structuredClone` availability note for `@prev deep`
  - Standalone function limitation
  - Interface inheritance behaviour

---

## Files touched

| File | Change |
|---|---|
| `src/assertions.ts` | Add `snapshot`, `deepSnapshot` |
| `src/index.ts` | Export both |
| `src/jsdoc-parser.ts` | Add `extractPrevExpression` |
| `src/interface-resolver.ts` | Add `prevExpression` to `InterfaceMethodContracts`; extract, rename, merge |
| `src/ast-builder.ts` | Add `buildPrevCapture` |
| `src/node-helpers.ts` | Add `prev` to post known identifiers |
| `src/function-rewriter.ts` | `resolvePrevCapture`, `filterPostTagsRequiringPrev`, wire into `buildGuardedStatements` |
| `src/class-rewriter.ts` | Merge warning for duplicate `@prev` |
| `src/require-injection.ts` | Add `snapshot`, `deepSnapshot` to require binding |
| `test/transformer.test.ts` | ~8 new test cases |
| `test/interface-resolver.test.ts` | ~3 new cases |
| `README.md` | Document feature |

## Out of scope for this plan

- Constructor `@prev` (constructor contracts not yet supported)
- `prev` inside invariant expressions
- Async functions and generators (not yet supported)
- Deep tracking of nested mutations (user's responsibility via custom `@prev` expression)
