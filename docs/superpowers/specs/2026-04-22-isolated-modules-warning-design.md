# `isolatedModules` Compatibility Warning — Design Doc

**Date:** 2026-04-22
**Covers:** Spec 004 finding #2 — `isolatedModules` mismatch is a user footgun (High)

---

## 1. Problem

Interface contract resolution requires full program context (cross-file type information). When the host TypeScript project enables `isolatedModules: true` (common with Vite, esbuild, SWC), this context is unavailable. Interface contracts silently don't propagate — no error, contracts from interfaces are just not injected.

The project's own `tsconfig.json` sets `isolatedModules: true`, and tests pass because `jest.config.ts` overrides it. A user who unknowingly keeps `isolatedModules: true` will be confused when interface contracts don't appear.

---

## 2. Goals

- The transformer emits a `warn`-level message at startup when `isolatedModules: true` is detected in the host `CompilerOptions` **and** the source file being transformed contains interface contract usage.
- The warning message names the specific limitation and links to the README.
- README documents the constraint under a "Known Limitations" section.
- Optional: `tsconfig.json` is split into `tsconfig.base.json` (library source) and a separate config for tests, making the override explicit.

---

## 3. Approach

### 3.1 Warning in the transformer

**Location:** `src/transformer.ts`, transformer factory or `visitSourceFile`.

At transformer startup, check `compilerOptions.isolatedModules`. If true, set a flag on `TransformerContext` so the warning is emitted at most once per transformer invocation (not once per file).

The warning should only fire when an interface contract is actually encountered (a `@pre`/`@post` on a method that resolves to an interface member). This avoids noisy warnings for projects that use `isolatedModules` but don't use interface contracts.

```typescript
if (ctx.compilerOptions.isolatedModules && hasInterfaceContracts) {
  ctx.warn(
    '[axiom] Warning: isolatedModules is enabled. Interface contract inheritance ' +
    'requires full program context and will be silently skipped. ' +
    'See README § Known Limitations.'
  );
}
```

The `hasInterfaceContracts` flag is set to `true` the first time `interface-resolver.ts` finds a contract tag on an interface member during the current transformation pass.

### 3.2 One-shot warning guard

Add a `warnedIsolatedModules: boolean` flag to `TransformerContext` (initialised `false`). Set it to `true` after the first warning is emitted. Check the flag before warning to avoid repeated messages.

### 3.3 README update

Add a "Known Limitations" section (or expand an existing one) with:

```markdown
### `isolatedModules` incompatibility

Interface contract inheritance requires TypeScript's full program type checker.
If your project enables `isolatedModules: true` (Vite, esbuild, SWC), interface
contracts will be silently skipped. The transformer emits a warning when this
combination is detected.

**Workaround:** Set `isolatedModules: false` in the `tsconfig.json` used by
ts-patch / ttypescript.
```

### 3.4 `tsconfig.json` split (optional)

Split into:
- `tsconfig.base.json` — library source settings, no `isolatedModules`
- `tsconfig.json` — extends base, used by the ts-patch build pipeline
- `tsconfig.jest.json` — extends base, overrides as needed for Jest

This makes the test override explicit and prevents users from copying the root `tsconfig.json` and accidentally enabling `isolatedModules`.

---

## 4. Changes Summary

| File | Change |
|---|---|
| `src/types.ts` | Add `warnedIsolatedModules: boolean` to `TransformerContext` |
| `src/transformer.ts` | Check `compilerOptions.isolatedModules` and emit one-shot warning when interface contracts are encountered |
| `src/interface-resolver.ts` | Signal to the transformer context when an interface contract lookup is attempted (set a flag or return a sentinel) |
| `README.md` | Add "Known Limitations / `isolatedModules`" section |
| `tsconfig.json` (optional) | Refactor into `tsconfig.base.json` + `tsconfig.json` + `tsconfig.jest.json` |

---

## 5. Testing Plan

- Transformer invoked with `isolatedModules: true`, source file with interface contract → verify warning emitted containing "isolatedModules"
- Transformer invoked with `isolatedModules: true`, source file with no interface contracts → verify no warning
- Transformer invoked with `isolatedModules: false`, source file with interface contract → verify no warning, contracts injected normally
- Multiple files transformed in one pass with `isolatedModules: true` → warning emitted exactly once (not once per file)

---

## 6. Out of Scope

- Implementing a fallback for interface contract resolution under `isolatedModules` — detection and warning only.
- Enforcing `isolatedModules: false` as a hard error — warning only to preserve backward compatibility.
