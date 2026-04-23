# Remove `console` from Contract Identifier Whitelist — Design Doc

**Date:** 2026-04-22
**Covers:** Spec 004 finding #8 — `console` in `GLOBAL_IDENTIFIERS` whitelist is a security hole (Medium)

---

## 1. Problem

`contract-validator.ts` includes `'console'` in the `GLOBAL_IDENTIFIERS` whitelist. This allows contract expressions like `@pre console.log(secret)`. Contracts are supposed to be pure boolean predicates; permitting `console` lets them:
- Log sensitive data (parameter values, state) on every call
- Be exploited if a user mistakenly puts a side-effecting expression in a contract
- Contradict the project's own ESLint rule that bans `console` usage

---

## 2. Goals

- `'console'` is removed from `GLOBAL_IDENTIFIERS` in `contract-validator.ts`.
- The validator emits an "unknown identifier" warning when `console` appears in a contract expression (same warning path as other unlisted identifiers).
- Users who genuinely need `console` (debugging, custom logging) can add it via the `allowIdentifiers` option.
- No other global identifiers are added or removed.

---

## 3. Approach

### 3.1 Remove from `GLOBAL_IDENTIFIERS`

**Location:** `src/contract-validator.ts`.

Delete `'console'` from the `GLOBAL_IDENTIFIERS` set (or array). The set likely contains globals like `Math`, `Object`, `Array`, `undefined`, `null`, `NaN`, `Infinity`, etc.

### 3.2 Validator warning path

The existing unknown-identifier warning path will automatically fire when `console` appears in a validated contract expression. No new code is needed.

### 3.3 `allowIdentifiers` documentation

Add a note to the README (plugin config section) that `console` was removed from the default whitelist and can be restored via:
```json
{ "transform": "axiom", "allowIdentifiers": ["console"] }
```

---

## 4. Changes Summary

| File | Change |
|---|---|
| `src/contract-validator.ts` | Remove `'console'` from `GLOBAL_IDENTIFIERS` |
| `README.md` | Note the removal and how to restore via `allowIdentifiers` |

---

## 5. Testing Plan

- Contract expression `@pre console.log(x)` → verify validator emits "unknown identifier: console" warning
- Contract expression `@pre x > 0` → no change, no warning about `console`
- Contract expression `@pre Math.max(x, 0) > 0` → no change (`Math` remains whitelisted)
- With `allowIdentifiers: ['console']` → `@pre console.log(x)` → no warning (user opted in)

---

## 6. Out of Scope

- Removing other potentially side-effecting globals (e.g. `Math` has no side effects but `Object.assign` does) — only `console` is addressed here.
- Validating that contract expressions are pure predicates beyond identifier whitelisting — deeper purity analysis is a future concern.
- Changing the `allowIdentifiers` option shape — it already exists.
