# Release Contracts — Design Doc

**Date:** 2026-04-13
**Issue:** #19 — Hard compile contracts into release builds

---

## 1. Problem

Axiom's zero-overhead guarantee is implemented by relying on the transformer being present in the build pipeline: contracts are injected as runtime checks only when `tspc` (ts-patch) is active. A plain `tsc` build strips all JSDoc annotations and emits no contract code. This is the correct default for application authors who want zero overhead in production.

Library authors face a different situation. A library cannot control the build pipeline of its callers. If a consuming application compiles without the transformer, all contracts on the library's public API are silently absent in production. This defeats the purpose of writing contracts on a library's public surface — misuse by callers goes undetected at runtime.

The request is an opt-in mechanism that makes contracts survive in the compiled output regardless of whether the transformer is active in the consumer's pipeline. The library author enables this for their own build; the resulting `.js` output already contains the checks, so consumers run them unconditionally.

---

## 2. Goals

1. Add a `keepContracts` option to `TransformerOptions` that, when active, causes contract checks to be emitted as plain unconditional runtime code rather than as dev-only injections.
2. Support granular selection by contract kind (`'pre'`, `'post'`, `'invariant'`, `'all'`).
3. Document a `tsconfig.release-with-contracts.json` pattern that library authors can use as a drop-in release build configuration.
4. (Stretch) Support a `// @axiom keepContracts` file-level comment directive that enables `keepContracts` for a single file even when the global option is `false`.

---

## 3. Non-Goals

- Changing the default behaviour. The absence of `keepContracts` (or `keepContracts: false`) must produce identical output to today.
- Any runtime toggle or environment-variable gating on the emitted checks. When `keepContracts` is active the checks are unconditional; there is no `process.env.NODE_ENV` guard.
- Stripping contracts from the output of a consumer who does not use the transformer. The mechanism only applies to builds where the transformer is configured.
- Changing how contracts work when the transformer is not in the pipeline at all. This option only affects what the transformer emits; it does not inject a separate runtime loader.
- Supporting `keepContracts` on a per-function or per-class granularity (that is a future concern).

---

## 4. Approach

### 4.1 Option Shape

`keepContracts` is added to the existing anonymous options object accepted by `createTransformer`:

```typescript
export default function createTransformer(
  _program?: typescript.Program,
  options?: {
    warn?: (msg: string) => void;
    interfaceParamMismatch?: 'rename' | 'ignore';
    allowIdentifiers?: string[];
    keepContracts?: boolean | 'pre' | 'post' | 'invariant' | 'all';
  },
): typescript.TransformerFactory<typescript.SourceFile>
```

Value semantics:

| Value | Behaviour |
|---|---|
| `false` (default, including omitted) | Current behaviour — contracts are injected only while the transformer is active in the pipeline; they vanish in a plain `tsc` build. |
| `true` or `'all'` | All contract kinds (`@pre`, `@post`, `@invariant`) are emitted as unconditional checks. |
| `'pre'` | Only `@pre` checks are kept unconditionally; `@post` and `@invariant` behave as today. |
| `'post'` | Only `@post` checks (and the `prev`/`result` scaffolding they require) are kept unconditionally. |
| `'invariant'` | Only `@invariant` checks are kept unconditionally. |

`true` is treated as an alias for `'all'` at the point of option normalisation, so the rest of the implementation works only with `false | 'pre' | 'post' | 'invariant' | 'all'`.

### 4.2 How It Works

The transformer already injects checks unconditionally — there is no `if (isDev)` wrapper in the emitted code today. The difference between dev and release builds is entirely structural: the transformer is included in the dev-build pipeline and absent from the release pipeline.

When `keepContracts` is active, the emitted checks are identical in structure to the existing dev-build output. No new runtime wrapper or guard is needed. The only semantic change is that the library author's release pipeline also includes the transformer (configured with `keepContracts`), so the compiled `.js` files already contain the checks. Those files are what gets published to npm.

Internally `keepContracts` is resolved in `createTransformer` into a normalised value and threaded down to `visitNode` alongside the existing options. The `visitNode` and `tryRewriteFunction`/`tryRewriteClass` call sites do not change structurally — `keepContracts` is used only to filter which contract kinds are emitted when building the guarded statement list in `buildGuardedStatements`.

Specifically, when `keepContracts` is not `false`, `buildGuardedStatements` suppresses only the contract kinds that are not selected:

- If `keepContracts` is `'pre'`, post tags and invariant calls are omitted from the guarded output for that build (the pre checks are emitted as today).
- If `keepContracts` is `'all'`, nothing is suppressed and all checks are emitted as in the current dev build.

Because the transformer always runs when configured, the resulting `.js` output is self-contained. Consumers who use plain `tsc` run the checks that were baked in at library-build time.

### 4.3 Documentation Pattern

The recommended pattern for library authors is a dedicated tsconfig for the published release build:

**`tsconfig.release-with-contracts.json`**
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "plugins": [
      {
        "transform": "fs-axiom/transformer",
        "keepContracts": "all"
      }
    ]
  }
}
```

The library's `package.json` build script invokes `tspc` (ts-patch) with this config:

```json
{
  "scripts": {
    "build": "tspc --project tsconfig.release-with-contracts.json"
  }
}
```

This produces a `dist/` whose emitted JS includes all contract checks. The library is then published normally. Consumers who import the library run the checks whether or not they use the transformer themselves.

The documentation should note:

- This adds a runtime dependency on `fs-axiom`'s contract assertion helper in the published package. The `require('fs-axiom/contracts')` import injected by `buildRequireStatement` must be available to consumers. If the library currently lists `fs-axiom` as a `devDependency`, it must be moved to `dependencies` when using `keepContracts`.
- Contract failures throw at runtime in production. Authors should decide whether `keepContracts` is appropriate for their error-handling strategy, or whether a custom `warn` callback that logs rather than throws would be preferable.

### 4.4 File-Level Directive (Stretch Goal)

A `// @axiom keepContracts` comment on the first line of a source file enables `keepContracts: 'all'` for that file, overriding the global option for the duration of that file's transformation.

Detection is performed in the transformer's per-file visitor before the node walk begins, by inspecting the leading trivia of the first statement in the `SourceFile` for a line comment matching `@axiom keepContracts`. An optional contract kind qualifier is also accepted:

```typescript
// @axiom keepContracts pre
// @axiom keepContracts post
// @axiom keepContracts invariant
// @axiom keepContracts all
```

When the directive is present, the effective `keepContracts` value for that file is the directive's value (or `'all'` when no qualifier is given), regardless of the value passed in `options`. This allows a monorepo or multi-module library to opt individual files in without touching the transformer configuration.

The file-level directive is read-only during transformation and has no effect on the emitted source beyond changing which contract kinds are kept. It is not stripped from the output; it remains as a comment.

---

## 5. Changes Summary

| File | Change |
|---|---|
| `src/transformer.ts` | Add `keepContracts` to the options object. Normalise `true` → `'all'`. Thread the resolved value through `visitNode`. |
| `src/transformer.ts` | (Stretch) Before the node walk, scan the leading trivia of the source file for a `// @axiom keepContracts` directive and override the per-file effective `keepContracts` value. |
| `src/function-rewriter.ts` | Accept a `keepContracts` parameter in `tryRewriteFunction` / `rewriteFunction`. Pass it to `buildGuardedStatements`. |
| `src/function-rewriter.ts` | In `buildGuardedStatements`, filter `preTags`, `postTags`, and `invariantCall` based on the resolved `keepContracts` value before building the statement list. |
| `src/class-rewriter.ts` | Thread `keepContracts` through to the per-method rewrite calls that delegate to `tryRewriteFunction`. |
| `doc/` | Add documentation for the `keepContracts` option and the `tsconfig.release-with-contracts.json` pattern. |

No changes are required to `ast-builder.ts`, `contract-validator.ts`, `jsdoc-parser.ts`, `interface-resolver.ts`, or `require-injection.ts`.

---

## 6. Testing Plan

### `test/transformer.test.ts` (additions)

- `keepContracts: false` (default): output is identical to the current behaviour — no change to existing tests.
- `keepContracts: true` / `keepContracts: 'all'`: a function with `@pre` and `@post` tags produces both checks in the output; treated the same as `'all'`.
- `keepContracts: 'pre'`: a function with `@pre` and `@post` tags produces only the `@pre` check; the body-capture scaffolding and `@post` check are absent.
- `keepContracts: 'post'`: a function with `@pre` and `@post` tags produces only the `@post` check (and its `prev`/result scaffolding); the `@pre` check is absent.
- `keepContracts: 'invariant'`: a class method with `@pre` and `@invariant` produces only the invariant call; the `@pre` check is absent.
- `keepContracts: 'all'` applied to a function with no contract tags: no output change (existing short-circuit path is unaffected).
- Verify that when `keepContracts` is active the `require('fs-axiom/contracts')` import is still injected (i.e., `transformed.value` is set correctly).

### `test/transformer.test.ts` — file-level directive (stretch)

- A file with `// @axiom keepContracts` and global `keepContracts: false` produces both pre and post checks (directive overrides global).
- A file with `// @axiom keepContracts pre` and global `keepContracts: false` produces only pre checks.
- A file without the directive and global `keepContracts: false` produces no checks (existing behaviour).
- The directive on a non-first line is ignored (no effect).

### Integration

- Compile a small fixture library with `tsconfig.release-with-contracts.json` (using `keepContracts: 'all'`) and verify the emitted `.js` contains the contract assertions without any `if (isDev)` guard.
- Verify the emitted file includes the `require('fs-axiom/contracts')` import.

---

## 7. Out of Scope

- Per-function or per-class granularity (e.g., a JSDoc tag `@keepContracts` on individual methods). This is a natural follow-on but is not needed for the library-author use case.
- A runtime opt-out mechanism (e.g., `AXIOM_DISABLE=1` environment variable) for consumers of a library that ships with baked-in contracts. That would be a separate runtime feature.
- Changing the assertion behaviour (throw vs. warn) under `keepContracts`. The existing throw-on-violation semantics apply. If authors want softer semantics, the `warn` callback injection covers that need.
- Conditional contract execution based on `process.env.NODE_ENV`. Any such guard is the author's responsibility at the call site; the transformer does not emit environment guards.
- Source-map or diagnostic changes specific to `keepContracts` mode. The existing source-map behaviour (position of injected nodes) is unchanged.
