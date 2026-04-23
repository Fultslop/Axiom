# `deepSnapshot` JSON Fallback Warning — Design Doc

**Date:** 2026-04-22
**Covers:** Spec 004 finding #4 — `deepSnapshot` fallback is silently lossy (Low)

---

## 1. Problem

`assertions.ts` falls back to `JSON.parse(JSON.stringify(obj))` when `structuredClone` is unavailable. This silently drops `undefined` values, `Symbol` keys, functions, and throws on circular references. A `@prev` snapshot of an object with `undefined` properties will differ from the original in ways the user does not expect, producing spurious `@post` violations or missed violations.

---

## 2. Goals

- Emit a warning when the JSON fallback path is taken in `deepSnapshot`.
- The warning uses the existing `warn` callback pattern.
- Alternatively, document the Node.js version requirement (`structuredClone` available since Node 17) and restrict the fallback to only Node < 17.
- No change to fallback behaviour — the JSON path is kept as-is; only a warning is added.

---

## 3. Approach

### 3.1 Add `warn` parameter to `deepSnapshot`

`deepSnapshot` currently takes only `obj`. Add an optional second parameter:

```typescript
function deepSnapshot(
  obj: unknown,
  options?: { warn?: (msg: string) => void }
): unknown
```

The `warn` option defaults to `process.stderr.write` (matching the transformer convention).

### 3.2 Emit warning before fallback

In the fallback branch:

```typescript
const warnFn = options?.warn ?? ((msg: string) => process.stderr.write(msg + '\n'));
warnFn(
  '[axiom] Warning: structuredClone is unavailable; deepSnapshot is using the ' +
  'JSON fallback. undefined values, Symbol keys, and circular references will ' +
  'not be captured correctly. Requires Node.js 17+ for structuredClone.'
);
return JSON.parse(JSON.stringify(obj));
```

### 3.3 Transformer injection

When the transformer injects `deepSnapshot` calls for `@prev`, it should pass the `warn` callback from the transformer context. This ensures the warning surfaces via the same channel as all other transformer warnings (configurable by the user via plugin options), not just to stderr.

If the transformer currently injects bare `deepSnapshot(this)`, update the injection to `deepSnapshot(this, { warn: __axiom_warn__ })` where `__axiom_warn__` is the injected warn function reference.

---

## 4. Changes Summary

| File | Change |
|---|---|
| `src/assertions.ts` | Add `options?: { warn?: (msg: string) => void }` to `deepSnapshot`; emit warning before JSON fallback |
| `src/ast-builder.ts` (or wherever `@prev` injection is built) | Pass `warn` callback in the injected `deepSnapshot` call |

---

## 5. Testing Plan

- `deepSnapshot` with `structuredClone` available → no warning emitted
- `deepSnapshot` with `structuredClone` removed from `globalThis` → warning emitted via the `warn` callback containing "JSON fallback"
- Warning is emitted via the provided `warn` callback, not via `console` or `process.stderr` directly
- Transformer-injected `deepSnapshot` call passes the warn callback — verify in emitted code

---

## 6. Out of Scope

- Providing an alternative deep-clone implementation that doesn't have these limitations.
- Polyfilling `structuredClone` — the warning is sufficient; users on Node < 17 should upgrade.
- Detecting specific lossy cases (undefined, Symbol, circular) before they happen — the warning is a blanket notice about the fallback path.
