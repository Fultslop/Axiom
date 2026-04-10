# Template Literal Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the bug where a template literal in one contract tag silently drops all contracts on the function, and add full reifier support so template literals work in contract expressions.

**Architecture:** Two changes applied in order. First, add `NoSubstitutionTemplateLiteral` and `TemplateExpression` handling to `reifyExpression` in `src/reifier.ts` — this resolves the root bug (the reifier throw) and adds the feature simultaneously. Second, extend `getLiteralSimpleType` in `src/contract-validator.ts` so backtick strings without interpolation are recognised as string literals for type-mismatch detection. The spec's Fix A (validation-phase detection) is omitted because both fixes ship together.

**Tech Stack:** TypeScript, ts-patch transformer API, Jest.

---

## ESLint constraints (read before touching any `src/` file)

- `id-length: min 3` — no identifiers shorter than 3 characters.
- `complexity: 10` — keep functions small; extract helpers.
- `max-len: 100` — lines under 100 chars.
- No `console` — use the injectable `warn` callback.

---

## File Map

| File | Change |
|---|---|
| `src/reifier.ts` | Add `NoSubstitutionTemplateLiteral` to `reifyLiteralOrKeyword`; add `TemplateExpression` to `reifyCompositeExpression` |
| `src/contract-validator.ts` | Extend `getLiteralSimpleType` to return `TYPE_STRING` for `NoSubstitutionTemplateLiteral` |
| `README.md` | Remove or update limitation #6 |
| `test/transformer.test.ts` | New describe blocks for both features |

---

## Task 1: Support `NoSubstitutionTemplateLiteral` in the reifier

**Files:**
- Modify: `src/reifier.ts:8-34` (`reifyLiteralOrKeyword`)
- Test: `test/transformer.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/transformer.test.ts`:

```typescript
describe('NoSubstitutionTemplateLiteral in contract expressions', () => {
  it('injects @pre with a no-substitution template literal', () => {
    const source = `
      /**
       * @pre label === \`hello\`
       */
      export function tag(label: string): void {}
    `;
    const warnings: string[] = [];
    const output = transform(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
    expect(output).toContain('!(label === `hello`)');
  });

  it('does not drop other contracts on a function that has a no-substitution template literal', () => {
    const source = `
      /**
       * @pre count > 0
       * @pre label === \`ok\`
       */
      export function run(count: number, label: string): void {}
    `;
    const warnings: string[] = [];
    const output = transform(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
    expect(output).toContain('!(count > 0)');
    expect(output).toContain('!(label === `ok`)');
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

```
npx jest --testPathPattern="transformer" -t "NoSubstitutionTemplateLiteral in contract expressions" --no-coverage
```

Expected: both FAILs — the reifier throws `Unsupported expression node kind: NoSubstitutionTemplateLiteral`, which the catch-all swallows, returning the untransformed function.

- [ ] **Step 3: Add `NoSubstitutionTemplateLiteral` handling to `reifyLiteralOrKeyword` in `src/reifier.ts`**

After the `isStringLiteral` block (after line 19), add:

```typescript
if (typescript.isNoSubstitutionTemplateLiteral(node)) {
  return factory.createNoSubstitutionTemplateLiteral(node.text, node.rawText);
}
```

The full `reifyLiteralOrKeyword` function now handles: `Identifier`, `NumericLiteral`, `StringLiteral`, `NoSubstitutionTemplateLiteral`, `NullKeyword`, `TrueKeyword`, `FalseKeyword`, `ThisKeyword`.

- [ ] **Step 4: Run tests to confirm they pass**

```
npx jest --testPathPattern="transformer" -t "NoSubstitutionTemplateLiteral in contract expressions" --no-coverage
```

Expected: both PASSes.

- [ ] **Step 5: Run full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```
git add src/reifier.ts test/transformer.test.ts
git commit -m "feat: support NoSubstitutionTemplateLiteral in contract expression reifier"
```

---

## Task 2: Support `TemplateExpression` (interpolated templates) in the reifier

**Files:**
- Modify: `src/reifier.ts:37-64` (`reifyCompositeExpression`)
- Test: `test/transformer.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/transformer.test.ts`:

```typescript
describe('TemplateExpression in contract expressions', () => {
  it('injects @pre with an interpolated template literal', () => {
    const source = `
      /**
       * @pre label === \`item_\${id}\`
       */
      export function tag(label: string, id: string): void {}
    `;
    const warnings: string[] = [];
    const output = transform(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
    expect(output).toContain('!(label === `item_${id}`)');
  });

  it('does not drop other contracts when one uses an interpolated template literal', () => {
    const source = `
      /**
       * @pre count > 0
       * @pre label === \`item_\${id}\`
       */
      export function run(count: number, label: string, id: string): void {}
    `;
    const warnings: string[] = [];
    const output = transform(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
    expect(output).toContain('!(count > 0)');
    expect(output).toContain('!(label === `item_${id}`)');
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

```
npx jest --testPathPattern="transformer" -t "TemplateExpression in contract expressions" --no-coverage
```

Expected: both FAILs — `Unsupported expression node kind: TemplateExpression`.

- [ ] **Step 3: Add `TemplateExpression` handling to `reifyCompositeExpression` in `src/reifier.ts`**

Add after the `isElementAccessExpression` block (before the final `return undefined`):

```typescript
if (typescript.isTemplateExpression(node)) {
  return factory.createTemplateExpression(
    factory.createTemplateHead(node.head.text, node.head.rawText),
    node.templateSpans.map((span) =>
      factory.createTemplateSpan(
        reifyExpression(factory, span.expression),
        typescript.isTemplateMiddle(span.literal)
          ? factory.createTemplateMiddle(span.literal.text, span.literal.rawText)
          : factory.createTemplateTail(span.literal.text, span.literal.rawText),
      ),
    ),
  );
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```
npx jest --testPathPattern="transformer" -t "TemplateExpression in contract expressions" --no-coverage
```

Expected: both PASSes.

- [ ] **Step 5: Run full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```
git add src/reifier.ts test/transformer.test.ts
git commit -m "feat: support TemplateExpression (interpolated templates) in contract expression reifier"
```

---

## Task 3: Type-mismatch detection for `NoSubstitutionTemplateLiteral`

**Files:**
- Modify: `src/contract-validator.ts:66-80` (`getLiteralSimpleType`)
- Test: `test/transformer.test.ts`

This requires a TypeChecker so tests use `transformWithProgram`.

- [ ] **Step 1: Write the failing tests**

Add to `test/transformer.test.ts`:

```typescript
describe('type-mismatch detection for NoSubstitutionTemplateLiteral', () => {
  it('warns when a number parameter is compared to a backtick string literal', () => {
    const source = `
      /**
       * @pre count === \`hello\`
       */
      export function run(count: number): void {}
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes('type mismatch') && w.includes('count'))).toBe(true);
  });

  it('does not warn when a string parameter is compared to a backtick string literal', () => {
    const source = `
      /**
       * @pre label === \`hello\`
       */
      export function tag(label: string): void {}
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to confirm first test fails**

```
npx jest --testPathPattern="transformer" -t "type-mismatch detection for NoSubstitutionTemplateLiteral" --no-coverage
```

Expected: first test FAILS (no warning emitted), second PASSES.

- [ ] **Step 3: Extend `getLiteralSimpleType` in `src/contract-validator.ts`**

After the `isStringLiteral` check (line 70), add:

```typescript
if (typescript.isNoSubstitutionTemplateLiteral(node)) {
  return TYPE_STRING;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```
npx jest --testPathPattern="transformer" -t "type-mismatch detection for NoSubstitutionTemplateLiteral" --no-coverage
```

Expected: both PASSes.

- [ ] **Step 5: Run full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```
git add src/contract-validator.ts test/transformer.test.ts
git commit -m "feat: detect type mismatch when NoSubstitutionTemplateLiteral compared to non-string param"
```

---

## Task 4: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Find limitation #6 in `README.md`**

Open `README.md` and locate the line that reads something like:
> template literals are not recognised as typed string literals, so type mismatch between a typed parameter and a template literal is not detected

- [ ] **Step 2: Remove or replace the entry**

Remove limitation #6 from the limitations list entirely, or if a narrower note is warranted, replace with:

> Template literals are supported in contract expressions. Note: type-mismatch detection applies only to no-substitution template literals (`` `plain string` ``); interpolated expressions (`` `item_${id}` ``) are not type-checked.

- [ ] **Step 3: Run full suite one final time**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```
git add README.md
git commit -m "docs: update README to reflect template literal support"
```
