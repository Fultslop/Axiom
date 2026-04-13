# NPM Public Pre-release Prep — Design

**Date:** 2026-04-13
**Version target:** `0.9.0-alpha.1`
**Scope:** Option C — full launch prep for public npm pre-release

---

## Goal

Publish `@fultslop/axiom` to the public npm registry as a pre-release (`0.9.0-alpha.1`). The package is functionally complete for the 0.9 alpha feature set. This work makes the npm package page navigable, the repository linkable, and the changelog available before the first public consumer lands.

---

## 1. package.json changes

| Field | Current | New |
|---|---|---|
| `version` | `0.8.12` | `0.9.0-alpha.1` |
| `description` | `"..."` | `"Contract-driven development for TypeScript — @pre, @post, and @invariant JSDoc tags enforced at runtime in dev builds, stripped in release builds."` |
| `author` | `""` | `"Fultslop"` |
| `license` | `"ISC"` | `"MIT"` |
| `keywords` | `[]` | `["typescript", "contracts", "design-by-contract", "transformer", "ts-patch", "compiler-plugin", "preconditions", "postconditions", "invariants", "ai-agents"]` |
| `publishConfig.registry` | `http://localhost:4873` | removed (defaults to public npm) |
| `repository` | missing | `{ "type": "git", "url": "https://github.com/Fultslop/axiom.git" }` |
| `homepage` | missing | `"https://github.com/Fultslop/axiom#readme"` |
| `bugs` | missing | `{ "url": "https://github.com/Fultslop/axiom/issues" }` |

---

## 2. README.md changes

### 2a. Badges
Add below the `# FS-Axiom` heading:

```markdown
[![npm](https://img.shields.io/npm/v/@fultslop/axiom)](https://www.npmjs.com/package/@fultslop/axiom)
[![license](https://img.shields.io/npm/l/@fultslop/axiom)](LICENSE)
```

### 2b. Installation section
Replace the current Verdaccio walkthrough with a standard npm install block:

```markdown
## Installation

```bash
npm install @fultslop/axiom
```

Install `ts-patch` and patch TypeScript:

```bash
npm install --save-dev ts-patch
npx ts-patch install
```
```

The Verdaccio instructions move to a new `## Local development` section at the bottom of the README (for contributors). No content is removed — only relocated.

---

## 3. CHANGELOG.md

New file at repo root. Format: [Keep a Changelog](https://keepachangelog.com).

```markdown
# Changelog

## [0.9.0-alpha.1] - 2026-04-13

### Added
- `@pre`, `@post`, `@invariant`, `@prev` JSDoc contract tags enforced at runtime in dev builds
- Interface contract inheritance — contracts on interfaces propagate to all implementing classes
- Class invariants via `@invariant` — checked after constructor and every public method exit
- `@prev` three-tier syntax: auto shallow clone, `@prev deep`, or custom expression
- `ContractError` base class with `ContractViolationError` and `InvariantViolationError` subtypes
- Manual assertion functions `pre()` and `post()` for cases the transformer cannot reach
- `snapshot()` and `deepSnapshot()` runtime utilities
- Template literal support in contract expressions
- Enum and module-level constant resolution via TypeChecker scope analysis
- Parameter name mismatch handling between interface and class signatures
- Additive merge when both interface and class define contracts for the same method
- Destructured parameter binding recognition
- Union-typed parameter support (`T | null`, `T | undefined`)
- Zero contract overhead in release builds — plain `tsc` strips all contract code
```

---

## Out of scope

- No changes to source code or tests
- No CONTRIBUTING.md (deferred to 0.9 stable)
- No `.npmignore` changes — `"files": ["dist"]` is already correct
