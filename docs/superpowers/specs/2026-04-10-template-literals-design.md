# Template Literal Support — Design Doc

**Date:** 2026-04-10
**Covers limitation:** #6 (template literals)

---

## 1. Problem

The README states that template literals in contract expressions produce "no type-mismatch warning." The actual behaviour is worse: the reifier (`src/reifier.ts`) throws `Unsupported expression node kind: TemplateExpression` when it encounters a template literal. This exception propagates to `tryRewriteFunction`'s catch-all, which silently returns the original node — **dropping all contracts on the function, not just the offending tag**.

Two distinct problems:

1. **Bug**: A template literal in one contract tag causes silent total contract loss for the entire function.
2. **Gap**: Template literals are genuinely unsupported — even simple no-substitution forms (`` `plain string` ``) cannot be injected.

Both are addressed here. Fix A (validation-phase detection) resolves the bug. Fix B (reifier support) resolves the gap and supersedes Fix A.

---

## 2. Goals

- A template literal in one contract tag emits a clear warning for that tag only; all other tags on the function are injected normally.
- `NoSubstitutionTemplateLiteral` (`` `plain string` ``) works in contract expressions.
- `TemplateExpression` (`` `item_${id}` ``) works in contract expressions.
- No-substitution template literals are recognised as string literals for type mismatch detection.
- The README description for limitation #6 is corrected.

---

## 3. Fix A — Validation-Phase Detection (Bug Fix)

Catch template literals in `filterValidTags` before they reach the reifier, producing a targeted warning and dropping only the affected tag.

### 3.1 New validation error kind (`src/contract-validator.ts`)

```typescript
export type ValidationErrorKind =
  | 'assignment-in-expression'
  | 'unknown-identifier'
  | 'type-mismatch'
  | 'unsupported-syntax';            // NEW
```

### 3.2 New walker: `collectUnsupportedSyntax`

```typescript
function collectUnsupportedSyntax(
  node: typescript.Node,
  expression: string,
  location: string,
  errors: ValidationError[],
): void {
  if (
    node.kind === typescript.SyntaxKind.TemplateExpression ||
    node.kind === typescript.SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    errors.push({
      kind: 'unsupported-syntax',
      expression,
      location,
      message: 'template literals are not supported in contract expressions',
    });
    return; // no need to recurse into the template
  }
  typescript.forEachChild(node, (child) =>
    collectUnsupportedSyntax(child, expression, location, errors));
}
```

Called from `validateExpression` before the other checks. When an error is returned, `filterValidTags` emits the standard warning and drops only that tag — identical to the handling of `unknown-identifier` errors.

**Warning output:**
```
[axiom] Contract validation warning in tag:
  @pre label === `item_${id}` — template literals are not supported in contract expressions
```

Fix A alone resolves the bug. Fix B below makes the warning obsolete by adding real support.

---

## 4. Fix B — Reifier Support (Enhancement)

Add `NoSubstitutionTemplateLiteral` and `TemplateExpression` support to `reifyExpression` in `src/reifier.ts`.

### 4.1 `NoSubstitutionTemplateLiteral` (`src/reifier.ts` → `reifyLiteralOrKeyword`)

```typescript
if (typescript.isNoSubstitutionTemplateLiteral(node)) {
  return factory.createNoSubstitutionTemplateLiteral(node.text, node.rawText);
}
```

### 4.2 `TemplateExpression` (`src/reifier.ts` → `reifyCompositeExpression`)

```typescript
if (typescript.isTemplateExpression(node)) {
  return factory.createTemplateExpression(
    factory.createTemplateHead(node.head.text, node.head.rawText),
    node.templateSpans.map((span) =>
      factory.createTemplateSpan(
        reifyExpression(factory, span.expression),
        typescript.isTemplateMiddle(span.literal)
          ? factory.createTemplateMiddle(span.literal.text, span.literal.rawText)
          : factory.createTemplateTail(span.literal.text, span.literal.rawText),
      ),
    ),
  );
}
```

### 4.3 Remove Fix A once Fix B ships

Once the reifier supports template literals, `collectUnsupportedSyntax` and the `'unsupported-syntax'` error kind are removed. If both fixes land in the same release, Fix A is omitted entirely.

### 4.4 Type mismatch detection for `NoSubstitutionTemplateLiteral`

A no-substitution template literal is a string value. Extend `getLiteralSimpleType` in `contract-validator.ts`:

```typescript
if (typescript.isNoSubstitutionTemplateLiteral(node)) {
  return TYPE_STRING;
}
```

`TemplateExpression` nodes are not given a simple type mapping — the interpolated result is always a string at runtime, but assigning `TYPE_STRING` to a `TemplateExpression` in the validator is deferred (it requires distinguishing `TemplateExpression` from `NoSubstitutionTemplateLiteral` in `getLiteralSimpleType`, which is straightforward but out of scope for this spec).

---

## 5. README Correction

Update limitation #6 in `README.md`.

**Before (inaccurate):**
> template literals are not recognised as typed string literals, so type mismatch between a typed parameter and a template literal is not detected

**After Fix A, before Fix B:**
> template literals in contract expressions cause the contract to be dropped with a warning

**After Fix B ships:** Remove limitation #6 from the README entirely, or retain a narrow note that `TemplateExpression` type-mismatch detection is not performed (only `NoSubstitutionTemplateLiteral` is recognised as a string literal for that purpose).

---

## 6. Testing Plan

### Fix A
- `@pre label === \`item_${id}\`` → warning emitted for that tag; other contracts on the same function are injected normally
- Function with two tags — `@pre x > 0` and `@pre label === \`item_${id}\`` — first contract injected, second warned and dropped

### Fix B — `NoSubstitutionTemplateLiteral`
- `@pre label === \`hello\`` → contract injected with `` `hello` `` in the guard condition
- Type mismatch: `@pre label === \`hello\`` where `label: number` → type-mismatch warning (`label` is number, compared to string literal)

### Fix B — `TemplateExpression`
- `@pre label === \`item_${id}\`` where `label: string`, `id: string` → contract injected; generated code contains a template literal in the guard condition
- `id` is scope-checked as a known identifier (it is a parameter)

---

## 7. Out of Scope

- Tagged template literals (`` sql`SELECT ...` ``) — these parse as `TaggedTemplateExpression`, which is a call-like form. Not addressed by this spec.
- Type mismatch detection for `TemplateExpression` (interpolated strings) — the runtime type is always `string`, but annotating it as `TYPE_STRING` in the validator is deferred.
