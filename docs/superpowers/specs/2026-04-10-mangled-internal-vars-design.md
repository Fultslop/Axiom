# Design: Mangle Internal Contract Variables

**Date:** 2026-04-10
**Status:** Approved

## Problem

The transformer injects `const result = ...` and `const prev = ...` into function bodies. These names clash with user parameters named `result` or `prev`, causing a redeclaration error at runtime or silently shadowing the parameter inside the injected IIFE.

## Goal

Use collision-resistant internal variable names (`__axiom_result__`, `__axiom_prev__`) in generated code while keeping `result` and `prev` as the user-facing identifiers in JSDoc contract expressions and error messages.

## Approach

Substitute identifiers in `ast-builder.ts` only. No other files change.

### Constants

Two exported constants are added to `ast-builder.ts`:

```typescript
export const AXIOM_RESULT_VAR = '__axiom_result__';
export const AXIOM_PREV_VAR   = '__axiom_prev__';
```

### Declaration sites (3 changes in `ast-builder.ts`)

| Function | Change |
|---|---|
| `buildBodyCapture` | Identifier `'result'` → `AXIOM_RESULT_VAR` |
| `buildResultReturn` | Identifier `'result'` → `AXIOM_RESULT_VAR` |
| `buildPrevCapture` | Identifier `'prev'` → `AXIOM_PREV_VAR` |

### Expression substitution

A new private function `substituteContractIdentifiers` is added to `ast-builder.ts`:

```typescript
function substituteContractIdentifiers(
  factory: typescript.NodeFactory,
  node: typescript.Expression,
): typescript.Expression
```

It walks the expression AST using TypeScript's visitor API and replaces:
- `Identifier` with text `result` → fresh identifier `__axiom_result__`
- `Identifier` with text `prev` → fresh identifier `__axiom_prev__`

Called inside `buildPostCheck`, after `parseContractExpression` and before `reifyExpression`. `buildPreCheck` is not affected — `result` and `prev` are not valid in `@pre` expressions.

### What does NOT change

- `expressionUsesResult` / `expressionUsesPrev` in `function-rewriter.ts` — still scan for `result`/`prev` in user JSDoc strings
- `RESULT_ID` in `function-rewriter.ts` — stays `'result'`
- All `[axiom]` warning messages — still reference the original expression string
- `ContractViolationError` message — still carries the original expression text (e.g. `result === this.balance`)
- `buildPreCheck` — no substitution

## Generated output

```typescript
// Before
const prev = { ...this };
const result = (() => { this.balance -= amount; return this.balance; })();
if (!(result === this.balance)) throw new ContractViolationError('POST', 'result === this.balance', 'Account.withdraw');
return result;

// After
const __axiom_prev__ = { ...this };
const __axiom_result__ = (() => { this.balance -= amount; return this.balance; })();
if (!(__axiom_result__ === this.balance)) throw new ContractViolationError('POST', 'result === this.balance', 'Account.withdraw');
return __axiom_result__;
```

## Test impact

- **Acceptance tests** — unaffected (they don't reference `result` or `prev` by name in assertions)
- **Transformer unit tests** — any `expect(output).toContain('result')` / `toContain('prev')` assertions on generated variable names must be updated to `__axiom_result__` / `__axiom_prev__`
