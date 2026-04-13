# NPM Public Pre-release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare `@fultslop/axiom` for public npm pre-release as `0.9.0-alpha.1`, with proper metadata, documentation, CI, and a visible roadmap.

**Architecture:** Pure configuration and documentation changes — no source code modifications. Six independent tasks: commit untracked tests, update `package.json`, update `README.md`, create `CHANGELOG.md`, add GitHub Actions CI, and create GitHub Issues for the 0.9 roadmap.

**Tech Stack:** npm, GitHub Actions, gh CLI (for issue creation)

---

### Task 1: Commit the two untracked test files

**Files:**
- Modify (stage): `test/bug-repro.test.ts`
- Modify (stage): `test/property-chain-runtime.test.ts`

These files exist and pass locally but are not tracked by git. A developer cloning from GitHub would get different test results than the published state.

- [ ] **Step 1: Verify tests pass**

```bash
npm test
```

Expected: all test suites pass, including `bug-repro` and `property-chain-runtime`.

- [ ] **Step 2: Stage and commit**

```bash
git add test/bug-repro.test.ts test/property-chain-runtime.test.ts
git commit -m "test: add bug-repro and property-chain-runtime test suites"
```

Expected: commit succeeds, `git status` shows a clean working tree for these files.

---

### Task 2: Update package.json

**Files:**
- Modify: `package.json`

Apply all metadata changes needed for public npm.

- [ ] **Step 1: Apply all field changes**

Replace the contents of `package.json` with the following (keeping all existing fields not listed below, only changing/adding the ones shown):

```json
{
  "name": "@fultslop/axiom",
  "version": "0.9.0-alpha.1",
  "description": "Contract-driven development for TypeScript — @pre, @post, and @invariant JSDoc tags enforced at runtime in dev builds, stripped in release builds.",
  "author": "Fultslop",
  "license": "MIT",
  "keywords": [
    "typescript",
    "contracts",
    "design-by-contract",
    "transformer",
    "ts-patch",
    "compiler-plugin",
    "preconditions",
    "postconditions",
    "invariants",
    "ai-agents"
  ],
  "repository": {
    "type": "git",
    "url": "https://github.com/Fultslop/axiom.git"
  },
  "homepage": "https://github.com/Fultslop/axiom#readme",
  "bugs": {
    "url": "https://github.com/Fultslop/axiom/issues"
  }
}
```

Remove the `publishConfig` field entirely (it currently points to localhost:4873; removing it defaults to public npm).

- [ ] **Step 2: Verify the file is valid JSON**

```bash
node -e "require('./package.json')" && echo "valid"
```

Expected: `valid`

- [ ] **Step 3: Verify prepublishOnly still runs cleanly**

```bash
npm run typecheck && npm run lint && npm test
```

Expected: all pass with no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: update package metadata for public npm pre-release"
```

---

### Task 3: Update README.md

**Files:**
- Modify: `README.md`

Three changes: fix the version header, add badges, replace the Verdaccio installation section with a standard npm block, and move the Verdaccio content to a new `## Local development` section at the bottom.

- [ ] **Step 1: Fix the version header**

Find line 3:
```markdown
**Version 0.8**
```

Replace with:
```markdown
**Version 0.9 (alpha)**
```

- [ ] **Step 2: Add badges below the version header**

After `**Version 0.9 (alpha)**`, add a blank line then:

```markdown
[![npm](https://img.shields.io/npm/v/@fultslop/axiom)](https://www.npmjs.com/package/@fultslop/axiom)
[![license](https://img.shields.io/npm/l/@fultslop/axiom)](LICENSE)
[![CI](https://github.com/Fultslop/axiom/actions/workflows/ci.yml/badge.svg)](https://github.com/Fultslop/axiom/actions/workflows/ci.yml)
```

Note: the CI badge references the workflow added in Task 5. Add it now so it's in place when CI is created.

- [ ] **Step 3: Replace the Installation section**

Find the `## Installation` section. It currently starts with:
```
Axiom is currently in version 0.8 and not available on npm yet. The recommended installation path for now is to install `Verdaccio` locally, build and publish it there. Then install axiom
```

Replace the entire `## Installation` section (up to and not including `## Testing with Jest`) with:

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

Add the transformer to your dev tsconfig:

```json
// tsconfig.dev.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "plugins": [{ "transform": "@fultslop/axiom/dist/src/transformer" }]
  }
}
```

Add a dev build script to `package.json`:

```json
"build:dev": "tspc -p tsconfig.dev.json"
```
```

- [ ] **Step 4: Add Local development section at the bottom**

Append a new section after the last existing section (`## Agent Directives` or wherever the file ends):

```markdown
## Local development

To build and test axiom locally, or to consume it from another local project before it is published, use [Verdaccio](https://verdaccio.org).

Start Verdaccio (if not running):
```bash
npx verdaccio
```

Log in (first time):
```bash
npm adduser --registry http://localhost:4873
```

Publish locally:
```bash
npm publish --registry http://localhost:4873
```

Consume from another local project:
```bash
npm install @fultslop/axiom --registry http://localhost:4873
```

Or add to the consuming project's `.npmrc`:
```
registry=http://localhost:4873
```
```

- [ ] **Step 5: Verify README renders correctly**

Scan the file visually for any broken markdown fences or dangling content from the original installation section.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: update README for public npm — badges, standard install, local dev section"
```

---

### Task 4: Create CHANGELOG.md

**Files:**
- Create: `CHANGELOG.md`

- [ ] **Step 1: Create the file**

Create `CHANGELOG.md` at the repo root with the following contents:

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: add CHANGELOG for 0.9.0-alpha.1"
```

---

### Task 5: Add GitHub Actions CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the workflow directory and file**

Create `.github/workflows/ci.yml` with the following contents:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Type check
        run: npm run typecheck

      - name: Lint
        run: npm run lint

      - name: Test
        run: npm test
```

- [ ] **Step 2: Verify the YAML is valid**

```bash
node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/ci.yml', 'utf8')); console.log('valid')"
```

Expected: `valid`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions workflow for typecheck, lint, and tests"
```

---

### Task 6: Create GitHub Issues for the 0.9 roadmap

**Files:**
- No files modified — GitHub Issues created via `gh` CLI

This makes the roadmap visible to developers tracking the project. Each item from the README's "Not yet in scope" section becomes a labelled issue in a `0.9.0` milestone.

- [ ] **Step 1: Create the 0.9.0 milestone**

```bash
gh api repos/Fultslop/axiom/milestones \
  --method POST \
  --field title="0.9.0" \
  --field description="Features required before leaving alpha" \
  --field due_on="2026-12-31T00:00:00Z"
```

Expected: JSON response with `"number": 1` (or similar).

Note the milestone number from the response — you'll need it in the next steps. If it's not 1, replace `1` in the commands below with the actual number.

- [ ] **Step 2: Create issue — arrow functions and function expressions**

```bash
gh issue create \
  --title "feat: support @pre/@post on arrow functions and function expressions" \
  --body "Arrow functions and function expressions are not currently instrumented by the transformer. This is the most commonly hit gap in real codebases." \
  --label "enhancement" \
  --milestone 1
```

- [ ] **Step 3: Create issue — async functions and generators**

```bash
gh issue create \
  --title "feat: support @pre/@post on async functions and generators" \
  --body "async functions and generator functions are not currently instrumented. @post semantics for async need to handle the resolved value, not the Promise." \
  --label "enhancement" \
  --milestone 1
```

- [ ] **Step 4: Create issue — constructor contracts**

```bash
gh issue create \
  --title "feat: support @pre/@post on constructors" \
  --body "Constructor contracts are currently not supported. @invariant is checked after the constructor exits, but @pre/@post cannot be placed on constructors directly." \
  --label "enhancement" \
  --milestone 1
```

- [ ] **Step 5: Create issue — class-to-class contract inheritance**

```bash
gh issue create \
  --title "feat: support contract inheritance from base classes" \
  --body "Interface contracts are propagated to implementing classes. Base class contracts are not currently inherited by subclasses. Implementing this would complete the inheritance story." \
  --label "enhancement" \
  --milestone 1
```

- [ ] **Step 6: Verify all issues were created**

```bash
gh issue list --milestone 1
```

Expected: 4 issues listed, all open, all on milestone `0.9.0`.

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| `publishConfig` removed | Task 2 |
| `license` fixed ISC → MIT | Task 2 |
| `author` filled | Task 2 |
| `description` filled | Task 2 |
| `keywords` added | Task 2 |
| `repository` / `homepage` / `bugs` added | Task 2 |
| Version bumped to `0.9.0-alpha.1` | Task 2 |
| Badges added to README | Task 3 |
| Installation section updated | Task 3 |
| README version header updated | Task 3 |
| Verdaccio content moved to Local development section | Task 3 |
| CHANGELOG created | Task 4 |
| CI workflow added | Task 5 |
| Untracked test files committed | Task 1 |
| GitHub Issues roadmap created | Task 6 |

All spec requirements covered. No gaps.

**Placeholder scan:** No TBDs, no "implement later", no missing code. The `gh` CLI commands in Task 6 include a note about the milestone number in case it differs from 1 — that covers the only runtime-dependent value.

**Type consistency:** N/A — no TypeScript code changes in this plan.
