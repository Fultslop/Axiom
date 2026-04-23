# Strict Mode for Internal Transformer Errors — Design Doc

**Date:** 2026-04-22
**Covers:** Spec 004 finding #1 — Silent contract dropping on transformer error (Critical)

---

## 1. Problem

`tryRewriteFunction` and `tryRewriteClass` in `src/transformer.ts` catch internal errors and return the original, unmodified node. A `@pre` or `@post` tag that triggers a transformer bug is silently dropped — no compile failure, no visible indication. The user ships code they believe is protected by contracts that are not there.

---

## 2. Goals

- A `strict: true` plugin option causes the transformer to throw (compile-level error) on internal transformer errors instead of recovering silently.
- The default remains `strict: false` to avoid breaking existing users.
- The `strict` option flows through `TransformOptions` / `TransformerContext` with no new plumbing beyond what already exists for `warn`.
- `strict: true` is documented as the recommended CI setting.
- No change to the permissive path — `warn` + return-original behaviour is unchanged when `strict: false`.

---

## 3. Approach

### 3.1 `TransformOptions` and `TransformerContext`

**Location:** `src/transformer.ts` (or wherever `TransformOptions` is declared, likely `src/types.ts`).

Add `strict?: boolean` to `TransformOptions`. Default: `false`. Thread it through `TransformerContext` as `strict: boolean` (resolved to `false` if omitted from options).

### 3.2 `tryRewriteFunction` and `tryRewriteClass`

Both functions have a `catch (err)` block that calls `ctx.warn(...)` and returns the original node.

Change the catch block to:

```typescript
catch (err) {
  if (ctx.strict) {
    throw new Error(
      `[axiom] Internal error rewriting '${fnName}': ${String(err)}. ` +
      `Contracts were NOT injected. Set strict: false to suppress.`
    );
  }
  ctx.warn(`[axiom] Internal error rewriting '${fnName}': ${String(err)}. Contracts were not injected.`);
  return node;
}
```

The function/class name for the error message can be extracted from the node using the same pattern already used in `warn` calls: `node.name?.text ?? '(anonymous)'`.

### 3.3 Plugin config wiring

The transformer plugin entry point reads `TransformOptions` from the TypeScript plugin config object (the `config` parameter in `ts-patch` / `ttypescript` plugin factories). The `strict` field should be read there and passed into the context, alongside the existing `warn` and `keepContracts` options.

### 3.4 Documentation

Add a `## Strict mode` section to the README explaining:
- What strict mode does
- How to enable it: `{ "transform": "axiom", "strict": true }` in `tsconfig.json` plugins
- Recommendation: enable in CI, disable locally if a transformer bug blocks development

---

## 4. Changes Summary

| File | Change |
|---|---|
| `src/types.ts` (or wherever `TransformOptions` lives) | Add `strict?: boolean` to `TransformOptions` and `strict: boolean` to `TransformerContext` |
| `src/transformer.ts` | Thread `strict` into `TransformerContext`; update `tryRewriteFunction` and `tryRewriteClass` catch blocks to throw when `ctx.strict` is true |
| `README.md` | Add strict mode documentation |

---

## 5. Testing Plan

- `strict: true` + a deliberately-broken contract expression that triggers an internal error → verify a `ContractTransformError` (or plain `Error`) is thrown with a message containing the function name and "strict: false to suppress"
- `strict: false` (default) + same broken expression → verify `warn` is called and the original node is returned (no throw)
- `strict: true` + a valid contract expression → verify normal contract injection (no throw, no warning)
- Verify the `strict` option round-trips through the plugin config (read from `tsconfig.json` plugins array config object)

---

## 6. Out of Scope

- Strict mode for validator errors (contract expression parse failures) — those already emit warnings; applying strict mode to them is a separate decision.
- Per-file or per-function granularity for strict mode — global plugin-level flag only.
- Structured error types (custom `ContractTransformError` class) — a plain `Error` is sufficient for now.
