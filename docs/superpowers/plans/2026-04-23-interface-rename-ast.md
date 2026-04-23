# AST-Based Identifier Rename in Interface Resolver — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the regex-based identifier rename in `renameIdentifiersInExpression` with an AST parse → walk → print approach that is order-independent and structurally correct.

**Architecture:** Add a `renameWithRegex` fallback helper, rewrite `renameIdentifiersInExpression` to parse the expression to a TypeScript SourceFile, walk all `Identifier` nodes using `typescript.visitNode`/`typescript.visitEachChild`, replace matched identifiers from the original rename map (not the output), and print back with `typescript.createPrinter`. Thread a `warn` callback through `renameIdentifiersInExpression`, `applyRenameToTags`, and `buildContractsResult` so the regex fallback (invoked on parse failure) can emit a diagnostic.

**Tech Stack:** TypeScript compiler API (`typescript` package), Jest, existing helpers `buildProgram` / `runResolver` from `test/interface-resolver.test.ts`.

---

## File Map

| File | Change |
|---|---|
| `test/interface-resolver.test.ts` | Add failing regression tests for order-dependence and substring-safety |
| `src/interface-resolver.ts` | Add `renameWithRegex` helper; rewrite `renameIdentifiersInExpression`; add `warn` param to `applyRenameToTags` and `buildContractsResult`; update callers |

No new files. No new exports. No public API signature changes.

---

## Task 1: Write and verify the failing regression test

**Files:**
- Modify: `test/interface-resolver.test.ts` — add a new `describe` block after the existing `resolveInterfaceContracts — @prev inheritance` block

### Background for the implementor

`renameIdentifiersInExpression` (line 70 of `src/interface-resolver.ts`) loops through the rename map entries in insertion order, applying each regex substitution to the _accumulating string result_. If the map contains `{val → value, value → amount}` and the expression is `val > 0`, the first substitution produces `value > 0`, and the second immediately rewrites that to `amount > 0`. The fix (Task 2) replaces this with an AST walk that visits each identifier node in the _original_ AST exactly once.

The test file already has `buildProgram` and `runResolver` helpers. The `runResolver` helper calls `resolveInterfaceContracts`, which ultimately calls `renameIdentifiersInExpression`. Use these helpers to write integration-style tests.

---

- [ ] **Step 1: Read the test file to confirm insertion point**

  Open `test/interface-resolver.test.ts`. Find the closing `});` of the `resolveInterfaceContracts — @prev inheritance` describe block (around line 347). The new describe block goes immediately after it, before the `function runBaseClassResolver` declaration.

- [ ] **Step 2: Add the failing regression tests**

  Append the following describe block to `test/interface-resolver.test.ts` immediately after the closing `});` of `resolveInterfaceContracts — @prev inheritance` and before `function runBaseClassResolver`:

  ```typescript
  describe('renameIdentifiersInExpression — order-independence and correctness', () => {
    it('does not double-rename when the rename map has chained values', () => {
      // Regression: with regex-based rename, {val→value} applied first turns
      // `val > 0` into `value > 0`, then {value→amount} immediately rewrites
      // that to `amount > 0`. The AST approach visits each node in the original
      // tree exactly once, so `val` → `value` and the new `value` node is never
      // revisited.
      const program = buildProgram('test.ts', `
        interface IFoo {
          /** @pre val > 0 */
          bar(val: number, value: number): number;
        }
        class Foo implements IFoo {
          bar(value: number, amount: number): number { return value; }
        }
      `);
      // Rename map built by buildRenameMap: {val → value, value → amount}
      const { contracts, warnings } = runResolver(program, 'test.ts', 'rename');
      const preTag = contracts.methods.get('bar')!.preTags[0]!;
      // `val` should be renamed once to `value`; the resulting `value` must NOT
      // be renamed again to `amount`.
      expect(preTag.expression).toBe('value > 0');
      expect(warnings).toHaveLength(1); // one mismatch warning expected
    });

    it('renames multiple distinct identifiers in one expression', () => {
      const program = buildProgram('test.ts', `
        interface IFoo {
          /** @pre a > b */
          bar(a: number, b: number): number;
        }
        class Foo implements IFoo {
          bar(x: number, y: number): number { return x; }
        }
      `);
      const { contracts } = runResolver(program, 'test.ts', 'rename');
      const preTag = contracts.methods.get('bar')!.preTags[0]!;
      expect(preTag.expression).toBe('x > y');
    });

    it('renames identifier used as object in member access, leaves property name unchanged', () => {
      const program = buildProgram('test.ts', `
        interface IFoo {
          /** @pre a.length > 0 */
          bar(a: string[]): void;
        }
        class Foo implements IFoo {
          bar(items: string[]): void {}
        }
      `);
      const { contracts } = runResolver(program, 'test.ts', 'rename');
      const preTag = contracts.methods.get('bar')!.preTags[0]!;
      expect(preTag.expression).toBe('items.length > 0');
    });

    it('applies chained rename correctly to @prev expression', () => {
      // Same order-dependence scenario, but for prevExpression
      const program = buildProgram('test.ts', `
        interface IFoo {
          /** @prev val @post result > 0 */
          bar(val: number, value: number): number;
        }
        class Foo implements IFoo {
          bar(value: number, amount: number): number { return value; }
        }
      `);
      const { contracts } = runResolver(program, 'test.ts', 'rename');
      const method = contracts.methods.get('bar')!;
      // `val` (the @prev expression) should be renamed once to `value`, not to `amount`
      expect(method.prevExpression).toBe('value');
    });
  });
  ```

- [ ] **Step 3: Run the test suite to verify the new tests fail**

  ```bash
  npm test -- --testPathPattern=interface-resolver --verbose 2>&1 | tail -40
  ```

  Expected output: the four new tests in `renameIdentifiersInExpression — order-independence and correctness` all FAIL. The two "chained rename" tests should show `received: "amount > 0"` vs `expected: "value > 0"` (or similar for prevExpression). The other two may pass already (that is fine — they document correctness, not a regression).

- [ ] **Step 4: Commit the failing tests**

  ```bash
  git add test/interface-resolver.test.ts
  git commit -m "test: add failing regression tests for AST-based identifier rename"
  ```

---

## Task 2: Implement AST-based renameIdentifiersInExpression

**Files:**
- Modify: `src/interface-resolver.ts`

### What to change and where

The current `renameIdentifiersInExpression` is at lines 70–81. It will be replaced. The functions that call it — `applyRenameToTags` (line 155), `buildContractsResult` (line 204), `extractMethodContracts` (line 229), and `extractBaseMethodContracts` (line 293) — all need `warn` threaded through.

---

- [ ] **Step 1: Extract the existing regex logic into a private `renameWithRegex` helper**

  In `src/interface-resolver.ts`, replace the body of `renameIdentifiersInExpression` (lines 70–81) with two functions. First add `renameWithRegex` right before `renameIdentifiersInExpression`:

  ```typescript
  function renameWithRegex(
    expression: string,
    renameMap: Map<string, string>,
  ): string {
    let result = expression;
    for (const [oldName, newName] of renameMap.entries()) {
      const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escaped}\\b`, 'g');
      result = result.replace(regex, newName);
    }
    return result;
  }
  ```

  Then update `renameIdentifiersInExpression` to just call it (keeping the old behaviour for now so nothing breaks yet):

  ```typescript
  function renameIdentifiersInExpression(
    expression: string,
    renameMap: Map<string, string>,
    warn: (msg: string) => void,
  ): string {
    if (renameMap.size === 0) return expression;
    return renameWithRegex(expression, renameMap);
  }
  ```

- [ ] **Step 2: Update `applyRenameToTags` to accept and forward `warn`**

  Replace the current `applyRenameToTags` (lines 155–163):

  ```typescript
  function applyRenameToTags(
    tags: ContractTag[],
    renameMap: Map<string, string>,
    warn: (msg: string) => void,
  ): ContractTag[] {
    return tags.map((tag) => ({
      ...tag,
      expression: renameIdentifiersInExpression(tag.expression, renameMap, warn),
    }));
  }
  ```

- [ ] **Step 3: Update `buildContractsResult` to accept and forward `warn`**

  Replace the current `buildContractsResult` (lines 204–227):

  ```typescript
  function buildContractsResult(
    preTags: ContractTag[],
    postTags: ContractTag[],
    prevExpr: string | undefined,
    renameMap: Map<string, string>,
    hasMismatch: boolean,
    mode: ParamMismatchMode,
    ifaceName: string,
    warn: (msg: string) => void,
  ): InterfaceMethodContracts {
    const baseContracts = { preTags, postTags, sourceInterface: ifaceName };
    if (hasMismatch && mode === MODE_RENAME) {
      const renamedTags = {
        preTags: applyRenameToTags(preTags, renameMap, warn),
        postTags: applyRenameToTags(postTags, renameMap, warn),
        sourceInterface: ifaceName,
      };
      return prevExpr !== undefined
        ? { ...renamedTags, prevExpression: prevExpr }
        : renamedTags;
    }
    return prevExpr !== undefined
      ? { ...baseContracts, prevExpression: prevExpr }
      : baseContracts;
  }
  ```

- [ ] **Step 4: Update `extractMethodContracts` to pass `warn`**

  In `extractMethodContracts` (lines 229–273), update the two call sites that need `warn`:

  ```typescript
  // Line ~267: rename prevExpr
  if (hasMismatch && mode === MODE_RENAME && prevExpr !== undefined) {
    prevExpr = renameIdentifiersInExpression(prevExpr, renameMap, warn);
  }

  // Line ~270: call buildContractsResult
  return buildContractsResult(
    preTags, postTags, prevExpr, renameMap, hasMismatch, mode, ifaceName, warn,
  );
  ```

- [ ] **Step 5: Update `extractBaseMethodContracts` to pass `warn`**

  In `extractBaseMethodContracts` (lines 293–342), update the same two call sites:

  ```typescript
  // Rename prevExpr
  if (hasMismatch && mode === MODE_RENAME && prevExpr !== undefined) {
    prevExpr = renameIdentifiersInExpression(prevExpr, renameMap, warn);
  }

  // Call buildContractsResult
  return buildContractsResult(
    preTags, postTags, prevExpr, renameMap, hasMismatch, mode, baseName, warn,
  );
  ```

- [ ] **Step 6: Run typecheck to confirm all call sites compile**

  ```bash
  npm run typecheck 2>&1 | tail -20
  ```

  Expected: no errors. If there are errors, fix them before proceeding.

- [ ] **Step 7: Replace the regex body of `renameIdentifiersInExpression` with the AST implementation**

  Replace the full `renameIdentifiersInExpression` function with:

  ```typescript
  function renameIdentifiersInExpression(
    expression: string,
    renameMap: Map<string, string>,
    warn: (msg: string) => void,
  ): string {
    if (renameMap.size === 0) return expression;

    const sourceFile = typescript.createSourceFile(
      'expr.ts',
      expression,
      typescript.ScriptTarget.ES2020,
      true,
    );
    const firstStmt = sourceFile.statements[0];
    if (!firstStmt || !typescript.isExpressionStatement(firstStmt)) {
      warn(`[axiom] Could not parse contract expression for AST rename, using regex fallback: ${expression}`);
      return renameWithRegex(expression, renameMap);
    }

    const printer = typescript.createPrinter();

    function visit(node: typescript.Node): typescript.Node {
      if (typescript.isIdentifier(node)) {
        const renamed = renameMap.get(node.text);
        if (renamed !== undefined) {
          return typescript.factory.createIdentifier(renamed);
        }
      }
      return typescript.visitEachChild(node, visit, undefined);
    }

    const transformed = typescript.visitNode(sourceFile, visit) as typescript.SourceFile;
    const transformedStmt = transformed.statements[0] as typescript.ExpressionStatement;
    return printer.printNode(
      typescript.EmitHint.Expression,
      transformedStmt.expression,
      transformed,
    );
  }
  ```

  Note: `renameWithRegex` (added in Step 1) remains below this function as the fallback.

- [ ] **Step 8: Run the targeted test suite to verify the regression tests now pass**

  ```bash
  npm test -- --testPathPattern=interface-resolver --verbose 2>&1 | tail -40
  ```

  Expected: all tests in `test/interface-resolver.test.ts` pass, including the four new tests added in Task 1. The "chained rename" tests should now show `received: "value > 0"`.

- [ ] **Step 9: Run the full test suite to verify no regressions**

  ```bash
  npm test 2>&1 | tail -30
  ```

  Expected: all tests pass. Coverage should remain above 80%.

- [ ] **Step 10: Run typecheck and lint**

  ```bash
  npm run typecheck 2>&1 | tail -10 && npm run lint 2>&1 | tail -10
  ```

  Expected: no errors and no lint warnings.

- [ ] **Step 11: Commit the implementation**

  ```bash
  git add src/interface-resolver.ts
  git commit -m "fix: replace regex identifier rename with AST walk in interface-resolver

  Eliminates order-dependence bug where a rename map {val→value, value→amount}
  would double-rename val→value→amount. The AST visitor visits each identifier
  node in the original tree exactly once, substituting from the original map.
  A regex fallback is retained for expressions that fail to parse."
  ```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Covered by |
|---|---|
| AST parse → walk → print in `renameIdentifiersInExpression` | Task 2, Step 7 |
| Order-independent: each identifier visited once | Task 2, Step 7 (visitor visits original nodes, not mutated output) |
| No regex-based substitution remaining | Task 2, Steps 1+7 (regex isolated to `renameWithRegex` fallback) |
| Function signature unchanged (public callers unaffected) | Private function; all callers updated internally |
| Fallback to regex on parse failure with `warn` | Task 2, Step 7 |
| Regression test: `{val→value, value→amount}` in `val > 0` → `value > 0` | Task 1, test 1 |
| Regression test: `@prev` expression with same scenario | Task 1, test 4 |
| Multiple non-overlapping rename in one expression | Task 1, test 2 |
| Rename inside member access | Task 1, test 3 |
| Empty rename map → unchanged | Covered by early-return `if (renameMap.size === 0)` |

**Placeholder scan:** No TBDs. All steps contain complete code or commands.

**Type consistency:**
- `renameIdentifiersInExpression(expression: string, renameMap: Map<string, string>, warn: (msg: string) => void): string` — used in Steps 1, 4, 5, 7. ✓
- `applyRenameToTags(tags: ContractTag[], renameMap: Map<string, string>, warn: (msg: string) => void): ContractTag[]` — defined Step 2, consumed Step 3. ✓
- `buildContractsResult(..., warn: (msg: string) => void): InterfaceMethodContracts` — defined Step 3, consumed Steps 4, 5. ✓
