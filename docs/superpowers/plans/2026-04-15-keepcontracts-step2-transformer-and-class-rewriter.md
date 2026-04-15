# keepContracts Step 2 — Wire Up `transformer.ts` and `class-rewriter.ts`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose `keepContracts` as a public option on `createTransformer`, normalise it, thread the value through `visitNode` to `tryRewriteFunction` and `tryRewriteClass`, and thread it through the entire `class-rewriter.ts` call chain so class methods and constructors also respect the filter.

**Architecture:** `transformer.ts` imports `KeepContracts` and `normaliseKeepContracts` from `function-rewriter.ts` (added in Step 1). It normalises the raw option once and passes the value into every `visitNode` call. `class-rewriter.ts` imports `KeepContracts` from `function-rewriter.ts` and threads it down through `tryRewriteClass` → `rewriteClass` → `rewriteMembers` → `rewriteMember` → `tryRewriteFunction`. For class-level invariants, a helper suppresses the `#checkInvariants` injection when the active `keepContracts` value excludes invariants.

**Tech Stack:** TypeScript, Jest (`npm test`), ESLint (`npm run lint`).

**Prerequisite:** Step 1 must be complete. `tryRewriteFunction` in `src/function-rewriter.ts` must already accept a final `keepContracts: KeepContracts = false` parameter.

**ESLint constraints:**
- `id-length: min 3` — no identifiers shorter than 3 chars.
- `complexity: 10` — keep functions small, extract helpers.
- `max-len: 100` — lines under 100 chars.

---

## File Map

| File | Change |
|---|---|
| `src/transformer.ts` | Import `KeepContracts`, `normaliseKeepContracts`; add option; normalise; thread through `visitNode` |
| `src/class-rewriter.ts` | Import `KeepContracts`; add param to `tryRewriteClass` / `rewriteClass` / `rewriteMembers` / `rewriteMember`; gate invariants on `shouldEmitInvariantsForClass` |
| `test/transformer.test.ts` | New `describe('keepContracts with class invariants', ...)` block |

---

### Task 1: Write the failing class-invariant tests

**Files:**
- Modify: `test/transformer.test.ts`

- [ ] **Step 1: Add the new describe block to `test/transformer.test.ts`**

Append at the bottom of the file:

```typescript
describe('keepContracts with class invariants', () => {
  it('keepContracts: "invariant" — invariant call emitted, pre absent', () => {
    const source = `
      /** @invariant this.value > 0 */
      class Counter {
        value = 1;
        /** @pre amount > 0 */
        public increment(amount: number): void { this.value += amount; }
      }
    `;
    const warnings: string[] = [];
    const result = transformES2022(source, (msg) => warnings.push(msg));
    // baseline: both pre and invariant present
    expect(result).toContain('amount > 0');
    expect(result).toContain('checkInvariants');
    // now with 'invariant' only
    const filtered = transformES2022(source, { keepContracts: 'invariant' });
    expect(filtered).not.toContain('amount > 0');
    expect(filtered).toContain('checkInvariants');
  });

  it('keepContracts: "pre" — pre emitted, invariant call absent', () => {
    const source = `
      /** @invariant this.value > 0 */
      class Counter {
        value = 1;
        /** @pre amount > 0 */
        public increment(amount: number): void { this.value += amount; }
      }
    `;
    const result = transformES2022(source, { keepContracts: 'pre' });
    expect(result).toContain('amount > 0');
    expect(result).not.toContain('checkInvariants');
  });
});
```

Note: `transformES2022` is imported from `./helpers` in the test file that exercises class invariants. Check that the import is already present at the top of `test/transformer.test.ts`; add it if missing:

```typescript
import { transform, transformES2022 } from './helpers';
```

The `transformES2022` helper must also be updated to forward `keepContracts` from an options bag. Open `test/helpers.ts` and update `transformES2022` to match the same pattern used for `transform` in Step 1 of this plan (see below).

- [ ] **Step 2: Extend `transformES2022` in `test/helpers.ts`**

Replace the existing `transformES2022` function with:

```typescript
export function transformES2022(
  source: string,
  optionsOrWarn?: ((msg: string) => void) | {
    warn?: (msg: string) => void;
    keepContracts?: boolean | 'pre' | 'post' | 'invariant' | 'all';
  },
): string {
  const opts = typeof optionsOrWarn === 'function'
    ? { warn: optionsOrWarn }
    : optionsOrWarn;
  return typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2022,
      module: typescript.ModuleKind.CommonJS,
    },
    transformers: { before: [createTransformer(undefined, opts)] },
  }).outputText;
}
```

- [ ] **Step 3: Run to confirm the new tests fail**

Run: `npm test -- --testPathPattern="transformer" --testNamePattern="keepContracts with class invariants" --no-coverage`
Expected: FAIL — `keepContracts` is not yet wired into `transformer.ts` or `class-rewriter.ts`.

---

### Task 2: Update `transformer.ts` — expose and normalise the option, thread through `visitNode`

**Files:**
- Modify: `src/transformer.ts`

- [ ] **Step 1: Import `KeepContracts` and `normaliseKeepContracts` from `function-rewriter`**

In `src/transformer.ts`, update the import from `./function-rewriter`:

```typescript
import {
  tryRewriteFunction, isPublicTarget,
  type KeepContracts, normaliseKeepContracts,
} from './function-rewriter';
```

- [ ] **Step 2: Add `keepContracts` to the options object type**

In `createTransformer`, extend the options type:

```typescript
export default function createTransformer(
  _program?: typescript.Program,
  options?: {
    warn?: (msg: string) => void;
    interfaceParamMismatch?: 'rename' | 'ignore';
    allowIdentifiers?: string[];
    keepContracts?: boolean | 'pre' | 'post' | 'invariant' | 'all';
  },
): typescript.TransformerFactory<typescript.SourceFile> {
```

- [ ] **Step 3: Normalise `keepContracts` alongside the other options**

After the existing option extractions (`warn`, `paramMismatch`, `checker`, `allowIdentifiers`, `reparsedCache`), add:

```typescript
const keepContracts: KeepContracts = normaliseKeepContracts(options?.keepContracts);
```

- [ ] **Step 4: Add `keepContracts` parameter to `visitNode`**

`visitNode` currently ends with `allowIdentifiers: string[]`. Add one more param:

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
  keepContracts: KeepContracts,
): typescript.Node {
```

- [ ] **Step 5: Thread `keepContracts` through the `tryRewriteClass` call in `visitNode`**

The `tryRewriteClass` call is near the top of `visitNode`. Add `keepContracts` as the last argument:

```typescript
if (typescript.isClassDeclaration(node)) {
  return tryRewriteClass(
    factory, node, reparsedIndex, transformed, warn,
    checker, reparsedCache, paramMismatch, allowIdentifiers, keepContracts,
  );
}
```

- [ ] **Step 6: Thread `keepContracts` through the `tryRewriteFunction` call in `visitNode`**

The `tryRewriteFunction` call in `visitNode` passes `allowIdentifiers` as the last argument today. Add `keepContracts` after it:

```typescript
const rewritten = tryRewriteFunction(
  factory,
  node as typescript.FunctionLikeDeclaration,
  reparsedIndex.functions,
  transformed,
  warn,
  checker,
  [],
  undefined,
  allowIdentifiers,
  keepContracts,
);
```

- [ ] **Step 7: Thread `keepContracts` through both recursive `visitEachChild` calls in `visitNode`**

There are two places in `visitNode` that call `visitEachChild` with a recursive `visitNode` callback. Update both so `keepContracts` is forwarded as the last argument:

```typescript
return typescript.visitEachChild(
  rewritten,          // (or `node` for the fallthrough path)
  (child) => visitNode(
    factory, child, context, reparsedIndex, transformed, warn,
    checker, reparsedCache, paramMismatch, allowIdentifiers, keepContracts,
  ),
  context,
);
```

- [ ] **Step 8: Pass `keepContracts` in the outer `visitEachChild` call in the source-file visitor**

In the `return (sourceFile: typescript.SourceFile)` closure, the top-level `visitEachChild` call also invokes `visitNode`. Update it:

```typescript
const visited = typescript.visitEachChild(
  sourceFile,
  (node) => visitNode(
    factory, node, context, reparsedIndex, transformed, warn,
    checker, reparsedCache, paramMismatch, allowIdentifiers, keepContracts,
  ),
  context,
);
```

- [ ] **Step 9: Run typecheck**

Run: `npm run typecheck`
Expected: errors about `tryRewriteClass` not accepting 10 arguments — this is fixed in the next task.

---

### Task 3: Update `class-rewriter.ts` to accept and thread `keepContracts`

**Files:**
- Modify: `src/class-rewriter.ts`

- [ ] **Step 1: Import `KeepContracts` from `function-rewriter`**

In `src/class-rewriter.ts`, update the import from `./function-rewriter`:

```typescript
import {
  tryRewriteFunction, isPublicTarget, expressionUsesResult,
  filterValidTags, type KeepContracts,
} from './function-rewriter';
```

- [ ] **Step 2: Add `shouldEmitInvariantsForClass` helper**

Add near the top of the class-rewriter-specific helpers section (after the existing constants):

```typescript
function shouldEmitInvariantsForClass(keepContracts: KeepContracts): boolean {
  return keepContracts === false || keepContracts === 'invariant' || keepContracts === 'all';
}
```

- [ ] **Step 3: Add `keepContracts` to `rewriteMember`**

`rewriteMember` currently ends with `allowIdentifiers: string[] = []`. Add `keepContracts: KeepContracts = false` as the last param and pass it to `tryRewriteFunction`:

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
  keepContracts: KeepContracts = false,
): { element: typescript.ClassElement; changed: boolean } {
  if (typescript.isMethodDeclaration(member) && isPublicTarget(member)) {
    const ifaceMethodContracts = lookupIfaceMethodContracts(
      member, reparsedIndex, interfaceContracts, className, warn,
    );
    const rewritten = tryRewriteFunction(
      factory, member, reparsedIndex.functions, transformed, warn,
      checker, effectiveInvariants, ifaceMethodContracts, allowIdentifiers, keepContracts,
    );
    return {
      element: rewritten as typescript.MethodDeclaration,
      changed: rewritten !== member,
    };
  }
  if (typescript.isConstructorDeclaration(member)) {
    const rewritten = rewriteConstructor(
      factory, member, className, reparsedIndex,
      effectiveInvariants, warn, checker, allowIdentifiers,
    );
    return { element: rewritten, changed: rewritten !== member };
  }
  return { element: member, changed: false };
}
```

- [ ] **Step 4: Add `keepContracts` to `rewriteMembers` and forward it**

`rewriteMembers` currently ends with `allowIdentifiers: string[] = []`. Add `keepContracts: KeepContracts = false` and pass it to `rewriteMember`:

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
  keepContracts: KeepContracts = false,
): { elements: typescript.ClassElement[]; changed: boolean } {
  let classTransformed = false;
  const newMembers: typescript.ClassElement[] = [];

  members.forEach((member) => {
    const result = rewriteMember(
      factory, member, reparsedIndex, transformed, warn, checker,
      effectiveInvariants, className, interfaceContracts, allowIdentifiers, keepContracts,
    );
    if (result.changed) {
      classTransformed = true;
    }
    newMembers.push(result.element);
  });

  return { elements: newMembers, changed: classTransformed };
}
```

- [ ] **Step 5: Add `keepContracts` to `rewriteClass` and gate invariants**

`rewriteClass` currently ends with `allowIdentifiers: string[] = []`. Add `keepContracts: KeepContracts = false`. Then:

1. Pass `keepContracts` to `rewriteMembers`.
2. Gate the `effectiveInvariants` passed into `rewriteMembers` and the `buildCheckInvariantsMethod` injection on `shouldEmitInvariantsForClass`:

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
  keepContracts: KeepContracts = false,
): typescript.ClassDeclaration {
  const className = node.name?.text ?? 'UnknownClass';

  emitClassBodyWarning(node, reparsedIndex, className, warn);

  if (checker === undefined && hasImplementsClauses(node)) {
    warn(
      `[axiom] Interface contract resolution skipped in ${node.getSourceFile().fileName}:`
      + '\n  no TypeChecker available (transpileModule mode)'
      + ' — class-level contracts unaffected',
    );
  }

  const interfaceContracts: InterfaceContracts = checker !== undefined
    ? resolveInterfaceContracts(node, checker, cache, warn, mode)
    : { methods: new Map(), invariants: [] };

  const reparsedClass = reparsedIndex.classes.get(node.pos) ?? node;
  const allInvariants = resolveEffectiveInvariants(
    node, reparsedClass, className, warn, interfaceContracts.invariants,
  );
  const effectiveInvariants = shouldEmitInvariantsForClass(keepContracts)
    ? allInvariants
    : [];

  const { elements: newMembers, changed: classTransformed } = rewriteMembers(
    factory, node.members, reparsedIndex, transformed, warn, checker,
    effectiveInvariants, className, interfaceContracts, allowIdentifiers, keepContracts,
  );

  const finalMembers = [...newMembers];
  let finalTransformed = classTransformed;

  if (effectiveInvariants.length > 0) {
    finalMembers.push(buildCheckInvariantsMethod(effectiveInvariants, factory));
    finalTransformed = true;
  }

  if (!finalTransformed) {
    return node;
  }

  transformed.value = true;
  return factory.updateClassDeclaration(
    node,
    typescript.getModifiers(node),
    node.name,
    node.typeParameters,
    node.heritageClauses,
    finalMembers,
  );
}
```

- [ ] **Step 6: Add `keepContracts` to `tryRewriteClass` and forward it**

`tryRewriteClass` currently ends with `allowIdentifiers: string[] = []`. Add `keepContracts: KeepContracts = false`:

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
  keepContracts: KeepContracts = false,
): typescript.ClassDeclaration {
  try {
    return rewriteClass(
      factory, node, reparsedIndex, transformed, warn,
      checker, cache, mode, allowIdentifiers, keepContracts,
    );
  } catch {
    return node;
  }
}
```

- [ ] **Step 7: Run typecheck — expect clean**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Run the failing tests — confirm they now pass**

Run: `npm test -- --testPathPattern="transformer" --testNamePattern="keepContracts with class invariants" --no-coverage`
Expected: both tests pass.

- [ ] **Step 9: Run the full test suite**

Run: `npm test`
Expected: all tests pass, coverage threshold met.

- [ ] **Step 10: Lint**

Run: `npm run lint`
Expected: no errors. Fix any `id-length`, `complexity`, or `max-len` violations.

- [ ] **Step 11: Commit**

```bash
git add src/transformer.ts src/class-rewriter.ts test/helpers.ts test/transformer.test.ts
git commit -m "feat: thread keepContracts through transformer and class-rewriter"
```
