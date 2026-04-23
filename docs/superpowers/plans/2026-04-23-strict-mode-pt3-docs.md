# Strict Mode — Part 3: README Documentation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `## Strict mode` section to `README.md` explaining what strict mode does, how to enable it, and the recommended CI workflow.

**Architecture:** Documentation-only change. No source or test files touched.

**Tech Stack:** Markdown

**Depends on:** Nothing — this plan is fully independent and can run in parallel with Part 2.

---

### Task 1: Add the strict mode section to README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read the README around the insertion point**

Open `README.md` and locate the `## Manual assertions` section (around line 323) and the `## Agent Directives` section that follows it (around line 345). The new section will be inserted between them.

- [ ] **Step 2: Insert the `## Strict mode` section**

In `README.md`, find the exact line `## Agent Directives` and insert the following block immediately before it (with a blank line separator after the previous section):

```markdown
## Strict mode

By default the transformer silently recovers from internal errors — a contract expression that triggers a transformer bug is dropped with a warning on `stderr`, and the function is emitted unmodified. This means you can ship code you believe is protected by contracts that are in fact absent.

`strict: true` promotes internal transformer errors to compile-level failures. The build fails with a message naming the affected function and telling the developer how to suppress the error:

```
[axiom] Internal error rewriting 'cap': Unsupported expression node kind: ArrayLiteralExpression.
Contracts were NOT injected. Set strict: false to suppress.
```

Enable it in your dev tsconfig plugins entry:

```json
// tsconfig.dev.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "plugins": [{
      "transform": "@fultslop/axiom/dist/src/transformer",
      "strict": true
    }]
  }
}
```

**Recommendation:** enable `strict: true` in CI so the build fails loudly if a transformer bug affects a contract. Disable it locally (`strict: false`, the default) if a known bug is blocking development while a fix is in progress.

```

- [ ] **Step 3: Verify the README renders correctly**

Open `README.md` and confirm:
- The `## Strict mode` heading appears between `## Manual assertions` and `## Agent Directives`
- The code blocks are closed correctly (no runaway fenced blocks)
- The error message example is inside a plain triple-backtick block (no language specifier)

- [ ] **Step 4: Run lint to confirm no issues**

Run: `npm run lint`
Expected: PASS (ESLint does not lint Markdown files, so this just confirms nothing unexpected changed)

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: add strict mode section to README"
```
