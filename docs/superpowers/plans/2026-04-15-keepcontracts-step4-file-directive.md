# keepContracts Step 4 — File-Level `// @axiom keepContracts` Directive (Stretch Goal)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect a `// @axiom keepContracts [qualifier]` comment on the very first line of a source file and use it to override the global `keepContracts` value for that file's transformation pass. The comment is not stripped from the output.

**Architecture:** A `readFileDirective` helper in `src/transformer.ts` inspects the leading trivia of the first statement in the `SourceFile`. If it finds a matching comment on line 0, it returns the resolved `KeepContracts` value. The per-file visitor computes `effectiveKeepContracts` by preferring the directive over the global option, then passes `effectiveKeepContracts` into `visitNode` instead of the global value.

**Tech Stack:** TypeScript, Jest (`npm test`), ESLint (`npm run lint`).

**Prerequisite:** Steps 1 and 2 must be complete.

**ESLint constraints:**
- `id-length: min 3` — no identifiers shorter than 3 chars.
- `complexity: 10` — keep functions small, extract helpers.
- `max-len: 100` — lines under 100 chars.

---

## File Map

| File | Change |
|---|---|
| `src/transformer.ts` | Add `DIRECTIVE_PREFIX` constant, `readFileDirective` helper, `effectiveKeepContracts` computation in per-file visitor |
| `test/transformer.test.ts` | New `describe('file-level @axiom keepContracts directive', ...)` block |

---

### Task 1: Write the failing tests

**Files:**
- Modify: `test/transformer.test.ts`

- [ ] **Step 1: Add the new describe block to `test/transformer.test.ts`**

Append at the bottom of the file:

```typescript
describe('file-level @axiom keepContracts directive', () => {
  it('directive with no qualifier enables "all", overriding global false', () => {
    const source = `// @axiom keepContracts
/**
 * @pre x > 0
 * @post result > 0
 */
export function double(x: number): number { return x * 2; }
`;
    const result = transform(source, { keepContracts: false });
    expect(result).toContain('x > 0');
    expect(result).toContain('result > 0');
  });

  it('directive "pre" enables only pre, overriding global false', () => {
    const source = `// @axiom keepContracts pre
/**
 * @pre x > 0
 * @post result > 0
 */
export function double(x: number): number { return x * 2; }
`;
    const result = transform(source, { keepContracts: false });
    expect(result).toContain('x > 0');
    expect(result).not.toContain('result > 0');
    expect(result).not.toContain('__axiom_result__');
  });

  it('directive "post" enables only post, overriding global false', () => {
    const source = `// @axiom keepContracts post
/**
 * @pre x > 0
 * @post result > 0
 */
export function double(x: number): number { return x * 2; }
`;
    const result = transform(source, { keepContracts: false });
    expect(result).not.toContain('x > 0');
    expect(result).toContain('result > 0');
    expect(result).toContain('__axiom_result__');
  });

  it('file without directive and global false — no checks emitted (existing behaviour)', () => {
    const source = `
/** @pre x > 0 */
export function inc(x: number): number { return x + 1; }
`;
    const baseline = transform(source);
    const result = transform(source, { keepContracts: false });
    expect(result).toBe(baseline);
  });

  it('directive on a non-first line is ignored', () => {
    const source = `export const dummy = 1;
// @axiom keepContracts
/** @pre x > 0 */
export function inc(x: number): number { return x + 1; }
`;
    const result = transform(source, { keepContracts: false });
    expect(result).not.toContain('x > 0');
  });
});
```

- [ ] **Step 2: Run to confirm the tests fail**

Run: `npm test -- --testPathPattern="transformer" --testNamePattern="file-level @axiom keepContracts directive" --no-coverage`
Expected: the first three tests fail (directive not yet detected); the last two may already pass.

---

### Task 2: Implement `readFileDirective` in `src/transformer.ts`

**Files:**
- Modify: `src/transformer.ts`

- [ ] **Step 1: Add the `DIRECTIVE_PREFIX` constant and `readFileDirective` helper**

Add these two items immediately before the `visitNode` function in `src/transformer.ts`:

```typescript
const DIRECTIVE_PREFIX = '// @axiom keepContracts' as const;

function readFileDirective(
  sourceFile: typescript.SourceFile,
): KeepContracts | undefined {
  const firstStatement = sourceFile.statements[0];
  if (firstStatement === undefined) {
    return undefined;
  }
  const fullText = sourceFile.getFullText();
  const leading = fullText.slice(0, firstStatement.getFullStart());
  const firstLine = leading.split('\n')[0].trim();
  if (!firstLine.startsWith(DIRECTIVE_PREFIX)) {
    return undefined;
  }
  const qualifier = firstLine.slice(DIRECTIVE_PREFIX.length).trim();
  if (qualifier === '' || qualifier === 'all') return 'all';
  if (qualifier === 'pre') return 'pre';
  if (qualifier === 'post') return 'post';
  if (qualifier === 'invariant') return 'invariant';
  return undefined;
}
```

- [ ] **Step 2: Apply the directive in the per-file visitor**

In the `return (sourceFile: typescript.SourceFile)` closure inside `createTransformer`, add the directive detection before building `reparsedIndex`. Replace the existing opening lines of that closure with:

```typescript
return (sourceFile: typescript.SourceFile): typescript.SourceFile => {
  const fileDirective = readFileDirective(sourceFile);
  const effectiveKeepContracts: KeepContracts = fileDirective !== undefined
    ? fileDirective
    : keepContracts;
  const reparsedIndex = buildReparsedIndex(sourceFile);
  const transformed = { value: false };
  const visited = typescript.visitEachChild(
    sourceFile,
    (node) => visitNode(
      factory, node, context, reparsedIndex, transformed, warn,
      checker, reparsedCache, paramMismatch, allowIdentifiers, effectiveKeepContracts,
    ),
    context,
  );

  if (!transformed.value) {
    return visited;
  }

  const importDecl = buildRequireStatement(factory);
  return factory.updateSourceFile(
    visited, [importDecl, ...Array.from(visited.statements)],
  );
};
```

- [ ] **Step 3: Run the failing tests — confirm they now pass**

Run: `npm test -- --testPathPattern="transformer" --testNamePattern="file-level @axiom keepContracts directive" --no-coverage`
Expected: all five tests pass.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests pass, coverage threshold met.

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: no errors. Fix any `id-length`, `complexity`, or `max-len` violations before committing.

- [ ] **Step 6: Commit**

```bash
git add src/transformer.ts test/transformer.test.ts
git commit -m "feat: support file-level @axiom keepContracts directive"
```
