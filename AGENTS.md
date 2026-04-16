# Agent Context — fsprepost (axiom)

TypeScript compiler transformer that injects `@pre`/`@post`/`@invariant` runtime contract checks
into dev builds. Zero overhead in release builds (plain `tsc` ignores JSDoc).

## Commands

| Command | Purpose |
|---|---|
| `npm test` | Run Jest (all tests must pass before any commit) |
| `npm run lint` | ESLint — must be clean |
| `npm run typecheck` | tsc without emit |
| `npm run build` | Compile to `dist/` |

Run `npm test` and `npm run lint` after every change. Never skip them.

## Project Structure

```
src/
  transformer.ts          — entry point; createTransformer() factory, visitNode() traversal
  function-rewriter.ts    — tryRewriteFunction(), rewriteFunction(), buildGuardedStatements()
  class-rewriter.ts       — tryRewriteClass(), #checkInvariants injection
  jsdoc-parser.ts         — extractContractTags() — reads @pre/@post/@invariant/@prev from AST
  contract-validator.ts   — filterValidTags(), identifier scope + type-mismatch checks
  interface-resolver.ts   — cross-file interface contract resolution via TypeChecker
  reparsed-index.ts       — re-parses source text for reliable AST positions
  ast-builder.ts          — low-level TS factory helpers
  index.ts                — public exports (ContractViolationError, pre, post, snapshot, …)
test/
  helpers.ts              — transform(source, optionsOrWarn?) — the canonical test helper
  transformer.*.test.ts   — feature-scoped test suites
  transformer.test.ts     — keepContracts option tests (new)
```

## ESLint Constraints (enforced on `src/**/*.ts`, not tests)

- `id-length: min 3` — no identifiers shorter than 3 chars (exceptions: `id`, `to`, `ok`, `fs`)
- `complexity: 10` — cyclomatic complexity per function; extract helpers to stay under
- `max-len: 100` — hard line length limit
- No raw string literals in `===` / `!==` comparisons — use `const` string constants
- No early naked `return` statements (`return;`) — flow to the end or return a value
- No `console` — not declared in globals; use `warn` callback or `process.stderr.write`
- `curly: all` — always use braces on if/else/for
- `for...of` is fine; prefer array methods (`some`, `find`, `every`) where idiomatic

## Key Patterns

### Adding a new transformer option

1. Add the raw option type to `createTransformer`'s `options` parameter in `src/transformer.ts`
2. Normalise to an internal type at the top of `createTransformer` (before the factory is returned)
3. Thread the normalised value through `visitNode` → `tryRewriteFunction` / `tryRewriteClass`
4. Exported types go in `src/function-rewriter.ts` or `src/class-rewriter.ts`; re-export from `src/index.ts` only if public API

### Test helper signature

```typescript
// test/helpers.ts
transform(source: string, optionsOrWarn?: ((msg: string) => void) | TransformOptions): string
// TransformOptions = { warn?, keepContracts?, … }
```

Existing callers passing a bare `warn` function continue to work — the overload narrows via `typeof`.

### String constants for string union members

All string literal values used in comparisons must be assigned to `const` at the top of the file:

```typescript
const KEEP_ALL = 'all' as const;
// then: if (x === KEEP_ALL) …   — not: if (x === 'all') …
```

### No-rewrite early exit pattern

```typescript
if (shouldSkipRewrite(preTags, postTags, invariantCall)) {
  return null;  // caller (tryRewriteFunction) returns original node
}
```

Return `null` from `rewriteFunction` to signal "no change"; `tryRewriteFunction` maps that to the
original node and leaves `transformed.value` unchanged.

## Architecture Notes

- `tryRewriteFunction` wraps `rewriteFunction` in a try/catch and always returns a node
- `buildGuardedStatements` assembles the replacement body; post/invariant scaffold
  (`buildBodyCapture`, `buildResultReturn`, `buildPrevCapture`) is only emitted when there is at
  least one active post tag or invariant
- Tags pass through two filters: `extractContractTags` (parse) → `filterValidTags` (validate
  identifier scope and types) → active set used in `buildGuardedStatements`
- Interface contracts are resolved in `interface-resolver.ts` only when a TypeChecker is available
  (full program mode); `transpileModule` mode skips cross-file resolution with a warning


