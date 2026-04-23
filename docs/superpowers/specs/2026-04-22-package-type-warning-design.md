# CJS/ESM `package.json` Type Mismatch Warning — Design Doc

**Date:** 2026-04-22
**Covers:** Spec 004 finding #12 — `package.json` declares `"type": "commonjs"` but `tsconfig.json` uses `"module": "node16"` (Low)

---

## 1. Problem

The project's `package.json` sets `"type": "commonjs"` while `tsconfig.json` uses `"module": "node16"`. This works for the library itself because `"type": "commonjs"` causes tsc to emit CJS `require()` for Node16 module kind. However, the README instructs users to set `"type": "module"` in their own `package.json`. A user who copies the tsconfig settings without also setting `"type": "module"` will get CJS output with ESM `import` declarations that crash at runtime — with no helpful error message from the transformer.

---

## 2. Goals

- README is updated with a clear "Troubleshooting" entry explaining the `"type": "module"` requirement and the failure mode (`require is not defined in ES module scope`).
- The transformer optionally emits a startup warning when `moduleKind` is an ESM target but the package's `type` field indicates CJS (or vice versa). This is a best-effort check — the transformer may not have access to `package.json` at compile time.
- The project's own `tsconfig.json`/`package.json` mismatch is acknowledged in comments.

---

## 3. Approach

### 3.1 README troubleshooting section

Add a `## Troubleshooting` section (or append to an existing one):

```markdown
### `require is not defined in ES module scope`

Your `package.json` must declare `"type": "module"` for ESM output. Axiom
transforms your contracts using ESM `import` syntax when `module` is set to
`ESNext`, `Node16`, or `NodeNext` in your `tsconfig.json`. If `"type"` is
missing or set to `"commonjs"`, Node.js treats the output as CJS and the
generated `import` statements cause a runtime crash.

**Fix:** Add `"type": "module"` to your `package.json`.

**Why the library itself uses `"type": "commonjs"`:** The library is compiled
to CJS for broad compatibility. Consumer projects using the transformer should
use ESM (`"type": "module"`).
```

### 3.2 Startup warning in the transformer (best-effort)

The transformer has access to `compilerOptions.module`. If `isEsm` is true (from spec `2026-04-22-esm-exports-prefix-design.md`) and the transformer can resolve the host `package.json` via `ts.sys.readFile`, read the `type` field and warn if it is `"commonjs"` or absent.

This check is opportunistic — if `package.json` cannot be found or read, no warning is emitted. It fires at most once per transformation session.

```typescript
const pkgJson = readHostPackageJson(ctx.program);
if (pkgJson && ctx.isEsm && pkgJson.type !== 'module') {
  ctx.warn(
    '[axiom] Warning: moduleKind is ESM but package.json "type" is not "module". ' +
    'Generated import statements may fail at runtime. See README § Troubleshooting.'
  );
}
```

---

## 4. Changes Summary

| File | Change |
|---|---|
| `README.md` | Add troubleshooting entry for `"type": "module"` requirement |
| `src/transformer.ts` | Add best-effort `package.json` type check; emit one-shot warning when ESM + non-module package type detected |

---

## 5. Testing Plan

- Transformer with `module: ESNext` and a mock `package.json` with `"type": "commonjs"` → warning emitted
- Transformer with `module: ESNext` and `"type": "module"` → no warning
- Transformer with `module: CommonJS` → no warning (CJS/CJS is consistent)
- `package.json` not found → no warning (graceful fallback)

---

## 6. Out of Scope

- Automatically fixing the user's `package.json` — detection and documentation only.
- Enforcing the constraint as a hard error — warning only.
- Splitting the project's own `tsconfig.json` into base + variants (covered in spec `2026-04-22-isolated-modules-warning-design.md` as an optional step).
