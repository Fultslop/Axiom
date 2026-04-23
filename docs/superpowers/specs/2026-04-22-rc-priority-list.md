# RC Blocker Priority List

**Date:** 2026-04-22
**Source:** Spec 004 — Code Review Findings (`docs/spec/004.code-review-findings.spec.md`)
**Branch:** `chore_RC_001_clean_up` (to be addressed after merge)

Each entry: priority, plan file, severity, suggested git commit message.

---

## Critical — must fix before RC

1. [in progress] `2026-04-22-esm-exports-prefix-design.md` — **Critical** — `fix: emit bare identifiers in contract expressions for ESM module targets`
2. `2026-04-22-strict-mode-design.md` — **Critical** — `feat: add strict mode to throw on internal transformer errors instead of silently dropping contracts`

---

## High — should fix before RC

3. `2026-04-22-interface-rename-ast-design.md` — **High** — `fix: replace regex identifier rename in interface resolver with AST walk to eliminate order dependence`
4. `2026-04-22-reparsed-index-key-design.md` — **High** — `fix: use getStart()+kind composite key in reparsed index to prevent position collisions`
5. `2026-04-22-isolated-modules-warning-design.md` — **High** — `feat: warn when isolatedModules is enabled and interface contracts are present`

---

## Medium — fix before 1.0, not RC blocker

6. `2026-04-22-test-helper-dedup-design.md` — **Medium** — `refactor: consolidate transformWithProgram helpers into test/helpers.ts`
7. `2026-04-22-console-whitelist-removal-design.md` — **Medium** — `fix: remove console from contract identifier whitelist`
8. `2026-04-22-snapshot-test-coverage-design.md` — **Medium** — `test: add snapshot() and deepSnapshot() unit tests including JSON fallback path`
9. `2026-04-22-coverage-threshold-design.md` — **Medium** — `test: raise branch coverage threshold to 95% and cover identified gaps` *(depends on #8)*
10. `2026-04-22-snapshot-shallow-design.md` — **Medium** — `feat: warn when snapshot() is called on objects with getter properties`

---

## Low — polish / documentation

11. `2026-04-22-deep-snapshot-warning-design.md` — **Low** — `feat: emit warning when deepSnapshot falls back to JSON clone`
12. `2026-04-22-unexported-function-warning-design.md` — **Low** — `fix: warn when @pre/@post appears on non-exported function declaration`
13. `2026-04-22-package-type-warning-design.md` — **Low** — `docs: add troubleshooting entry for package.json type: module requirement`

---

## Backlog (existing todo.md items, carried forward)

14. `2026-04-13-liskov-contracts-design.md` — Liskov-aware contracts: enforce subclass does not strengthen preconditions or weaken postconditions *(depends on class inheritance)*
15. Hard-compile option: retain `@pre`/`@post`/`@invariant` in release builds per-module *(see `release-contracts-design.md` — may already be partially covered by `keepContracts`)*
16. `2026-04-10-template-literals-design.md` — Template literals in contract expressions *(deferred design)*
17. Multi-level property chains *(deferred design)*
18. Compound conditions / type narrowing beyond `&&` typeof guards *(deferred — see `compound-conditions-design.md`)*
