# Contract Expression Validation — Design Doc

**Date:** 2026-04-08
**Scope:** Tier A — assignment operator detection in `@pre`/`@post` expressions

---

## 1. Problem

`tryRewriteFunction` currently swallows all transformation errors silently. A developer who writes `@pre x = v` (assignment instead of comparison) gets no feedback — the contract is skipped without warning. This spec implements the Safety Invariant from spec 002 §6 for the assignment-operator case.

---

## 2. Goal

Detect assignment operators in contract expressions at transform time, report them as warnings, and skip injection for the offending tag while leaving all other tags and the function body untouched.

---

## 3. Architecture

### New module: `src/contract-validator.ts`

Responsible solely for semantic validation of parsed contract expressions. Kept separate from `ast-builder.ts` (which handles AST construction) to avoid further complexity growth in that file and to allow independent testing.

Accepts a pre-parsed `typescript.Expression` node rather than a raw string, avoiding a second parse of the same expression.

### Refactor: `parseContractExpression` extracted from `buildGuardIf`

`buildGuardIf` currently parses and reifies in one step. The parse is extracted into an exported `parseContractExpression(expression: string): typescript.Expression` helper so both the validator and the reifier consume the same node.

---

## 4. API

```typescript
// src/contract-validator.ts

export type ValidationErrorKind = 'assignment-in-expression';

export interface ValidationError {
  kind: ValidationErrorKind;
  expression: string;
  location: string;
  message: string;
}

/**
 * Walks a parsed contract expression AST and returns all validation errors.
 * Returns an empty array when the expression is clean.
 */
export function validateExpression(
  node: typescript.Expression,
  expression: string,
  location: string,
): ValidationError[];
```

```typescript
// src/ast-builder.ts (new export)

/**
 * Parses a contract expression string into a TypeScript Expression node.
 * Throws if the string cannot be parsed as a valid expression.
 */
export function parseContractExpression(expression: string): typescript.Expression;
```

---

## 5. Validation Rules (Tier A)

### Rule: `assignment-in-expression`

Detects any `BinaryExpression` whose operator is an assignment token:

| Token | Operator |
|---|---|
| `EqualsToken` | `=` |
| `PlusEqualsToken` | `+=` |
| `MinusEqualsToken` | `-=` |
| `AsteriskEqualsToken` | `*=` |
| `SlashEqualsToken` | `/=` |
| `PercentEqualsToken` | `%=` |
| `AsteriskAsteriskEqualsToken` | `**=` |
| `AmpersandEqualsToken` | `&=` |
| `BarEqualsToken` | `\|=` |
| `CaretEqualsToken` | `^=` |
| `LessThanLessThanEqualsToken` | `<<=` |
| `GreaterThanGreaterThanEqualsToken` | `>>=` |
| `GreaterThanGreaterThanGreaterThanEqualsToken` | `>>>=` |

The walk is exhaustive — a nested assignment such as `(x = 1) > 0` produces an error for the inner `x = 1` node. Multiple violations in one expression each produce a separate `ValidationError`.

**Suggested fix hint:** append `did you mean '==='?` to the message when the operator is `=`.

---

## 6. Transformer Integration

In `buildGuardedStatements` (`transformer.ts`), for each contract tag:

1. Call `parseContractExpression(tag.expression)` to get the AST node.
2. Call `validateExpression(node, tag.expression, location)`.
3. If errors are returned:
   - Log each error via `console.warn` in the format below.
   - Skip `buildPreCheck` / `buildPostCheck` for this tag.
   - Continue to the next tag (other tags on the same function are unaffected).
4. If no errors, proceed as today.

**Warning format:**
```
[axiom] Contract validation warning in <location>:
  @<kind> <expression> — <message>
```

Example:
```
[axiom] Contract validation warning in Account.withdraw:
  @pre x = v — assignment operator is not allowed (did you mean '==='?)
```

---

## 7. Error Collection Behaviour

- Errors are collected per-tag, not per-function. A function with three tags where one has an assignment error will inject the two clean tags and skip only the bad one.
- `tryRewriteFunction`'s existing catch-all remains as a last-resort safety net. Validation errors are handled before that level and never reach it.
- `console.warn` is used for now. Proper `ts.Diagnostic` emission (which requires `Program` integration) is deferred to a future spec alongside tier B/C validation.

---

## 8. Testing Plan

### `test/contract-validator.test.ts` (new)
- Clean expression returns `[]`
- `x = v` returns one error with kind `assignment-in-expression` and a `===` hint
- `x += 1` returns one error
- Nested assignment `(x = 1) > 0` returns one error for the inner node
- All compound assignment operators (`+=`, `-=`, `*=`, `/=`, etc.) each return an error

### `test/ast-builder.test.ts` (additions)
- `parseContractExpression('amount > 0')` returns an `Expression` node
- `parseContractExpression('!(x)')` parses correctly (prefix unary)
- Malformed expression throws

### `test/transformer.test.ts` (additions)
- Function with `@pre x = v` transforms without the guard; `console.warn` is called with the location and expression
- Function with `@pre amount > 0` and `@pre x = v` injects the clean tag and skips the bad one; `console.warn` called once
- Function with only clean tags does not call `console.warn`

---

## 9. Out of Scope (This Spec)

- Tier B: undefined identifier detection (identifier not in function parameter list)
- Tier C: type mismatch detection (requires `Program` type checker)
- `ts.Diagnostic` integration (deferred until tier B/C when `Program` is already needed)
- `@post` expression validation beyond assignment (covered by same rules — no special casing needed)
