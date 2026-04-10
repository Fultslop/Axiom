# Interface Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the transformer to read `@pre`, `@post`, and `@invariant` tags from TypeScript interface declarations and inject them into every implementing class — enabling true design-by-contract.

**Architecture:** A new `interface-resolver.ts` module uses the TypeChecker to locate interface declarations cross-file, re-parses their source files (cached per compilation), and returns merged `InterfaceContracts`. `class-rewriter.ts` calls the resolver and prepends interface tags to class-level tags before injection. `function-rewriter.ts` gains an optional `interfaceMethodContracts` parameter.

**Tech Stack:** TypeScript compiler API (`typescript.TypeChecker`, `typescript.transform`, `typescript.createPrinter`), Jest 130 tests must stay green after every task, ESLint constraints: `id-length >= 3`, `max-len: 100`, `complexity <= 10`, no bare `return;`, no `console`.

---

## ESLint Constraints (read before touching any `src/` file)

- **`id-length: min 3`** — No identifiers shorter than 3 characters.
- **No bare `return;`** — restructure with guards.
- **`complexity: 10`** — extract helpers when functions grow.
- **`max-len: 100`** — lines under 100 chars.
- **No `console`** — use the injectable `warn` callback.

---

## File Map (target state)

| File | Change | Responsibility |
| :--- | :--- | :--- |
| `src/jsdoc-parser.ts` | **Modify** | Add `extractContractTagsFromNode(node: ts.Node)` — generalises tag extraction to work on `MethodSignature` |
| `src/interface-resolver.ts` | **Create** | `resolveInterfaceContracts` — TypeChecker lookup, re-parse cache, param rename, contract extraction |
| `src/function-rewriter.ts` | **Modify** | Accept `interfaceMethodContracts?` param; prepend interface tags to class tags |
| `src/class-rewriter.ts` | **Modify** | Call resolver, merge invariants, emit merge/no-checker warnings |
| `src/transformer.ts` | **Modify** | Add `interfaceParamMismatch` option; create `reparsedCache`; thread into `tryRewriteClass` |
| `test/interface-resolver.test.ts` | **Create** | Unit tests for the resolver (rename, count mismatch, cross-file) |
| `test/transformer.test.ts` | **Modify** | Tests for merge warnings and no-checker warning |
| `test/acceptance.test.ts` | **Modify** | Runtime verification: interface `@pre`/`@post`/`@invariant` fire correctly |

---

## Task 1: Generalise tag extraction in `jsdoc-parser.ts`

`extractContractTags` currently requires a `FunctionLikeDeclaration`, but interface `MethodSignature` nodes are not `FunctionLikeDeclaration`. Expose a node-agnostic variant.

**Files:**
- Modify: `src/jsdoc-parser.ts`
- Test: `test/jsdoc-parser.test.ts`

- [ ] **Step 1.1: Confirm green baseline**

```bash
npm test
```

Expected: `Tests: 130 passed, 130 total`

- [ ] **Step 1.2: Write the failing test**

Add to `test/jsdoc-parser.test.ts`:

```typescript
import typescript from 'typescript';
import { extractContractTagsFromNode } from '@src/jsdoc-parser';

describe('extractContractTagsFromNode', () => {
  it('extracts @pre tags from a MethodSignature node', () => {
    const source = `
      interface IFoo {
        /** @pre amount > 0 */
        bar(amount: number): void;
      }
    `;
    const sourceFile = typescript.createSourceFile(
      'test.ts', source, typescript.ScriptTarget.ES2020, true,
    );
    const iface = sourceFile.statements[0] as typescript.InterfaceDeclaration;
    const sig = iface.members[0] as typescript.MethodSignature;
    const tags = extractContractTagsFromNode(sig);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toEqual({ kind: 'pre', expression: 'amount > 0' });
  });

  it('returns empty array when no contract tags present', () => {
    const source = `
      interface IFoo {
        /** @param amount the amount */
        bar(amount: number): void;
      }
    `;
    const sourceFile = typescript.createSourceFile(
      'test.ts', source, typescript.ScriptTarget.ES2020, true,
    );
    const iface = sourceFile.statements[0] as typescript.InterfaceDeclaration;
    const sig = iface.members[0] as typescript.MethodSignature;
    expect(extractContractTagsFromNode(sig)).toHaveLength(0);
  });
});
```

- [ ] **Step 1.3: Run to confirm it fails**

```bash
npm test -- --testPathPattern jsdoc-parser
```

Expected: FAIL — `extractContractTagsFromNode` is not exported.

- [ ] **Step 1.4: Implement `extractContractTagsFromNode` in `src/jsdoc-parser.ts`**

Replace the body of `extractContractTags` with a delegation to the new function:

```typescript
export function extractContractTagsFromNode(node: typescript.Node): ContractTag[] {
  const jsDocTags = typescript.getJSDocTags(node);
  const result: ContractTag[] = [];
  for (const tag of jsDocTags) {
    const kind = toContractKind(tag.tagName.text.toLowerCase());
    if (kind !== undefined) {
      const expression = resolveTagComment(tag.comment);
      if (expression.length > 0) {
        result.push({ kind, expression });
      }
    }
  }
  return result;
}

export function extractContractTags(
  node: typescript.FunctionLikeDeclaration,
): ContractTag[] {
  return extractContractTagsFromNode(node);
}
```

- [ ] **Step 1.5: Run tests to confirm they pass**

```bash
npm test
```

Expected: `Tests: 132 passed, 132 total`

- [ ] **Step 1.6: Commit**

```bash
git add src/jsdoc-parser.ts test/jsdoc-parser.test.ts
git commit -m "feat: add extractContractTagsFromNode for MethodSignature support"
```

---

## Task 2: Create `src/interface-resolver.ts` — types and `renameIdentifiersInExpression`

Build the foundation: exported types and the expression-rename utility (used in Task 3).

**Files:**
- Create: `src/interface-resolver.ts`
- Create: `test/interface-resolver.test.ts`

- [ ] **Step 2.1: Write the failing tests**

Create `test/interface-resolver.test.ts`:

```typescript
import typescript from 'typescript';
import {
  resolveInterfaceContracts,
  type ParamMismatchMode,
  type InterfaceContracts,
} from '@src/interface-resolver';

// Helper: build a single-file Program with TypeChecker
function buildProgram(fileName: string, source: string): typescript.Program {
  const options: typescript.CompilerOptions = {
    target: typescript.ScriptTarget.ES2020,
    module: typescript.ModuleKind.CommonJS,
    skipLibCheck: true,
  };
  const defaultHost = typescript.createCompilerHost(options);
  const host: typescript.CompilerHost = {
    ...defaultHost,
    getSourceFile(name, version) {
      if (name === fileName) {
        return typescript.createSourceFile(name, source, version, true);
      }
      return defaultHost.getSourceFile(name, version);
    },
    fileExists: (name) => name === fileName || defaultHost.fileExists(name),
    readFile: (name) => (name === fileName ? source : defaultHost.readFile(name)),
  };
  return typescript.createProgram([fileName], options, host);
}

// Helper: build a multi-file Program with TypeChecker
function buildMultiFileProgram(
  files: Record<string, string>,
): typescript.Program {
  const options: typescript.CompilerOptions = {
    target: typescript.ScriptTarget.ES2020,
    module: typescript.ModuleKind.CommonJS,
    skipLibCheck: true,
  };
  const defaultHost = typescript.createCompilerHost(options);
  const host: typescript.CompilerHost = {
    ...defaultHost,
    getSourceFile(name, version) {
      if (name in files) {
        return typescript.createSourceFile(name, files[name], version, true);
      }
      return defaultHost.getSourceFile(name, version);
    },
    fileExists: (name) => name in files || defaultHost.fileExists(name),
    readFile: (name) => files[name] ?? defaultHost.readFile(name),
  };
  return typescript.createProgram(Object.keys(files), options, host);
}

function getClassDecl(
  program: typescript.Program,
  fileName: string,
): typescript.ClassDeclaration {
  const sourceFile = program.getSourceFile(fileName)!;
  const decl = sourceFile.statements.find(typescript.isClassDeclaration);
  if (decl === undefined) throw new Error(`No class found in ${fileName}`);
  return decl;
}

function runResolver(
  program: typescript.Program,
  fileName: string,
  mode: ParamMismatchMode = 'rename',
): { contracts: InterfaceContracts; warnings: string[] } {
  const checker = program.getTypeChecker();
  const classDecl = getClassDecl(program, fileName);
  const cache = new Map<string, typescript.SourceFile>();
  const warnings: string[] = [];
  const contracts = resolveInterfaceContracts(
    classDecl, checker, cache, (msg) => warnings.push(msg), mode,
  );
  return { contracts, warnings };
}

describe('resolveInterfaceContracts — basic extraction', () => {
  it('returns empty contracts when class has no implements clause', () => {
    const program = buildProgram('test.ts', `
      class Foo { bar(amount: number): void {} }
    `);
    const { contracts, warnings } = runResolver(program, 'test.ts');
    expect(contracts.methods.size).toBe(0);
    expect(contracts.invariants).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('extracts @pre tags from a same-file interface', () => {
    const program = buildProgram('test.ts', `
      interface IFoo {
        /** @pre amount > 0 */
        bar(amount: number): number;
      }
      class Foo implements IFoo {
        bar(amount: number): number { return amount; }
      }
    `);
    const { contracts, warnings } = runResolver(program, 'test.ts');
    expect(contracts.methods.get('bar')?.preTags).toHaveLength(1);
    expect(contracts.methods.get('bar')?.preTags[0].expression).toBe('amount > 0');
    expect(warnings).toHaveLength(0);
  });

  it('extracts @post tags from a same-file interface', () => {
    const program = buildProgram('test.ts', `
      interface IFoo {
        /** @post result > 0 */
        bar(amount: number): number;
      }
      class Foo implements IFoo {
        bar(amount: number): number { return amount; }
      }
    `);
    const { contracts, warnings } = runResolver(program, 'test.ts');
    expect(contracts.methods.get('bar')?.postTags).toHaveLength(1);
    expect(contracts.methods.get('bar')?.postTags[0].expression).toBe('result > 0');
  });

  it('extracts @invariant expressions from a same-file interface', () => {
    const program = buildProgram('test.ts', `
      /** @invariant this.balance >= 0 */
      interface IFoo {
        bar(): void;
      }
      class Foo implements IFoo {
        balance = 0;
        bar(): void {}
      }
    `);
    const { contracts } = runResolver(program, 'test.ts');
    expect(contracts.invariants).toContain('this.balance >= 0');
  });
});

describe('resolveInterfaceContracts — parameter name mismatch', () => {
  it('renames expression identifiers when param names differ (rename mode)', () => {
    const program = buildProgram('test.ts', `
      interface IFoo {
        /** @pre amount > 0 */
        bar(amount: number): number;
      }
      class Foo implements IFoo {
        bar(value: number): number { return value; }
      }
    `);
    const { contracts, warnings } = runResolver(program, 'test.ts', 'rename');
    expect(contracts.methods.get('bar')?.preTags[0].expression).toBe('value > 0');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('renamed');
  });

  it('drops method contracts when param names differ (ignore mode)', () => {
    const program = buildProgram('test.ts', `
      interface IFoo {
        /** @pre amount > 0 */
        bar(amount: number): number;
      }
      class Foo implements IFoo {
        bar(value: number): number { return value; }
      }
    `);
    const { contracts, warnings } = runResolver(program, 'test.ts', 'ignore');
    expect(contracts.methods.get('bar')?.preTags).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('skipped');
  });

  it('skips all interface contracts for method when param counts differ', () => {
    const program = buildProgram('test.ts', `
      interface IFoo {
        /** @pre amount > 0 */
        bar(amount: number, extra: number): number;
      }
      class Foo implements IFoo {
        bar(amount: number): number { return amount; }
      }
    `);
    const { contracts, warnings } = runResolver(program, 'test.ts');
    expect(contracts.methods.get('bar')?.preTags).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Parameter count mismatch');
  });
});

describe('resolveInterfaceContracts — cross-file', () => {
  it('extracts @pre tags from an interface in a separate file', () => {
    const program = buildMultiFileProgram({
      'iface.ts': `
        export interface IBankAccount {
          /** @pre amount > 0 */
          withdraw(amount: number): number;
        }
      `,
      'bank.ts': `
        import type { IBankAccount } from './iface';
        class BankAccount implements IBankAccount {
          withdraw(amount: number): number { return 0; }
        }
      `,
    });
    const { contracts, warnings } = runResolver(program, 'bank.ts');
    expect(contracts.methods.get('withdraw')?.preTags).toHaveLength(1);
    expect(contracts.methods.get('withdraw')?.preTags[0].expression).toBe('amount > 0');
    expect(warnings).toHaveLength(0);
  });
});
```

- [ ] **Step 2.2: Run to confirm it fails**

```bash
npm test -- --testPathPattern interface-resolver
```

Expected: FAIL — module not found.

- [ ] **Step 2.3: Create `src/interface-resolver.ts` with types and stubs**

```typescript
import typescript from 'typescript';
import { parseContractExpression } from './ast-builder';
import {
  extractContractTagsFromNode, extractInvariantExpressions,
} from './jsdoc-parser';
import type { ContractTag } from './jsdoc-parser';

export type ParamMismatchMode = 'rename' | 'ignore';

export interface InterfaceMethodContracts {
  preTags: ContractTag[];
  postTags: ContractTag[];
  sourceInterface: string;
}

export interface InterfaceContracts {
  methods: Map<string, InterfaceMethodContracts>;
  invariants: string[];
}

function reparseCached(
  sourceFile: typescript.SourceFile,
  cache: Map<string, typescript.SourceFile>,
): typescript.SourceFile {
  const cached = cache.get(sourceFile.fileName);
  if (cached !== undefined) {
    return cached;
  }
  const reparsed = typescript.createSourceFile(
    sourceFile.fileName,
    sourceFile.text,
    sourceFile.languageVersion,
    true,
  );
  cache.set(sourceFile.fileName, reparsed);
  return reparsed;
}

function buildRenameMap(
  ifaceParams: string[],
  classParams: string[],
): Map<string, string> {
  const renameMap = new Map<string, string>();
  ifaceParams.forEach((ifaceParam, idx) => {
    const classParam = classParams[idx];
    if (
      ifaceParam.length > 0 &&
      classParam !== undefined &&
      ifaceParam !== classParam
    ) {
      renameMap.set(ifaceParam, classParam);
    }
  });
  return renameMap;
}

function renameIdentifiersInExpression(
  expression: string,
  renameMap: Map<string, string>,
): string {
  const parsed = parseContractExpression(expression);
  const transformResult = typescript.transform(parsed, [
    (context: typescript.TransformationContext) => {
      const { factory } = context;
      function visit(node: typescript.Node): typescript.Node {
        if (typescript.isIdentifier(node)) {
          const newName = renameMap.get(node.text);
          if (newName !== undefined) {
            return factory.createIdentifier(newName);
          }
        }
        return typescript.visitEachChild(node, visit, context);
      }
      return (root: typescript.Expression) =>
        typescript.visitNode(root, visit) as typescript.Expression;
    },
  ]);
  const renamed = transformResult.transformed[0];
  const printer = typescript.createPrinter({
    newLine: typescript.NewLineKind.LineFeed,
  });
  const dummyFile = typescript.createSourceFile(
    'dummy.ts', '', typescript.ScriptTarget.ES2020, false,
  );
  return printer.printNode(typescript.EmitHint.Expression, renamed, dummyFile);
}

function findInterfaceByPos(
  sourceFile: typescript.SourceFile,
  pos: number,
): typescript.InterfaceDeclaration | undefined {
  let found: typescript.InterfaceDeclaration | undefined;
  function visit(node: typescript.Node): void {
    if (typescript.isInterfaceDeclaration(node) && node.pos === pos) {
      found = node;
      return;
    }
    typescript.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

function getClassMethodParams(
  member: typescript.MethodDeclaration,
): string[] {
  return Array.from(member.parameters).map((param) =>
    typescript.isIdentifier(param.name) ? param.name.text : '',
  );
}

function getInterfaceMethodParams(
  sig: typescript.MethodSignature,
): string[] {
  return Array.from(sig.parameters).map((param) =>
    typescript.isIdentifier(param.name) ? param.name.text : '',
  );
}

function applyRenameToTags(
  tags: ContractTag[],
  renameMap: Map<string, string>,
): ContractTag[] {
  return tags.map((tag) => ({
    ...tag,
    expression: renameIdentifiersInExpression(tag.expression, renameMap),
  }));
}

function extractMethodContracts(
  interfaceNode: typescript.InterfaceDeclaration,
  methodName: string,
  classParams: string[],
  mode: ParamMismatchMode,
  ifaceName: string,
  location: string,
  warn: (msg: string) => void,
): InterfaceMethodContracts | undefined {
  const sig = Array.from(interfaceNode.members).find(
    (member): member is typescript.MethodSignature =>
      typescript.isMethodSignature(member) &&
      typescript.isIdentifier(member.name) &&
      member.name.text === methodName,
  );
  if (sig === undefined) {
    return undefined;
  }

  const ifaceParams = getInterfaceMethodParams(sig);

  if (ifaceParams.length !== classParams.length) {
    warn(
      `[axiom] Parameter count mismatch in ${location}:`
      + `\n  interface ${ifaceName} has ${ifaceParams.length} parameters,`
      + ` class has ${classParams.length} — interface contracts skipped`,
    );
    return { preTags: [], postTags: [], sourceInterface: ifaceName };
  }

  const renameMap = buildRenameMap(ifaceParams, classParams);
  const hasMismatch = renameMap.size > 0;

  if (hasMismatch) {
    const pairs = Array.from(renameMap.entries())
      .map(([from, to]) => `'${from}' → '${to}'`)
      .join(', ');
    const action = mode === 'rename' ? 'expression renamed' : 'contract skipped';
    warn(
      `[axiom] Parameter name mismatch in ${location}:`
      + `\n  interface ${ifaceName}: ${pairs} — ${action}`,
    );
    if (mode === 'ignore') {
      return { preTags: [], postTags: [], sourceInterface: ifaceName };
    }
  }

  const allTags = extractContractTagsFromNode(sig);
  const preTags = allTags.filter((tag) => tag.kind === 'pre');
  const postTags = allTags.filter((tag) => tag.kind === 'post');

  if (hasMismatch && mode === 'rename') {
    return {
      preTags: applyRenameToTags(preTags, renameMap),
      postTags: applyRenameToTags(postTags, renameMap),
      sourceInterface: ifaceName,
    };
  }

  return { preTags, postTags, sourceInterface: ifaceName };
}

function mergeMethodContracts(
  existing: InterfaceMethodContracts | undefined,
  incoming: InterfaceMethodContracts,
): InterfaceMethodContracts {
  if (existing === undefined) {
    return { ...incoming };
  }
  return {
    preTags: [...existing.preTags, ...incoming.preTags],
    postTags: [...existing.postTags, ...incoming.postTags],
    sourceInterface: existing.sourceInterface,
  };
}

function processInterfaceDeclaration(
  decl: typescript.InterfaceDeclaration,
  classNode: typescript.ClassDeclaration,
  cache: Map<string, typescript.SourceFile>,
  warn: (msg: string) => void,
  mode: ParamMismatchMode,
  className: string,
  result: InterfaceContracts,
): void {
  const ifaceName = decl.name.text;
  const reparsed = reparseCached(decl.getSourceFile(), cache);
  const reparsedIface = findInterfaceByPos(reparsed, decl.pos);
  if (reparsedIface === undefined) {
    return;
  }

  const ifaceInvariants = extractInvariantExpressions(reparsedIface);
  result.invariants.push(...ifaceInvariants);

  for (const member of classNode.members) {
    if (
      !typescript.isMethodDeclaration(member) ||
      !typescript.isIdentifier(member.name)
    ) {
      continue;
    }
    const methodName = member.name.text;
    const classParams = getClassMethodParams(member);
    const location = `${className}.${methodName}`;
    const methodContracts = extractMethodContracts(
      reparsedIface, methodName, classParams, mode, ifaceName, location, warn,
    );
    if (methodContracts !== undefined) {
      result.methods.set(
        methodName,
        mergeMethodContracts(result.methods.get(methodName), methodContracts),
      );
    }
  }
}

function processImplementedInterface(
  typeExpr: typescript.Expression,
  classNode: typescript.ClassDeclaration,
  checker: typescript.TypeChecker,
  cache: Map<string, typescript.SourceFile>,
  warn: (msg: string) => void,
  mode: ParamMismatchMode,
  className: string,
  result: InterfaceContracts,
): void {
  const ifaceType = checker.getTypeAtLocation(typeExpr);
  const declarations = ifaceType.symbol?.declarations;
  if (declarations === undefined) {
    return;
  }
  for (const decl of declarations) {
    if (!typescript.isInterfaceDeclaration(decl)) {
      continue;
    }
    processInterfaceDeclaration(decl, classNode, cache, warn, mode, className, result);
  }
}

export function resolveInterfaceContracts(
  classNode: typescript.ClassDeclaration,
  checker: typescript.TypeChecker,
  cache: Map<string, typescript.SourceFile>,
  warn: (msg: string) => void,
  mode: ParamMismatchMode,
): InterfaceContracts {
  const result: InterfaceContracts = {
    methods: new Map<string, InterfaceMethodContracts>(),
    invariants: [],
  };
  const className = classNode.name?.text ?? 'UnknownClass';

  for (const clause of classNode.heritageClauses ?? []) {
    if (clause.token !== typescript.SyntaxKind.ImplementsKeyword) {
      continue;
    }
    for (const typeRef of clause.types) {
      processImplementedInterface(
        typeRef.expression, classNode, checker, cache,
        warn, mode, className, result,
      );
    }
  }

  return result;
}
```

- [ ] **Step 2.4: Run tests to confirm they pass**

```bash
npm test
```

Expected: all previously passing tests still pass, plus new `interface-resolver` tests.

- [ ] **Step 2.5: Commit**

```bash
git add src/interface-resolver.ts test/interface-resolver.test.ts
git commit -m "feat: add interface-resolver module with cross-file contract extraction"
```

---

## Task 3: Extend `function-rewriter.ts` to accept interface method tags

`rewriteFunction` currently extracts only the class method's own tags. Add an optional `interfaceMethodContracts` parameter so the caller can supply pre-resolved interface tags, which are prepended before the class's own tags.

**Files:**
- Modify: `src/function-rewriter.ts`
- Test: `test/transformer.test.ts`

- [ ] **Step 3.1: Write the failing test**

Add to `test/transformer.test.ts` in the existing `describe('transformer')` block. Use the existing `transformWithProgram` helper (already defined in that file):

```typescript
it('injects @pre from interface when class has no own @pre', () => {
  const source = `
    interface IFoo {
      /** @pre amount > 0 */
      bar(amount: number): number;
    }
    class Foo implements IFoo {
      bar(amount: number): number { return amount; }
    }
  `;
  const output = transformWithProgram(source);
  expect(output).toContain('ContractViolationError');
  expect(output).toContain('amount > 0');
});

it('does not inject contracts when interface has none', () => {
  const source = `
    interface IFoo {
      bar(amount: number): number;
    }
    class Foo implements IFoo {
      bar(amount: number): number { return amount; }
    }
  `;
  const output = transformWithProgram(source);
  expect(output).not.toContain('ContractViolationError');
});
```

- [ ] **Step 3.2: Run to confirm it fails**

```bash
npm test -- --testPathPattern transformer
```

Expected: FAIL — interface contracts not injected yet.

- [ ] **Step 3.3: Add `interfaceMethodContracts` parameter to `function-rewriter.ts`**

Add the import at the top of `src/function-rewriter.ts`:

```typescript
import type { InterfaceMethodContracts } from './interface-resolver';
```

Update `rewriteFunction` signature and body (add the new parameter and prepend logic):

```typescript
function rewriteFunction(
  factory: typescript.NodeFactory,
  node: typescript.FunctionLikeDeclaration,
  reparsedFunctions: Map<number, typescript.FunctionLikeDeclaration>,
  warn: (msg: string) => void,
  checker?: typescript.TypeChecker,
  invariantExpressions: string[] = [],
  interfaceMethodContracts?: InterfaceMethodContracts,
): typescript.FunctionLikeDeclaration | null {
  const originalBody = node.body;
  if (!originalBody || !typescript.isBlock(originalBody)) {
    return null;
  }

  const reparsedNode = reparsedFunctions.get(node.pos) ?? node;
  const classTags = extractContractTags(reparsedNode);

  const location = buildLocationName(node);
  const preKnown = buildKnownIdentifiers(node, false);
  const postKnown = buildKnownIdentifiers(node, true);
  const paramTypes = checker !== undefined ? buildParameterTypes(node, checker) : undefined;
  const postParamTypes = buildPostParamTypes(node, checker, paramTypes);

  const allPreInput = [
    ...(interfaceMethodContracts?.preTags ?? []),
    ...classTags.filter((tag) => tag.kind === KIND_PRE),
  ];
  const allPostInput = [
    ...(interfaceMethodContracts?.postTags ?? []),
    ...classTags.filter((tag) => tag.kind === KIND_POST),
  ];

  const preTags = filterValidTags(
    allPreInput, KIND_PRE, location, warn, preKnown, paramTypes,
  );
  const postTags = filterValidTags(
    allPostInput, KIND_POST, location, warn, postKnown, postParamTypes,
  );

  const invariantCall = buildInvariantCallIfNeeded(
    factory, node, location, invariantExpressions,
  );

  if (preTags.length === 0 && postTags.length === 0 && invariantCall === null) {
    return null;
  }

  const newStatements = buildGuardedStatements(
    factory, preTags, postTags, originalBody, location, invariantCall,
  );
  return applyNewBody(factory, node, factory.createBlock(newStatements, true));
}
```

Update `tryRewriteFunction` to accept and pass the new parameter:

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
): typescript.FunctionLikeDeclaration {
  try {
    const rewritten = rewriteFunction(
      factory, node, reparsedFunctions, warn, checker,
      invariantExpressions, interfaceMethodContracts,
    );
    if (rewritten === null) {
      return node;
    }
    transformed.value = true;
    return rewritten;
  } catch {
    return node;
  }
}
```

- [ ] **Step 3.4: Run tests**

```bash
npm test
```

Expected: new tests still fail (interface contracts not yet plumbed through `class-rewriter`). All previously passing tests still pass.

Note: The new `transformer.test.ts` tests will remain failing until Task 4 wires the resolver into `class-rewriter.ts`. That is expected — the function-rewriter change is backward-compatible.

- [ ] **Step 3.5: Commit the function-rewriter change**

```bash
git add src/function-rewriter.ts
git commit -m "feat: function-rewriter accepts optional interface method contracts"
```

---

## Task 4: Wire interface resolution into `class-rewriter.ts`

Connect the resolver, pass interface tags to `tryRewriteFunction`, merge invariants, and emit merge warnings.

**Files:**
- Modify: `src/class-rewriter.ts`

- [ ] **Step 4.1: Write the failing tests**

Add to `test/transformer.test.ts`:

```typescript
it('emits merge warning when both interface and class define @pre', () => {
  const warnings: string[] = [];
  const source = `
    interface IFoo {
      /** @pre amount > 0 */
      bar(amount: number): number;
    }
    class Foo implements IFoo {
      /** @pre amount < 1000 */
      bar(amount: number): number { return amount; }
    }
  `;
  transformWithProgram(source, (msg) => warnings.push(msg));
  expect(warnings.some((w) => w.includes('Contract merge warning'))).toBe(true);
  expect(warnings.some((w) => w.includes('@pre'))).toBe(true);
});

it('emits merge warning when both interface and class define @invariant', () => {
  const warnings: string[] = [];
  const source = `
    /** @invariant this.balance >= 0 */
    interface IFoo { bar(): void; }
    /** @invariant this.owner !== null */
    class Foo implements IFoo {
      balance = 0;
      owner = '';
      bar(): void {}
    }
  `;
  transformWithProgram(source, (msg) => warnings.push(msg));
  expect(warnings.some((w) => w.includes('Contract merge warning'))).toBe(true);
  expect(warnings.some((w) => w.includes('@invariant'))).toBe(true);
});

it('emits warning when TypeChecker is unavailable and class has implements clause', () => {
  const warnings: string[] = [];
  const source = `
    interface IFoo { bar(): void; }
    class Foo implements IFoo { bar(): void {} }
  `;
  // transform() uses transpileModule (no Program/TypeChecker)
  transform(source, (msg) => warnings.push(msg));
  expect(warnings.some((w) => w.includes('Interface contract resolution skipped'))).toBe(true);
});
```

- [ ] **Step 4.2: Run to confirm they fail**

```bash
npm test -- --testPathPattern transformer
```

Expected: FAIL on the new tests.

- [ ] **Step 4.3: Update imports in `src/class-rewriter.ts`**

Replace the existing imports with:

```typescript
import typescript from 'typescript';
import {
  buildCheckInvariantsCall, buildCheckInvariantsMethod, parseContractExpression,
} from './ast-builder';
import { extractInvariantExpressions, extractContractTags } from './jsdoc-parser';
import { validateExpression } from './contract-validator';
import { tryRewriteFunction, isPublicTarget } from './function-rewriter';
import {
  resolveInterfaceContracts,
  type InterfaceContracts,
  type InterfaceMethodContracts,
  type ParamMismatchMode,
} from './interface-resolver';
import type { ReparsedIndex } from './reparsed-index';
```

- [ ] **Step 4.4: Add helpers for merge warnings and implements detection**

Add these private functions to `src/class-rewriter.ts`:

```typescript
function hasImplementsClauses(node: typescript.ClassDeclaration): boolean {
  return node.heritageClauses !== undefined && node.heritageClauses.some(
    (clause) => clause.token === typescript.SyntaxKind.ImplementsKeyword,
  );
}

function emitMethodMergeWarnings(
  ifaceContracts: InterfaceMethodContracts,
  reparsedNode: typescript.FunctionLikeDeclaration,
  location: string,
  className: string,
  warn: (msg: string) => void,
): void {
  const classTags = extractContractTags(reparsedNode);
  const ifaceName = ifaceContracts.sourceInterface;
  if (
    ifaceContracts.preTags.length > 0 &&
    classTags.some((tag) => tag.kind === 'pre')
  ) {
    warn(
      `[axiom] Contract merge warning in ${location}:`
      + `\n  both ${ifaceName} and ${className} define @pre tags`
      + ' — additive merge applied',
    );
  }
  if (
    ifaceContracts.postTags.length > 0 &&
    classTags.some((tag) => tag.kind === 'post')
  ) {
    warn(
      `[axiom] Contract merge warning in ${location}:`
      + `\n  both ${ifaceName} and ${className} define @post tags`
      + ' — additive merge applied',
    );
  }
}
```

- [ ] **Step 4.5: Update `resolveEffectiveInvariants` to merge interface invariants**

Replace the existing `resolveEffectiveInvariants` with:

```typescript
function resolveEffectiveInvariants(
  node: typescript.ClassDeclaration,
  reparsedClass: typescript.ClassDeclaration | typescript.Node,
  className: string,
  warn: (msg: string) => void,
  interfaceInvariants: string[],
): string[] {
  const classRaw = extractInvariantExpressions(reparsedClass);

  if (interfaceInvariants.length > 0 && classRaw.length > 0) {
    warn(
      `[axiom] Contract merge warning in ${className}:`
      + '\n  both interface and class define @invariant tags'
      + ' — additive merge applied',
    );
  }

  const allRaw = [...interfaceInvariants, ...classRaw];
  const valid = filterValidInvariants(allRaw, className, warn);

  if (valid.length > 0 && hasClashingMember(node)) {
    warn(
      `[axiom] Cannot inject invariants into`
      + ` ${className}: ${CHECK_INVARIANTS_NAME} already defined`,
    );
    return [];
  }
  return valid;
}
```

- [ ] **Step 4.6: Update `rewriteMember` to pass interface method contracts**

Replace the existing `rewriteMember` with:

```typescript
function lookupIfaceMethodContracts(
  member: typescript.MethodDeclaration,
  reparsedIndex: ReparsedIndex,
  interfaceContracts: InterfaceContracts,
  className: string,
  warn: (msg: string) => void,
): InterfaceMethodContracts | undefined {
  if (!typescript.isIdentifier(member.name)) {
    return undefined;
  }
  const methodName = member.name.text;
  const ifaceContracts = interfaceContracts.methods.get(methodName);
  if (ifaceContracts === undefined) {
    return undefined;
  }
  const reparsedNode = reparsedIndex.functions.get(member.pos) ?? member;
  const location = `${className}.${methodName}`;
  emitMethodMergeWarnings(
    ifaceContracts, reparsedNode as typescript.FunctionLikeDeclaration,
    location, className, warn,
  );
  return ifaceContracts;
}

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
): { element: typescript.ClassElement; changed: boolean } {
  if (typescript.isMethodDeclaration(member) && isPublicTarget(member)) {
    const ifaceMethodContracts = lookupIfaceMethodContracts(
      member, reparsedIndex, interfaceContracts, className, warn,
    );
    const rewritten = tryRewriteFunction(
      factory, member, reparsedIndex.functions, transformed, warn,
      checker, effectiveInvariants, ifaceMethodContracts,
    );
    return {
      element: rewritten as typescript.MethodDeclaration,
      changed: rewritten !== member,
    };
  }
  if (typescript.isConstructorDeclaration(member) && effectiveInvariants.length > 0) {
    return { element: rewriteConstructor(factory, member, className), changed: true };
  }
  return { element: member, changed: false };
}
```

- [ ] **Step 4.7: Update `rewriteClass` to call the resolver**

Replace `rewriteClass` with:

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
): typescript.ClassDeclaration {
  const className = node.name?.text ?? 'UnknownClass';

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
  const effectiveInvariants = resolveEffectiveInvariants(
    node, reparsedClass, className, warn, interfaceContracts.invariants,
  );

  let classTransformed = false;
  const newMembers: typescript.ClassElement[] = [];

  for (const member of node.members) {
    const result = rewriteMember(
      factory, member, reparsedIndex, transformed, warn, checker,
      effectiveInvariants, className, interfaceContracts,
    );
    if (result.changed) {
      classTransformed = true;
    }
    newMembers.push(result.element);
  }

  if (effectiveInvariants.length > 0) {
    newMembers.push(buildCheckInvariantsMethod(effectiveInvariants, factory));
    classTransformed = true;
  }

  if (!classTransformed) {
    return node;
  }

  transformed.value = true;
  return factory.updateClassDeclaration(
    node,
    typescript.getModifiers(node),
    node.name,
    node.typeParameters,
    node.heritageClauses,
    newMembers,
  );
}
```

- [ ] **Step 4.8: Update `tryRewriteClass` signature**

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
): typescript.ClassDeclaration {
  try {
    return rewriteClass(
      factory, node, reparsedIndex, transformed, warn, checker, cache, mode,
    );
  } catch {
    return node;
  }
}
```

- [ ] **Step 4.9: Run all tests**

```bash
npm test
```

Expected: all 130+ tests pass, including the new transformer tests from Step 4.1.

- [ ] **Step 4.10: Commit**

```bash
git add src/class-rewriter.ts
git commit -m "feat: class-rewriter integrates interface contract resolver with merge warnings"
```

---

## Task 5: Update `transformer.ts` to thread options and cache

Add the `interfaceParamMismatch` plugin option, create the `reparsedCache` once per compilation, and pass both to `tryRewriteClass`.

**Files:**
- Modify: `src/transformer.ts`

- [ ] **Step 5.1: Write the failing test**

Add to `test/transformer.test.ts`:

```typescript
it('respects interfaceParamMismatch: ignore option', () => {
  const warnings: string[] = [];
  const source = `
    interface IFoo {
      /** @pre amount > 0 */
      bar(amount: number): number;
    }
    class Foo implements IFoo {
      bar(value: number): number { return value; }
    }
  `;
  // Use transformWithProgram but pass the option via a wrapper
  const fileName = 'virtual-test.ts';
  const compilerOptions: typescript.CompilerOptions = {
    target: typescript.ScriptTarget.ES2020,
    module: typescript.ModuleKind.CommonJS,
    skipLibCheck: true,
  };
  const defaultHost = typescript.createCompilerHost(compilerOptions);
  const customHost: typescript.CompilerHost = {
    ...defaultHost,
    getSourceFile(name, version) {
      if (name === fileName) {
        return typescript.createSourceFile(name, source, version, true);
      }
      return defaultHost.getSourceFile(name, version);
    },
    fileExists: (name) => name === fileName || defaultHost.fileExists(name),
    readFile: (name) => name === fileName ? source : defaultHost.readFile(name),
  };
  const program = typescript.createProgram([fileName], compilerOptions, customHost);
  const sourceFile = program.getSourceFile(fileName)!;
  let output = '';
  program.emit(
    sourceFile,
    (_, text) => { output = text; },
    undefined,
    false,
    {
      before: [createTransformer(
        program,
        { warn: (msg) => warnings.push(msg), interfaceParamMismatch: 'ignore' },
      )],
    },
  );
  // Contract skipped due to ignore mode + param rename
  expect(output).not.toContain('amount > 0');
  expect(warnings.some((w) => w.includes('skipped'))).toBe(true);
});
```

- [ ] **Step 5.2: Run to confirm it fails**

```bash
npm test -- --testPathPattern transformer
```

Expected: FAIL — `interfaceParamMismatch` option not yet recognised.

- [ ] **Step 5.3: Update `src/transformer.ts`**

Add the import:

```typescript
import { tryRewriteClass } from './class-rewriter';
import type { ParamMismatchMode } from './interface-resolver';
```

Update the options type and `createTransformer`:

```typescript
export default function createTransformer(
  _program?: typescript.Program,
  options?: {
    warn?: (msg: string) => void;
    interfaceParamMismatch?: 'rename' | 'ignore';
  },
): typescript.TransformerFactory<typescript.SourceFile> {
  const warn = options?.warn ?? ((msg: string): void => {
    process.stderr.write(`${msg}\n`);
  });
  const rawMode = options?.interfaceParamMismatch;
  const paramMismatch: ParamMismatchMode = rawMode === 'ignore' ? 'ignore' : 'rename';
  const checker = _program?.getTypeChecker?.();
  const reparsedCache = new Map<string, typescript.SourceFile>();

  return (context: typescript.TransformationContext) => {
    const { factory } = context;

    return (sourceFile: typescript.SourceFile): typescript.SourceFile => {
      const reparsedIndex = buildReparsedIndex(sourceFile);
      const transformed = { value: false };
      const visited = typescript.visitEachChild(
        sourceFile,
        (node) => visitNode(
          factory, node, context, reparsedIndex, transformed, warn,
          checker, reparsedCache, paramMismatch,
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
  };
}
```

Update `visitNode` to pass the new parameters to `tryRewriteClass`:

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
): typescript.Node {
  if (typescript.isClassDeclaration(node)) {
    return tryRewriteClass(
      factory, node, reparsedIndex, transformed, warn,
      checker, reparsedCache, paramMismatch,
    );
  }

  if (
    typescript.isFunctionDeclaration(node) &&
    isPublicTarget(node as typescript.FunctionLikeDeclaration)
  ) {
    return tryRewriteFunction(
      factory,
      node as typescript.FunctionLikeDeclaration,
      reparsedIndex.functions,
      transformed,
      warn,
      checker,
    );
  }

  return typescript.visitEachChild(
    node,
    (child) => visitNode(
      factory, child, context, reparsedIndex, transformed, warn,
      checker, reparsedCache, paramMismatch,
    ),
    context,
  );
}
```

Add the import for `ParamMismatchMode` at the top of the visitNode call sites (it's used as a parameter type, but since it flows through as a value you may need it only in the `createTransformer` scope — TypeScript will infer the parameter type from the `tryRewriteClass` signature).

- [ ] **Step 5.4: Run all tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5.5: Commit**

```bash
git add src/transformer.ts
git commit -m "feat: transformer threads interfaceParamMismatch option and reparsedCache"
```

---

## Task 6: Acceptance tests — runtime verification

Confirm that interface contracts actually fire at runtime, including cross-file scenarios.

**Files:**
- Modify: `test/acceptance.test.ts`

- [ ] **Step 6.1: Add a cross-file interface runtime helper**

Add to `test/acceptance.test.ts`:

```typescript
function compileClassWithInterface(
  ifaceSource: string,
  classSource: string,
): string {
  const ifaceFile = 'iface.ts';
  const classFile = 'class.ts';
  const files: Record<string, string> = {
    [ifaceFile]: ifaceSource,
    [classFile]: classSource,
  };
  const compilerOptions: typescript.CompilerOptions = {
    target: typescript.ScriptTarget.ES2022,
    module: typescript.ModuleKind.CommonJS,
    skipLibCheck: true,
  };
  const defaultHost = typescript.createCompilerHost(compilerOptions);
  const host: typescript.CompilerHost = {
    ...defaultHost,
    getSourceFile(name, version) {
      if (name in files) {
        return typescript.createSourceFile(name, files[name], version, true);
      }
      return defaultHost.getSourceFile(name, version);
    },
    fileExists: (name) => name in files || defaultHost.fileExists(name),
    readFile: (name) => files[name] ?? defaultHost.readFile(name),
  };
  const program = typescript.createProgram([ifaceFile, classFile], compilerOptions, host);
  const sourceFile = program.getSourceFile(classFile)!;
  let output = '';
  program.emit(
    sourceFile,
    (_, text) => { output = text; },
    undefined,
    false,
    { before: [createTransformer(program)] },
  );
  return output;
}

function evalWithAllErrors(jsSource: string): Record<string, unknown> {
  const exports: Record<string, unknown> = {};
  const mod = { exports };
  const stripped = jsSource.replace(/.*require\("axiom"\).*\n?/g, '');
  // eslint-disable-next-line no-new-func
  new Function(
    'exports', 'module', 'ContractViolationError', 'InvariantViolationError',
    stripped,
  )(exports, mod, ContractViolationError, InvariantViolationError);
  return mod.exports;
}
```

- [ ] **Step 6.2: Write the acceptance tests**

```typescript
describe('interface contracts — @pre fires at runtime', () => {
  it('throws ContractViolationError PRE when interface @pre is violated', () => {
    const ifaceSource = `
      export interface IAccount {
        /** @pre amount > 0 */
        withdraw(amount: number): number;
      }
    `;
    const classSource = `
      import type { IAccount } from './iface';
      export class Account implements IAccount {
        balance = 100;
        withdraw(amount: number): number {
          this.balance -= amount;
          return this.balance;
        }
      }
    `;
    const compiled = compileClassWithInterface(ifaceSource, classSource);
    const mod = evalWithAllErrors(compiled);
    const Cls = mod['Account'] as new () => { withdraw(n: number): number };
    const acct = new Cls();
    expect(() => acct.withdraw(-1)).toThrow(ContractViolationError);
  });

  it('does not throw when interface @pre is satisfied', () => {
    const ifaceSource = `
      export interface IAccount {
        /** @pre amount > 0 */
        withdraw(amount: number): number;
      }
    `;
    const classSource = `
      import type { IAccount } from './iface';
      export class Account implements IAccount {
        balance = 100;
        withdraw(amount: number): number {
          this.balance -= amount;
          return this.balance;
        }
      }
    `;
    const compiled = compileClassWithInterface(ifaceSource, classSource);
    const mod = evalWithAllErrors(compiled);
    const Cls = mod['Account'] as new () => { withdraw(n: number): number };
    const acct = new Cls();
    expect(() => acct.withdraw(50)).not.toThrow();
  });
});

describe('interface contracts — @invariant fires at runtime', () => {
  it('throws InvariantViolationError when interface @invariant is violated', () => {
    const ifaceSource = `
      /** @invariant this.balance >= 0 */
      export interface IAccount {
        withdraw(amount: number): number;
      }
    `;
    const classSource = `
      import type { IAccount } from './iface';
      export class Account implements IAccount {
        balance = 100;
        withdraw(amount: number): number {
          this.balance -= amount;
          return this.balance;
        }
      }
    `;
    const compiled = compileClassWithInterface(ifaceSource, classSource);
    const mod = evalWithAllErrors(compiled);
    const Cls = mod['Account'] as new () => { balance: number; withdraw(n: number): number };
    const acct = new Cls();
    expect(() => acct.withdraw(200)).toThrow(InvariantViolationError);
  });
});

describe('interface contracts — both interface and class contracts fire', () => {
  it('fires interface @pre then class @pre when both defined', () => {
    const ifaceSource = `
      export interface IAccount {
        /** @pre amount > 0 */
        withdraw(amount: number): number;
      }
    `;
    const classSource = `
      import type { IAccount } from './iface';
      export class Account implements IAccount {
        balance = 100;
        /** @pre amount <= this.balance */
        withdraw(amount: number): number {
          this.balance -= amount;
          return this.balance;
        }
      }
    `;
    const compiled = compileClassWithInterface(ifaceSource, classSource);
    const mod = evalWithAllErrors(compiled);
    const Cls = mod['Account'] as new () => { withdraw(n: number): number };
    const acct = new Cls();
    // violates interface @pre (amount > 0)
    expect(() => acct.withdraw(-1)).toThrow(ContractViolationError);
    // violates class @pre (amount <= this.balance)
    expect(() => acct.withdraw(999)).toThrow(ContractViolationError);
    expect(() => acct.withdraw(50)).not.toThrow();
  });
});
```

- [ ] **Step 6.3: Run to confirm they pass**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 6.4: Commit**

```bash
git add test/acceptance.test.ts
git commit -m "test: acceptance tests for interface contract runtime enforcement"
```

---

## Task 7: Lint, typecheck, and final verification

- [ ] **Step 7.1: Run ESLint**

```bash
npm run lint
```

Fix any violations. Common issues:
- Identifier shorter than 3 chars — rename the variable
- Line over 100 chars — break into multiple lines
- Function complexity over 10 — extract a helper

- [ ] **Step 7.2: Run typecheck**

```bash
npm run typecheck
```

Fix any type errors.

- [ ] **Step 7.3: Run full test suite with coverage**

```bash
npm run test:coverage
```

Expected: 80% coverage threshold met, all tests pass.

- [ ] **Step 7.4: Run knip (unused exports check)**

```bash
npm run knip
```

Fix any unused exports flagged.

- [ ] **Step 7.5: Commit any lint/type fixes**

```bash
git add -p
git commit -m "fix: lint and typecheck fixes for interface contracts feature"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| `@pre`/`@post` on interface methods | Task 2 (`extractMethodContracts`) |
| `@invariant` on interface | Task 2 (`processInterfaceDeclaration`) |
| Any class with `implements` — no opt-in | Task 4 (`rewriteClass` always calls resolver) |
| Additive merge, interface tags first | Task 3 (`allPreInput` prepend) |
| Merge warning when both define tags | Task 4 (`emitMethodMergeWarnings`) |
| Invariant merge warning | Task 4 (`resolveEffectiveInvariants`) |
| Cross-file via TypeChecker | Task 2 (`processImplementedInterface`) |
| `'rename'` mode (default) | Task 2 (`applyRenameToTags`) |
| `'ignore'` mode | Task 2 (`extractMethodContracts` early return) |
| Param count mismatch → skip + warn | Task 2 (`extractMethodContracts` count check) |
| TypeChecker unavailable → warn + skip | Task 4 (`rewriteClass` guard) |
| `interfaceParamMismatch` plugin option | Task 5 (`createTransformer`) |
| `reparsedCache` shared per compilation | Task 5 (`createTransformer`) |
| Runtime: `@pre` fires | Task 6 |
| Runtime: `@invariant` fires | Task 6 |
| Runtime: both interface + class fire | Task 6 |
| Release build has no injected code | Existing behaviour — no change needed |
