# AST-Based Identifier Rename in Interface Resolver — Design Doc

**Date:** 2026-04-22
**Covers:** Spec 004 finding #6 — `renameIdentifiersInExpression` uses regex word-boundary replacement (High)

---

## 1. Problem

`interface-resolver.ts` renames parameter identifiers in contract expressions using `new RegExp('\\b' + escaped + '\\b', 'g')`. This has two failure modes:

1. **Order dependence:** A rename map with both `val → value` and `value → amount` produces double-renamed garbage if `val` is processed first — the `value` replacement then rewrites the just-substituted `value` to `amount`.

2. **False boundary matches:** `\b` treats `$` and `_` as word characters, creating latent boundary mismatch bugs (e.g. parameter `x` matching inside `x_val`).

The transformer already has the infrastructure to parse contract expressions into an AST (`parseContractExpression`) and print them back (`reifyExpression`). Using text-level regex on AST content is inconsistent and fragile.

---

## 2. Goals

- Identifier renaming in `renameIdentifiersInExpression` operates on the expression AST, not on text.
- The rename is order-independent: each identifier node is visited once and renamed at most once.
- No regex-based identifier substitution remains in `interface-resolver.ts`.
- The function signature is unchanged so callers are unaffected.

---

## 3. Approach

### 3.1 Parse → walk → print

Replace the current regex loop in `renameIdentifiersInExpression` with:

1. **Parse** the expression string using `parseContractExpression` (already available in the module or importable from `ast-builder.ts`).
2. **Walk** the AST using a recursive visitor that targets `Identifier` nodes. For each identifier whose `text` appears as a key in the rename map, create a replacement `Identifier` node with the mapped name. Non-identifier nodes are recursed into unchanged.
3. **Print** the transformed AST back to a string using TypeScript's printer (`ts.createPrinter().printNode(...)`).

Because the walk visits each identifier node exactly once and substitution is from the original map (not the mutated output), order dependence is eliminated.

### 3.2 Visitor implementation

```typescript
function renameIdentifiersInExpression(
  expr: string,
  renameMap: Map<string, string>,
): string {
  if (renameMap.size === 0) return expr;
  const sourceFile = parseExpressionToSourceFile(expr); // existing or new helper
  const printer = typescript.createPrinter();

  function visit(node: typescript.Node): typescript.Node {
    if (typescript.isIdentifier(node)) {
      const renamed = renameMap.get(node.text);
      if (renamed !== undefined) {
        return typescript.factory.createIdentifier(renamed);
      }
    }
    return typescript.visitEachChild(node, visit, typescript.nullTransformationContext);
  }

  const transformed = typescript.visitNode(sourceFile, visit) as typescript.SourceFile;
  // Extract the single expression statement and print it
  const stmt = transformed.statements[0] as typescript.ExpressionStatement;
  return printer.printNode(typescript.EmitHint.Expression, stmt.expression, transformed);
}
```

The `parseExpressionToSourceFile` helper wraps the expression in a minimal source file (e.g. `_ = (<expr>);`) to give TypeScript a parseable context. This pattern already exists in `parseContractExpression` — reuse or extract it.

### 3.3 Fallback for parse failures

If `parseExpressionToSourceFile` fails (e.g. the expression is syntactically invalid), fall back to the current regex behaviour and emit a `warn` message. This prevents a regression for edge cases where the expression can't be parsed but the current regex approach happened to work.

---

## 4. Changes Summary

| File | Change |
|---|---|
| `src/interface-resolver.ts` | Replace regex loop in `renameIdentifiersInExpression` with AST parse → walk → print |
| `src/ast-builder.ts` (or `src/jsdoc-parser.ts`) | Export or expose the expression-to-source-file parsing helper if not already accessible |

No changes to public API signatures. No new exported symbols required.

---

## 5. Testing Plan

- Simple rename: `val → value` in `val > 0` → `value > 0`
- Non-overlapping map: `{ a → x, b → y }` in `a > b` → `x > y`
- **Order-dependence regression:** `{ val → value, value → amount }` in `val > 0` → `value > 0` (not `amount > 0`)
- **Substring safety:** `{ x → y }` in `x_val > 0` → `x_val > 0` (identifier `x_val` is not `x`; no rename)
- No rename for non-identifier tokens: `{ true → false }` in `x === true` — `true` is a keyword, not an identifier; expression unchanged
- Empty rename map → expression returned unchanged
- Complex expression: `a.b > c && d(a)` with `{ a → self }` → `self.b > c && d(self)` (rename inside member access and call)

---

## 6. Out of Scope

- Renaming property access targets (`a.b` where `b` is renamed) — only parameter identifier nodes at the top of the expression scope are renamed.
- Validating that renamed identifiers are valid TypeScript identifiers — the rename map comes from trusted internal code.
- Removing the regex fallback permanently — it serves as a safety net while the AST approach matures.
