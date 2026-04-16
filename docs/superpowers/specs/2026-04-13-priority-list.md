# Implementation Priority List

**Date:** 2026-04-13

Each entry: priority, plan file, suggested git commit message.

---

1. [done] `2026-04-13-misuse-detection.md` — `feat: warn on misapplied @pre/@post/@invariant tags`
2. [done] `2026-04-13-optional-chaining.md` — `fix: strip nullability when validating optional chain property access`
3. [done] `2026-04-13-compound-conditions.md` — `feat: typeof guard narrowing in &&-compound contract expressions`
4. [done] `2026-04-13-constructor-contracts.md` — `feat: support @pre/@post contracts on constructors`
5. [in progress] `2026-04-13-release-contracts.md` — `feat: add keepContracts option for release-build contract retention`
[part 5/5 done]
6. `2026-04-13-arrow-functions.md` — `feat: support @pre/@post on exported arrow and function-expression constants`
7. `2026-04-13-async-functions.md` — `fix: await async function body before checking @post result`
8. `2026-04-13-closures.md` — `feat: support @pre/@post on nested and closure functions` *(depends on #6)*
9. `2026-04-13-class-inheritance.md` — `feat: inherit @pre/@post contracts from base classes via extends`
10. `future-liskov-aware-contracts.md` — `feat: heuristic LSP violation detection for subtype @pre constraints` *(depends on #9)*
