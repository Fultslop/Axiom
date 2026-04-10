# Identifier Scope Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three related gaps that cause valid contract expressions to be dropped with spurious `unknown-identifier` warnings: missing standard globals (`Math`, `Object`, etc.), destructured parameter bindings, and enum/module-level constant references.

**Architecture:** Three independent fixes applied in sequence. Fix #5 (globals) is a one-line constant extension. Fix #1 (destructuring) adds a recursive binding-name walker to `node-helpers.ts` and a parallel type-resolver in `type-helpers.ts`. Fix #4 (enums/constants) uses `checker.getSymbolsInScope` when a TypeChecker is available, and a new `allowIdentifiers` transformer option as a fallback for transpileModule environments.

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
| `src/contract-validator.ts` | Extend `GLOBAL_IDENTIFIERS` constant |
| `src/node-helpers.ts` | Add private `extractBindingNames`; update `buildKnownIdentifiers` |
| `src/type-helpers.ts` | Add private `extractBindingTypes`; update `buildParameterTypes` |
| `src/function-rewriter.ts` | Add `buildScopeIdentifiers`; merge scope+allowIdentifiers into `preKnown`/`postKnown` in `rewriteFunction`; add `allowIdentifiers` param to `rewriteFunction` and `tryRewriteFunction` |
| `src/class-rewriter.ts` | Thread `allowIdentifiers` through `rewriteMembers`, `rewriteMember`, `rewriteClass`, `tryRewriteClass` |
| `src/transformer.ts` | Add `allowIdentifiers?: string[]` to options; thread to `visitNode` and down to `tryRewriteFunction`/`tryRewriteClass` |
| `test/transformer.test.ts` | New describe blocks for each fix |

---

## Task 1: Extend `GLOBAL_IDENTIFIERS` (Fix #5)

**Files:**
- Modify: `src/contract-validator.ts:38`
- Test: `test/transformer.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block in `test/transformer.test.ts`:

```typescript
describe('global identifier whitelist', () => {
  it('injects @pre using Math.abs without warning', () => {
    const source = `
      /**
       * @pre Math.abs(delta) < 1
       */
      export function nudge(delta: number): void {}
    `;
    const warnings: string[] = [];
    const output = transform(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
    expect(output).toContain('!(Math.abs(delta) < 1)');
  });

  it('injects @pre using isNaN without warning', () => {
    const source = `
      /**
       * @pre isNaN(value) === false
       */
      export function parse(value: number): number { return value; }
    `;
    const warnings: string[] = [];
    const output = transform(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
    expect(output).toContain('!(isNaN(value) === false)');
  });

  it('injects @pre using JSON.stringify without warning', () => {
    const source = `
      /**
       * @pre JSON.stringify(obj) !== ""
       */
      export function serialize(obj: object): string { return ""; }
    `;
    const warnings: string[] = [];
    const output = transform(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
    expect(output).toContain('!(JSON.stringify(obj) !== "")');
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

```
npx jest --testPathPattern="transformer" -t "global identifier whitelist" --no-coverage
```

Expected: 3 FAILs — warnings array has entries instead of being empty.

- [ ] **Step 3: Extend `GLOBAL_IDENTIFIERS` in `src/contract-validator.ts`**

Replace line 38:
```typescript
const GLOBAL_IDENTIFIERS = new Set(['undefined', 'NaN', 'Infinity', 'globalThis', 'arguments']);
```
With:
```typescript
const GLOBAL_IDENTIFIERS = new Set([
  'undefined', 'NaN', 'Infinity', 'globalThis', 'arguments',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Math', 'JSON', 'Date', 'RegExp', 'Error',
  'Promise',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent',
  'console',
]);
```

- [ ] **Step 4: Run tests to confirm they pass**

```
npx jest --testPathPattern="transformer" -t "global identifier whitelist" --no-coverage
```

Expected: 3 PASSes.

- [ ] **Step 5: Run full suite to confirm nothing regressed**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```
git add src/contract-validator.ts test/transformer.test.ts
git commit -m "feat: extend GLOBAL_IDENTIFIERS with standard built-ins (Math, JSON, etc.)"
```

---

## Task 2: Fix destructured parameter binding names (Fix #1 — known identifiers)

**Files:**
- Modify: `src/node-helpers.ts:39-54`
- Test: `test/transformer.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/transformer.test.ts`:

```typescript
describe('destructured parameter binding names', () => {
  it('injects @pre referencing destructured object binding', () => {
    const source = `
      /**
       * @pre x > 0
       */
      export function move({ x, y }: { x: number; y: number }): void {}
    `;
    const warnings: string[] = [];
    const output = transform(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
    expect(output).toContain('!(x > 0)');
  });

  it('injects @pre referencing nested destructured binding', () => {
    const source = `
      /**
       * @pre bbb > 0
       */
      export function foo({ aaa: { bbb } }: { aaa: { bbb: number } }): void {}
    `;
    const warnings: string[] = [];
    const output = transform(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
    expect(output).toContain('!(bbb > 0)');
  });

  it('injects @pre referencing array destructured binding', () => {
    const source = `
      /**
       * @pre first > 0
       */
      export function head([first]: number[]): number { return first; }
    `;
    const warnings: string[] = [];
    const output = transform(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
    expect(output).toContain('!(first > 0)');
  });

  it('injects @pre using alias name, not original property name', () => {
    const source = `
      /**
       * @pre alias > 0
       */
      export function bar({ original: alias }: { original: number }): void {}
    `;
    const warnings: string[] = [];
    const output = transform(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
    expect(output).toContain('!(alias > 0)');
  });

  it('drops @pre using original property name when aliased', () => {
    const source = `
      /**
       * @pre original > 0
       */
      export function bar({ original: alias }: { original: number }): void {}
    `;
    const warnings: string[] = [];
    transform(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes('original'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

```
npx jest --testPathPattern="transformer" -t "destructured parameter binding names" --no-coverage
```

Expected: first 4 FAILs (unknown-identifier warnings), last 1 PASS or FAIL depending on current behaviour.

- [ ] **Step 3: Add `extractBindingNames` and update `buildKnownIdentifiers` in `src/node-helpers.ts`**

Replace the entire `buildKnownIdentifiers` export and add the private helper before it:

```typescript
function extractBindingNames(
  name: typescript.BindingName,
  names: Set<string>,
): void {
  if (typescript.isIdentifier(name)) {
    names.add(name.text);
  } else if (typescript.isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      extractBindingNames(element.name, names);
    }
  } else if (typescript.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (!typescript.isOmittedExpression(element)) {
        extractBindingNames(element.name, names);
      }
    }
  }
}

export function buildKnownIdentifiers(
  node: typescript.FunctionLikeDeclaration,
  includeResult: boolean,
): Set<string> {
  const names = new Set<string>(['this']);
  for (const param of node.parameters) {
    extractBindingNames(param.name, names);
  }
  if (includeResult) {
    names.add('result');
    names.add('prev');
  }
  return names;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```
npx jest --testPathPattern="transformer" -t "destructured parameter binding names" --no-coverage
```

Expected: all 5 PASSes.

- [ ] **Step 5: Run full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```
git add src/node-helpers.ts test/transformer.test.ts
git commit -m "feat: recognise destructured parameter binding names as known identifiers"
```

---

## Task 3: Destructured binding types for type-mismatch detection (Fix #1 — type map)

This requires a full TypeChecker so tests use `transformWithProgram`.

**Files:**
- Modify: `src/type-helpers.ts:20-35`
- Test: `test/transformer.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/transformer.test.ts`:

```typescript
describe('destructured binding type-mismatch detection', () => {
  it('warns on type mismatch for destructured number binding compared to string', () => {
    const source = `
      /**
       * @pre xxx === "hello"
       */
      export function foo({ xxx }: { xxx: number }): void {}
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes('type mismatch') && w.includes('xxx'))).toBe(true);
  });

  it('injects @pre for correct type comparison on destructured binding', () => {
    const source = `
      /**
       * @pre xxx > 0
       */
      export function foo({ xxx }: { xxx: number }): number { return xxx; }
    `;
    const warnings: string[] = [];
    const output = transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
    expect(output).toContain('!(xxx > 0)');
  });
});
```

- [ ] **Step 2: Run to confirm first test fails**

```
npx jest --testPathPattern="transformer" -t "destructured binding type-mismatch detection" --no-coverage
```

Expected: first test FAILS (no warning emitted), second PASSES.

- [ ] **Step 3: Add `extractBindingTypes` and update `buildParameterTypes` in `src/type-helpers.ts`**

Add the private helper before `buildParameterTypes`, then update `buildParameterTypes`:

```typescript
function extractBindingTypes(
  name: typescript.BindingName,
  checker: typescript.TypeChecker,
  types: Map<string, SimpleType>,
): void {
  if (typescript.isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      if (typescript.isIdentifier(element.name)) {
        const elementType = checker.getTypeAtLocation(element);
        const simpleType = simpleTypeFromFlags(elementType.flags);
        if (simpleType !== undefined) {
          types.set(element.name.text, simpleType);
        }
      } else {
        extractBindingTypes(element.name, checker, types);
      }
    }
  } else if (typescript.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (
        !typescript.isOmittedExpression(element) &&
        typescript.isIdentifier(element.name)
      ) {
        const elementType = checker.getTypeAtLocation(element);
        const simpleType = simpleTypeFromFlags(elementType.flags);
        if (simpleType !== undefined) {
          types.set(element.name.text, simpleType);
        }
      }
    }
  }
}

export function buildParameterTypes(
  node: typescript.FunctionLikeDeclaration,
  checker: typescript.TypeChecker,
): Map<string, SimpleType> {
  const types = new Map<string, SimpleType>();
  for (const param of node.parameters) {
    if (typescript.isIdentifier(param.name)) {
      const paramType = checker.getTypeAtLocation(param);
      const simpleType = simpleTypeFromFlags(paramType.flags);
      if (simpleType !== undefined) {
        types.set(param.name.text, simpleType);
      }
    } else {
      extractBindingTypes(param.name, checker, types);
    }
  }
  return types;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```
npx jest --testPathPattern="transformer" -t "destructured binding type-mismatch detection" --no-coverage
```

Expected: both PASSes.

- [ ] **Step 5: Run full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```
git add src/type-helpers.ts test/transformer.test.ts
git commit -m "feat: resolve destructured binding types for type-mismatch detection"
```

---

## Task 4: TypeChecker scope resolution for enums and module constants (Fix #4 — checker mode)

**Files:**
- Modify: `src/function-rewriter.ts:316-368` (the `rewriteFunction` body)
- Test: `test/transformer.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/transformer.test.ts`:

```typescript
describe('scope identifiers (enum and module constants)', () => {
  it('injects @pre referencing a const enum member without warning (checker mode)', () => {
    const source = `
      const enum Status { Active = 0, Inactive = 1 }
      /**
       * @pre status === Status.Active
       */
      export function handle(status: number): void {}
    `;
    const warnings: string[] = [];
    const output = transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
    expect(output).toContain('!(status === Status.Active)');
  });

  it('injects @pre referencing a module-level const without warning (checker mode)', () => {
    const source = `
      const MAX_SIZE = 100;
      /**
       * @pre amount <= MAX_SIZE
       */
      export function process(amount: number): void {}
    `;
    const warnings: string[] = [];
    const output = transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
    expect(output).toContain('!(amount <= MAX_SIZE)');
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

```
npx jest --testPathPattern="transformer" -t "scope identifiers" --no-coverage
```

Expected: 2 FAILs — unknown-identifier warnings for `Status` and `MAX_SIZE`.

- [ ] **Step 3: Add `buildScopeIdentifiers` and merge into `rewriteFunction` in `src/function-rewriter.ts`**

Add the private function after the `expressionUsesPrev` block (around line 103):

```typescript
function buildScopeIdentifiers(
  node: typescript.FunctionLikeDeclaration,
  checker: typescript.TypeChecker,
): Set<string> {
  const scopeNode = node.parent;
  const symbols = checker.getSymbolsInScope(
    scopeNode,
    typescript.SymbolFlags.Value,
  );
  return new Set(symbols.map((sym) => sym.name));
}
```

In `rewriteFunction`, after the two `buildKnownIdentifiers` calls (lines 326-327), add the merge:

```typescript
const preKnown = buildKnownIdentifiers(node, false);
const postKnown = buildKnownIdentifiers(node, true);
if (checker !== undefined) {
  const scopeIds = buildScopeIdentifiers(node, checker);
  for (const scopeId of scopeIds) {
    preKnown.add(scopeId);
    postKnown.add(scopeId);
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```
npx jest --testPathPattern="transformer" -t "scope identifiers" --no-coverage
```

Expected: both PASSes.

- [ ] **Step 5: Run full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```
git add src/function-rewriter.ts test/transformer.test.ts
git commit -m "feat: resolve enum and module-level identifiers via TypeChecker scope"
```

---

## Task 5: `allowIdentifiers` transformer option (Fix #4 — transpileModule fallback)

**Files:**
- Modify: `src/function-rewriter.ts` — add `allowIdentifiers` param to `rewriteFunction` and `tryRewriteFunction`
- Modify: `src/class-rewriter.ts` — thread `allowIdentifiers` through `rewriteMembers`, `rewriteMember`, `rewriteClass`, `tryRewriteClass`
- Modify: `src/transformer.ts` — add option; thread through `visitNode`
- Test: `test/transformer.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/transformer.test.ts`. Note: this test calls `createTransformer` directly with the new option — import it at the top of the file if not already imported:

```typescript
// At top of file (if not present):
// import createTransformer from '@src/transformer';

describe('allowIdentifiers transformer option', () => {
  it('accepts Status as known identifier when listed in allowIdentifiers', () => {
    const source = `
      /**
       * @pre status === Status.Active
       */
      export function handle(status: number): void {}
    `;
    const warnings: string[] = [];
    const result = typescript.transpileModule(source, {
      compilerOptions: {
        target: typescript.ScriptTarget.ES2020,
        module: typescript.ModuleKind.CommonJS,
      },
      transformers: {
        before: [createTransformer(undefined, {
          warn: (msg) => warnings.push(msg),
          allowIdentifiers: ['Status'],
        })],
      },
    });
    expect(warnings).toHaveLength(0);
    expect(result.outputText).toContain('!(status === Status.Active)');
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```
npx jest --testPathPattern="transformer" -t "allowIdentifiers transformer option" --no-coverage
```

Expected: FAIL — TypeScript compile error (option doesn't exist yet) or warning for `Status`.

- [ ] **Step 3: Add `allowIdentifiers` to `rewriteFunction` and `tryRewriteFunction` in `src/function-rewriter.ts`**

Update `rewriteFunction` signature (add last parameter with default):

```typescript
function rewriteFunction(
  factory: typescript.NodeFactory,
  node: typescript.FunctionLikeDeclaration,
  reparsedFunctions: Map<number, typescript.FunctionLikeDeclaration>,
  warn: (msg: string) => void,
  checker?: typescript.TypeChecker,
  invariantExpressions: string[] = [],
  interfaceMethodContracts?: InterfaceMethodContracts,
  allowIdentifiers: string[] = [],
): typescript.FunctionLikeDeclaration | null {
```

In `rewriteFunction`, after the scope merge block from Task 4, add:

```typescript
for (const allowedId of allowIdentifiers) {
  preKnown.add(allowedId);
  postKnown.add(allowedId);
}
```

Update `tryRewriteFunction` signature (add last parameter with default):

```typescript
export function tryRewriteFunction(
  factory: typescript.NodeFactory,
  node: typescript.FunctionLikeDeclaration,
  reparsedFunctions: Map<number, typescript.FunctionLikeDeclaration>,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker?: typescript.TypeChecker,
  invariantExpressions: string[] = [],
  interfaceMethodContracts?: InterfaceMethodContracts,
  allowIdentifiers: string[] = [],
): typescript.FunctionLikeDeclaration {
  try {
    const rewritten = rewriteFunction(
      factory, node, reparsedFunctions, warn, checker,
      invariantExpressions, interfaceMethodContracts, allowIdentifiers,
    );
```

- [ ] **Step 4: Thread `allowIdentifiers` through `src/class-rewriter.ts`**

Update `rewriteMember` signature (append):
```typescript
function rewriteMember(
  factory: typescript.NodeFactory,
  member: typescript.ClassElement,
  reparsedIndex: ReparsedIndex,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker: typescript.TypeChecker | undefined,
  effectiveInvariants: string[],
  className: string,
  interfaceContracts: InterfaceContracts,
  allowIdentifiers: string[] = [],
): { element: typescript.ClassElement; changed: boolean } {
```

Update the `tryRewriteFunction` call inside `rewriteMember`:
```typescript
const rewritten = tryRewriteFunction(
  factory, member, reparsedIndex.functions, transformed, warn,
  checker, effectiveInvariants, ifaceMethodContracts, allowIdentifiers,
);
```

Update `rewriteMembers` signature (append):
```typescript
function rewriteMembers(
  factory: typescript.NodeFactory,
  members: readonly typescript.ClassElement[],
  reparsedIndex: ReparsedIndex,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker: typescript.TypeChecker | undefined,
  effectiveInvariants: string[],
  className: string,
  interfaceContracts: InterfaceContracts,
  allowIdentifiers: string[] = [],
): { elements: typescript.ClassElement[]; changed: boolean } {
```

Update the `rewriteMember` call inside `rewriteMembers`:
```typescript
const result = rewriteMember(
  factory, member, reparsedIndex, transformed, warn, checker,
  effectiveInvariants, className, interfaceContracts, allowIdentifiers,
);
```

Update `rewriteClass` signature (append):
```typescript
function rewriteClass(
  factory: typescript.NodeFactory,
  node: typescript.ClassDeclaration,
  reparsedIndex: ReparsedIndex,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker: typescript.TypeChecker | undefined,
  cache: Map<string, typescript.SourceFile>,
  mode: ParamMismatchMode,
  allowIdentifiers: string[] = [],
): typescript.ClassDeclaration {
```

Update the `rewriteMembers` call inside `rewriteClass`:
```typescript
const { elements: newMembers, changed: classTransformed } = rewriteMembers(
  factory, node.members, reparsedIndex, transformed, warn, checker,
  effectiveInvariants, className, interfaceContracts, allowIdentifiers,
);
```

Update `tryRewriteClass` signature (append):
```typescript
export function tryRewriteClass(
  factory: typescript.NodeFactory,
  node: typescript.ClassDeclaration,
  reparsedIndex: ReparsedIndex,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker?: typescript.TypeChecker,
  cache: Map<string, typescript.SourceFile> = new Map(),
  mode: ParamMismatchMode = 'rename',
  allowIdentifiers: string[] = [],
): typescript.ClassDeclaration {
  try {
    return rewriteClass(
      factory, node, reparsedIndex, transformed, warn, checker, cache, mode, allowIdentifiers,
    );
```

- [ ] **Step 5: Add `allowIdentifiers` option to `src/transformer.ts`**

Update the `createTransformer` options type:
```typescript
export default function createTransformer(
  _program?: typescript.Program,
  options?: {
    warn?: (msg: string) => void;
    interfaceParamMismatch?: 'rename' | 'ignore';
    allowIdentifiers?: string[];
  },
): typescript.TransformerFactory<typescript.SourceFile> {
```

Capture the option after the `checker` line:
```typescript
const checker = _program?.getTypeChecker?.();
const allowIdentifiers = options?.allowIdentifiers ?? [];
const reparsedCache = new Map<string, typescript.SourceFile>();
```

Update `visitNode` signature to accept `allowIdentifiers`:
```typescript
function visitNode(
  factory: typescript.NodeFactory,
  node: typescript.Node,
  context: typescript.TransformationContext,
  reparsedIndex: ReparsedIndex,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker: typescript.TypeChecker | undefined,
  reparsedCache: Map<string, typescript.SourceFile>,
  paramMismatch: ParamMismatchMode,
  allowIdentifiers: string[],
): typescript.Node {
```

Update the `tryRewriteClass` call in `visitNode`:
```typescript
return tryRewriteClass(
  factory, node, reparsedIndex, transformed, warn,
  checker, reparsedCache, paramMismatch, allowIdentifiers,
);
```

Update the `tryRewriteFunction` call in `visitNode`:
```typescript
return tryRewriteFunction(
  factory,
  node as typescript.FunctionLikeDeclaration,
  reparsedIndex.functions,
  transformed,
  warn,
  checker,
  [],
  undefined,
  allowIdentifiers,
);
```

Update both `visitNode` call sites inside the transformer factory to pass `allowIdentifiers`:
```typescript
(node) => visitNode(
  factory, node, context, reparsedIndex, transformed, warn,
  checker, reparsedCache, paramMismatch, allowIdentifiers,
),
```

And the recursive call inside `visitNode`:
```typescript
return typescript.visitEachChild(
  node,
  (child) => visitNode(
    factory, child, context, reparsedIndex, transformed, warn,
    checker, reparsedCache, paramMismatch, allowIdentifiers,
  ),
  context,
);
```

- [ ] **Step 6: Run tests to confirm they pass**

```
npx jest --testPathPattern="transformer" -t "allowIdentifiers transformer option" --no-coverage
```

Expected: PASS.

- [ ] **Step 7: Run full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```
git add src/function-rewriter.ts src/class-rewriter.ts src/transformer.ts test/transformer.test.ts
git commit -m "feat: add allowIdentifiers transformer option for transpileModule environments"
```
