# Class Inheritance — Task 2: Implement `resolveBaseClassContracts` — method contract extraction

State: not started

> **Sequence:** This is step 2 of 8. Task 1 must be complete before starting this task.
> **For agentic workers:** Use `superpowers:executing-plans` to implement this task.

## Context

We are propagating `@pre`, `@post`, and `@invariant` contracts from a base class to its direct
subclasses via the `extends` clause.

**What previous tasks added (already in the codebase):**

- Task 1: `BaseClassContracts` type, `findClassByPos` helper, stub `resolveBaseClassContracts`
  export in `src/interface-resolver.ts`.

**What this task does:**

- Adds `findBaseClassMethodParams` helper to `src/interface-resolver.ts`.
- Adds `extractBaseMethodContracts` helper (mirrors `extractMethodContracts` but for
  `MethodDeclaration` in a `ClassDeclaration`).
- Adds `processBaseClassDeclaration` helper.
- Replaces the stub body of `resolveBaseClassContracts` with the full implementation that walks
  the `ExtendsKeyword` heritage clause and extracts method contracts and invariants.

**Files changed in this task:**

- `src/interface-resolver.ts`
- `test/interface-resolver.test.ts`

---

## ESLint constraints (read before touching any `src/` file)

- `id-length: min 3` — no identifiers shorter than 3 characters.
- No bare `return;` — restructure with guards.
- `complexity: 10` — extract helpers when functions grow.
- `max-len: 100` — lines under 100 chars.
- No `console` — use the injectable `warn` callback.

---

## Steps

- [ ] **Step 1: Write failing unit tests for contract extraction**

Add to the `resolveBaseClassContracts` describe block in `test/interface-resolver.test.ts`:

```typescript
it('returns @pre and @post from base class method when subclass overrides it', () => {
  const source = `
    class Animal {
      /**
       * @pre amount > 0
       * @post this.energy > 0
       */
      feed(amount: number): void {}
    }
    class Dog extends Animal {
      feed(amount: number): void {}
    }
  `;
  // Dog.feed should receive both tags
  const warnings: string[] = [];
  const output = transformWithProgram(source, (msg) => warnings.push(msg));
  expect(output).toContain('amount > 0');
  expect(output).toContain('this.energy > 0');
});

it('returns base class @invariant tags', () => {
  const source = `
    class Animal {
      energy = 0;
      /** @invariant this.energy >= 0 */
    }
    class Dog extends Animal {
      energy = 0;
    }
  `;
  const warnings: string[] = [];
  const output = transformWithProgram(source, (msg) => warnings.push(msg));
  expect(output).toContain('this.energy >= 0');
});
```

- [ ] **Step 2: Run to confirm they fail**

```bash
npx jest --testPathPattern="interface-resolver" -t "resolveBaseClassContracts" --no-coverage
```

Expected: FAILs — stub returns empty.

- [ ] **Step 3: Add `findBaseClassMethodParams` helper**

After `findClassByPos`, add:

```typescript
function findBaseClassMethodParams(
  classDecl: typescript.ClassDeclaration,
  methodName: string,
): string[] {
  const method = Array.from(classDecl.members).find(
    (member): member is typescript.MethodDeclaration =>
      typescript.isMethodDeclaration(member) &&
      typescript.isIdentifier(member.name) &&
      member.name.text === methodName,
  );
  if (method === undefined) {
    return [];
  }
  return Array.from(method.parameters).map((param) =>
    typescript.isIdentifier(param.name) ? param.name.text : '',
  );
}
```

- [ ] **Step 4: Add `extractBaseMethodContracts` helper**

After `findBaseClassMethodParams`, add:

```typescript
function extractBaseMethodContracts(
  baseClassNode: typescript.ClassDeclaration,
  methodName: string,
  subclassParams: string[],
  mode: ParamMismatchMode,
  baseName: string,
  location: string,
  warn: (msg: string) => void,
): InterfaceMethodContracts | undefined {
  const baseMethod = Array.from(baseClassNode.members).find(
    (member): member is typescript.MethodDeclaration =>
      typescript.isMethodDeclaration(member) &&
      typescript.isIdentifier(member.name) &&
      member.name.text === methodName,
  );
  if (baseMethod === undefined) {
    return undefined;
  }

  const baseParams = findBaseClassMethodParams(baseClassNode, methodName);
  if (baseParams.length !== subclassParams.length) {
    warn(
      `[axiom] Parameter count mismatch in ${location}:`
      + `\n  base class ${baseName} has ${baseParams.length} parameters,`
      + ` subclass has ${subclassParams.length} — base class contracts skipped`,
    );
    return { preTags: [], postTags: [], sourceInterface: baseName };
  }

  const { renameMap, shouldSkip } = handleParamMismatch(
    baseName, location, baseParams, subclassParams, mode, warn,
  );
  if (shouldSkip) {
    return { preTags: [], postTags: [], sourceInterface: baseName };
  }

  const hasMismatch = renameMap.size > 0;
  const allTags = extractContractTagsFromNode(baseMethod);
  const preTags = allTags.filter((tag) => tag.kind === KIND_PRE);
  const postTags = allTags.filter((tag) => tag.kind === KIND_POST);

  let prevExpr = extractPrevExpression(baseMethod);
  if (hasMismatch && mode === MODE_RENAME && prevExpr !== undefined) {
    prevExpr = renameIdentifiersInExpression(prevExpr, renameMap);
  }

  return buildContractsResult(
    preTags, postTags, prevExpr, renameMap, hasMismatch, mode, baseName,
  );
}
```

Note: `handleParamMismatch` formats its warning as `interface ${ifaceName}:` — for base class use
the same helper; the warning text will say `interface Animal:`. This is acceptable for this
iteration.

- [ ] **Step 5: Add `processBaseClassDeclaration` helper**

After `extractBaseMethodContracts`, add:

```typescript
function processBaseClassDeclaration(
  decl: typescript.ClassDeclaration,
  classNode: typescript.ClassDeclaration,
  cache: Map<string, typescript.SourceFile>,
  warn: (msg: string) => void,
  mode: ParamMismatchMode,
  className: string,
  result: BaseClassContracts,
): void {
  const baseName = decl.name?.text ?? 'UnknownBase';
  const reparsed = reparseCached(decl.getSourceFile(), cache);
  const reparsedBase = findClassByPos(reparsed, decl.pos);
  if (reparsedBase === undefined) {
    return;
  }

  const baseInvariants = extractInvariantExpressions(reparsedBase);
  result.invariants.push(...baseInvariants);

  classNode.members.forEach((member) => {
    const isMethod = typescript.isMethodDeclaration(member);
    const hasIdentifierName = isMethod && typescript.isIdentifier(member.name);
    if (!isMethod || !hasIdentifierName) {
      return;
    }
    const methodName = member.name.text;
    const subclassParams = getClassMethodParams(member);
    const location = `${className}.${methodName}`;
    const methodContracts = extractBaseMethodContracts(
      reparsedBase, methodName, subclassParams, mode, baseName, location, warn,
    );
    if (methodContracts !== undefined) {
      result.methods.set(
        methodName,
        mergeMethodContracts(result.methods.get(methodName), methodContracts),
      );
    }
  });
}
```

- [ ] **Step 6: Replace the stub body of `resolveBaseClassContracts` with full implementation**

```typescript
export function resolveBaseClassContracts(
  classNode: typescript.ClassDeclaration,
  checker: typescript.TypeChecker,
  cache: Map<string, typescript.SourceFile>,
  warn: (msg: string) => void,
  mode: ParamMismatchMode,
): BaseClassContracts {
  const result: BaseClassContracts = {
    methods: new Map(),
    invariants: [],
  };
  const className = classNode.name?.text ?? 'UnknownClass';

  const heritageClauses = classNode.heritageClauses ?? [];
  heritageClauses.forEach((clause) => {
    if (clause.token === typescript.SyntaxKind.ExtendsKeyword) {
      clause.types.forEach((typeRef) => {
        const baseType = checker.getTypeAtLocation(typeRef.expression);
        const declarations = baseType.symbol?.declarations;
        if (declarations !== undefined) {
          declarations.forEach((decl) => {
            if (typescript.isClassDeclaration(decl)) {
              processBaseClassDeclaration(
                decl, classNode, cache, warn, mode, className, result,
              );
            }
          });
        }
      });
    }
  });

  return result;
}
```

- [ ] **Step 7: Run failing tests to confirm they now pass**

```bash
npx jest --testPathPattern="interface-resolver" -t "resolveBaseClassContracts" --no-coverage
```

Expected: all cases pass.

- [ ] **Step 8: Run full suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 9: Run lint and typecheck**

```bash
npm run lint && npm run typecheck
```

Expected: no errors.

---

## Done when

- `npm test` exits 0 with no regressions.
- `npm run lint && npm run typecheck` exit 0.
- `resolveBaseClassContracts` extracts `@pre`/`@post` from the base class method and `@invariant`
  from the base class body.
- Contract-extraction tests pass.
