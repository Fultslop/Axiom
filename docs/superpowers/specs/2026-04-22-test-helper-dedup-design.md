# Deduplicate Test Helper Functions — Design Doc

**Date:** 2026-04-22
**Covers:** Spec 004 finding #9 — Duplicated `transformWithProgram` helpers across test files (Medium)

---

## 1. Problem

Three test files each define their own full-program transform helper instead of importing from `test/helpers.ts`:

- `test/bug-repro.test.ts` — defines `fullProgramMode`
- `test/property-chain-runtime.test.ts` — defines `transformWithProgram`
- `test/acceptance.test.ts` — defines `compileWithTransformer`

All three are functionally equivalent to `transformWithProgram` in `test/helpers.ts`. Drift risk: if the canonical helper is updated (e.g. to support `keepContracts` or the new `strict` option), the copies silently don't get the fix.

Additionally, `test/bug-repro.test.ts` contains leftover `console.log()` debug output.

---

## 2. Goals

- All three test files import `transformWithProgram` from `test/helpers.ts`.
- `transformWithProgram` in `test/helpers.ts` accepts the full `TransformOptions` type (not just `warn` and `mismatchMode`), so future options automatically propagate to all tests.
- The three duplicate helpers are deleted.
- `console.log` statements in `test/bug-repro.test.ts` are removed.
- All existing tests continue to pass.

---

## 3. Approach

### 3.1 Extend `transformWithProgram` in `test/helpers.ts`

Current signature (approximate):
```typescript
function transformWithProgram(
  source: string,
  options?: { warn?: (msg: string) => void; mismatchMode?: MismatchMode }
): string
```

New signature:
```typescript
function transformWithProgram(
  source: string,
  options?: TransformOptions
): string
```

`TransformOptions` is a superset of the previous options object, so this is backwards-compatible for callers that already pass `warn` or `mismatchMode`.

### 3.2 Delete duplicate helpers

In each of the three test files:
1. Delete the local helper function definition.
2. Add `import { transformWithProgram } from './helpers.js'` (or the existing import path convention used in the file).
3. Update call sites to use the imported helper. Adapt any call-site differences (argument shape, return value handling) to match `helpers.ts`'s signature.

### 3.3 Remove `console.log` from `bug-repro.test.ts`

Remove or replace with assertions any `console.log` calls that were left in after debugging. If the log output was used to inspect the transformer result, replace with `expect(result).toContain(...)` or similar.

---

## 4. Changes Summary

| File | Change |
|---|---|
| `test/helpers.ts` | Expand `transformWithProgram` options to accept full `TransformOptions` |
| `test/bug-repro.test.ts` | Delete `fullProgramMode` helper; import from `helpers.ts`; remove `console.log` calls |
| `test/property-chain-runtime.test.ts` | Delete local `transformWithProgram`; import from `helpers.ts` |
| `test/acceptance.test.ts` | Delete `compileWithTransformer`; import `transformWithProgram` from `helpers.ts`; adapt call sites |

---

## 5. Testing Plan

- `npm test` passes without modification after the refactor
- `npm run lint` passes (no unused imports, no `console` in test files)
- New options passed to `transformWithProgram` (e.g. `strict: true`) flow through to the transformer — verify with one test per new option

---

## 6. Out of Scope

- Consolidating other duplicated test utilities beyond the `transformWithProgram` family.
- Adding new test infrastructure — this is a refactor only.
- Removing the debug tests in `bug-repro.test.ts` entirely — only the `console.log` statements are removed; the test cases themselves are kept.
