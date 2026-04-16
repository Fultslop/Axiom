# Arrow Functions and Function Expressions — Plan Index

**Goal:** Extend the transformer so that `@pre`/`@post` tags on exported `const` arrow functions
and function expressions are recognised, validated, and injected — matching the behaviour already
in place for `FunctionDeclaration` and `MethodDeclaration`.

This plan is split into 6 sequential task files. Run them in order; each task assumes the
previous one is complete.

---

## Task files

| Step | File | What it does |
|---|---|---|
| 1 | [task1-node-helpers](2026-04-13-arrow-functions-task1-node-helpers.md) | Add `isExportedVariableInitialiser` and extend `buildLocationName` in `src/node-helpers.ts` |
| 2 | [task2-jsdoc-parser](2026-04-13-arrow-functions-task2-jsdoc-parser.md) | Add JSDoc fallback `extractContractTagsForFunctionLike` in `src/jsdoc-parser.ts` |
| 3 | [task3-function-rewriter](2026-04-13-arrow-functions-task3-function-rewriter.md) | Add `normaliseArrowBody` and extend `applyNewBody` in `src/function-rewriter.ts`; write failing tests |
| 4 | [task4-transformer](2026-04-13-arrow-functions-task4-transformer.md) | Wire `VariableStatement` branch in `src/transformer.ts` — makes Task 3 tests pass |
| 5 | [task5-location-string](2026-04-13-arrow-functions-task5-location-string.md) | Assert `ContractError` message uses variable name, not `"anonymous"` |
| 6 | [task6-remaining-cases](2026-04-13-arrow-functions-task6-remaining-cases.md) | Full edge-case test coverage + acceptance checklist |

---

## Architecture summary

Five files change across all tasks:

| File | Change |
|---|---|
| `src/transformer.ts` | Add `VariableStatement` branch in `visitNode` (Task 4) |
| `src/function-rewriter.ts` | Export `normaliseArrowBody`; extend `applyNewBody` (Task 3) |
| `src/node-helpers.ts` | Extend `buildLocationName`; add `isExportedVariableInitialiser` (Task 1) |
| `src/jsdoc-parser.ts` | Add `extractContractTagsForFunctionLike`; update `extractContractTags` (Task 2) |
| `test/transformer.test.ts` | New `describe` blocks added across Tasks 3, 5, and 6 |

No changes are needed in `src/reparsed-index.ts`, `src/ast-builder.ts`,
`src/contract-validator.ts`, or `src/type-helpers.ts`.

---

## ESLint constraints (shared across all tasks)

- `id-length: min 3` — no identifiers shorter than 3 characters.
- `complexity: 10` — keep functions small; extract helpers.
- `max-len: 100` — lines under 100 chars.
- No `console` — use the injectable `warn` callback.
