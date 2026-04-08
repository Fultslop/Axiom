# fsprepost MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript compiler transformer that reads `@pre`/`@post` JSDoc tags, injects runtime contract checks in dev builds, and produces zero contract code in release builds.

**Architecture:** A `ts-patch` transformer plugin walks each `SourceFile`, extracts `@pre`/`@post` expressions from JSDoc on public functions and methods, and rewrites their bodies to inject guard statements. The `ContractViolationError` class is the only runtime artifact; the transformer injects an import of it into any file it modifies. The release build uses plain `tsc` which treats JSDoc as inert comments.

**Tech Stack:** TypeScript 6, ts-patch (compiler plugin host), Jest + ts-jest, the TypeScript Compiler API (`typescript` package, already installed).

---

## ESLint Constraints (read before writing any src/ code)

The eslint config in this project is strict. All `src/**/*.ts` files (including test files) must comply:

- **`id-length: min 3`** — No identifiers shorter than 3 characters. Exceptions: `id`, `to`, `ok`, `fs`. **This means `import typescript from 'typescript'`, NOT `import ts from 'typescript'`.**
- **No raw string comparisons** — `BinaryExpression[===] > Literal` is banned. Use named constants instead of comparing directly against string literals (e.g. `const PRE_TAG = 'pre' as const`, then `tagName === PRE_TAG`).
- **No bare `return;`** — `ReturnStatement[argument=null]` is banned. Void early-exits must be restructured with guards.
- **`complexity: 10`** — Keep functions small. Extract helpers aggressively.
- **`max-len: 100`** — Lines must be under 100 characters.

---

## File Map

| File | Responsibility |
| :--- | :--- |
| `src/contract-violation-error.ts` | `ContractViolationError` class — the only runtime artifact |
| `src/jsdoc-parser.ts` | Extract `@pre`/`@post` expressions from a TypeScript AST node |
| `src/ast-builder.ts` | Build guard AST nodes (pre-check, body-wrap, post-check) |
| `src/transformer.ts` | `ts-patch` plugin entry point — wires parser + builder into a `TransformerFactory` |
| `src/index.ts` | Public exports (`ContractViolationError` + `transformer`) |
| `src/contract-violation-error.test.ts` | Unit tests for the error class |
| `src/jsdoc-parser.test.ts` | Unit tests for JSDoc extraction |
| `src/ast-builder.test.ts` | Unit tests for AST node construction |
| `src/transformer.test.ts` | Integration tests via `ts.transpileModule` |
| `test/fixtures/account.ts` | The acceptance-criteria fixture from the spec |
| `tsconfig.dev.json` | Extends `tsconfig.json`, adds the transformer plugin |

---

## Task 1: Project Setup

**Files:**
- Modify: `package.json`
- Create: `tsconfig.dev.json`

- [ ] **Step 1.1: Install ts-patch**

```bash
npm install --save-dev ts-patch
```

Expected: `ts-patch` appears in `package.json` devDependencies.

- [ ] **Step 1.2: Patch the TypeScript installation**

```bash
npx ts-patch install
```

Expected output: `TypeScript patched successfully` (or similar). This modifies the local `node_modules/typescript` so `tspc` can load plugins.

- [ ] **Step 1.3: Add `build:dev` script to `package.json`**

In `package.json`, add one entry to `"scripts"`:

```json
"build:dev": "tspc -p tsconfig.dev.json"
```

- [ ] **Step 1.4: Create `tsconfig.dev.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "plugins": [{ "transform": "./src/transformer.ts", "type": "raw" }]
  }
}
```

> `"type": "raw"` tells ts-patch to load the transformer source directly via `ts-node`, without requiring a pre-built `dist/`. This is correct for development.

- [ ] **Step 1.5: Verify setup compiles (no src yet)**

```bash
npm run build
```

Expected: Compiles cleanly (no src files yet, nothing to fail).

- [ ] **Step 1.6: Commit**

```bash
git add package.json package-lock.json tsconfig.dev.json
git commit -m "chore: install ts-patch and add build:dev script"
```

---

## Task 2: ContractViolationError

**Files:**
- Create: `src/contract-violation-error.ts`
- Create: `src/contract-violation-error.test.ts`

- [ ] **Step 2.1: Write the failing test**

Create `src/contract-violation-error.test.ts`:

```typescript
import { ContractViolationError } from './contract-violation-error';

describe('ContractViolationError', () => {
  it('sets type, expression, and location', () => {
    const err = new ContractViolationError('PRE', 'amount > 0', 'Account.withdraw');
    expect(err.type).toBe('PRE');
    expect(err.expression).toBe('amount > 0');
    expect(err.location).toBe('Account.withdraw');
  });

  it('formats message with all fields', () => {
    const err = new ContractViolationError('POST', 'result >= 0', 'Account.deposit');
    expect(err.message).toBe('[POST] Contract violated at Account.deposit: result >= 0');
  });

  it('has name ContractViolationError', () => {
    const err = new ContractViolationError('PRE', 'x > 0', 'foo');
    expect(err.name).toBe('ContractViolationError');
  });

  it('is an instance of Error', () => {
    const err = new ContractViolationError('PRE', 'x > 0', 'foo');
    expect(err).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 2.2: Run test to verify it fails**

```bash
npm test -- --testPathPattern=contract-violation-error
```

Expected: FAIL — `Cannot find module './contract-violation-error'`

- [ ] **Step 2.3: Implement `ContractViolationError`**

Create `src/contract-violation-error.ts`:

```typescript
export class ContractViolationError extends Error {
  public readonly type: 'PRE' | 'POST';
  public readonly expression: string;
  public readonly location: string;

  constructor(type: 'PRE' | 'POST', expression: string, location: string) {
    super(`[${type}] Contract violated at ${location}: ${expression}`);
    this.name = 'ContractViolationError';
    this.type = type;
    this.expression = expression;
    this.location = location;
  }
}
```

- [ ] **Step 2.4: Run test to verify it passes**

```bash
npm test -- --testPathPattern=contract-violation-error
```

Expected: PASS, 4 tests.

- [ ] **Step 2.5: Commit**

```bash
git add src/contract-violation-error.ts src/contract-violation-error.test.ts
git commit -m "feat: add ContractViolationError class"
```

---

## Task 3: JSDoc Parser

**Files:**
- Create: `src/jsdoc-parser.ts`
- Create: `src/jsdoc-parser.test.ts`

The parser accepts a TypeScript `FunctionLikeDeclaration` node and returns an array of `ContractTag` objects.

- [ ] **Step 3.1: Write the failing tests**

Create `src/jsdoc-parser.test.ts`:

```typescript
import typescript from 'typescript';
import { extractContractTags } from './jsdoc-parser';

function parseFunctionNode(source: string): typescript.FunctionLikeDeclaration {
  const sourceFile = typescript.createSourceFile(
    'test.ts',
    source,
    typescript.ScriptTarget.ES2020,
    true,
  );
  let found: typescript.FunctionLikeDeclaration | undefined;
  function visit(node: typescript.Node): void {
    if (typescript.isFunctionLike(node)) {
      found = node as typescript.FunctionLikeDeclaration;
    }
    typescript.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (!found) {
    throw new Error('No function found in source');
  }
  return found;
}

describe('extractContractTags', () => {
  it('returns empty array when no JSDoc tags', () => {
    const node = parseFunctionNode('function foo(x: number): number { return x; }');
    expect(extractContractTags(node)).toEqual([]);
  });

  it('extracts a single @pre tag', () => {
    const source = `
      /** @pre amount > 0 */
      function withdraw(amount: number): number { return amount; }
    `;
    const node = parseFunctionNode(source);
    const tags = extractContractTags(node);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toEqual({ kind: 'pre', expression: 'amount > 0' });
  });

  it('extracts a single @post tag', () => {
    const source = `
      /** @post result >= 0 */
      function deposit(amount: number): number { return amount; }
    `;
    const node = parseFunctionNode(source);
    const tags = extractContractTags(node);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toEqual({ kind: 'post', expression: 'result >= 0' });
  });

  it('extracts multiple @pre and @post tags', () => {
    const source = `
      /**
       * @pre amount > 0
       * @pre amount <= this.balance
       * @post result === this.balance
       */
      function withdraw(amount: number): number { return amount; }
    `;
    const node = parseFunctionNode(source);
    const tags = extractContractTags(node);
    expect(tags).toHaveLength(3);
    expect(tags[0]).toEqual({ kind: 'pre', expression: 'amount > 0' });
    expect(tags[1]).toEqual({ kind: 'pre', expression: 'amount <= this.balance' });
    expect(tags[2]).toEqual({ kind: 'post', expression: 'result === this.balance' });
  });

  it('ignores unrelated JSDoc tags', () => {
    const source = `
      /**
       * @param amount The amount
       * @returns The result
       * @pre amount > 0
       */
      function withdraw(amount: number): number { return amount; }
    `;
    const node = parseFunctionNode(source);
    const tags = extractContractTags(node);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toEqual({ kind: 'pre', expression: 'amount > 0' });
  });

  it('skips tags with empty expressions', () => {
    const source = `
      /**
       * @pre
       * @post result > 0
       */
      function foo(xxx: number): number { return xxx; }
    `;
    const node = parseFunctionNode(source);
    const tags = extractContractTags(node);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toEqual({ kind: 'post', expression: 'result > 0' });
  });
});
```

- [ ] **Step 3.2: Run to verify it fails**

```bash
npm test -- --testPathPattern=jsdoc-parser
```

Expected: FAIL — `Cannot find module './jsdoc-parser'`

- [ ] **Step 3.3: Implement the JSDoc parser**

Create `src/jsdoc-parser.ts`:

```typescript
import typescript from 'typescript';

export interface ContractTag {
  kind: 'pre' | 'post';
  expression: string;
}

const PRE_TAG = 'pre' as const;
const POST_TAG = 'post' as const;

function resolveTagComment(comment: typescript.JSDocTag['comment']): string {
  if (typeof comment === 'string') {
    return comment.trim();
  }
  if (Array.isArray(comment)) {
    return comment
      .map((part) => ('text' in part ? part.text : ''))
      .join('')
      .trim();
  }
  return '';
}

function toContractKind(tagName: string): 'pre' | 'post' | undefined {
  if (tagName === PRE_TAG) {
    return PRE_TAG;
  }
  if (tagName === POST_TAG) {
    return POST_TAG;
  }
  return undefined;
}

export function extractContractTags(
  node: typescript.FunctionLikeDeclaration,
): ContractTag[] {
  const jsDocTags = typescript.getJSDocTags(node);
  const result: ContractTag[] = [];

  for (const tag of jsDocTags) {
    const kind = toContractKind(tag.tagName.text.toLowerCase());
    if (kind === undefined) {
      continue;
    }
    const expression = resolveTagComment(tag.comment);
    if (expression.length > 0) {
      result.push({ kind, expression });
    }
  }

  return result;
}
```

- [ ] **Step 3.4: Run to verify it passes**

```bash
npm test -- --testPathPattern=jsdoc-parser
```

Expected: PASS, all tests.

- [ ] **Step 3.5: Commit**

```bash
git add src/jsdoc-parser.ts src/jsdoc-parser.test.ts
git commit -m "feat: add JSDoc @pre/@post tag extractor"
```

---

## Task 4: AST Builder

**Files:**
- Create: `src/ast-builder.ts`
- Create: `src/ast-builder.test.ts`

The builder produces the AST nodes for the three injection points:
1. A pre-check `if` statement.
2. A `const result = (() => { ...originalBody })()` capture statement.
3. A post-check `if` statement.
4. A final `return result` statement.

- [ ] **Step 4.1: Write the failing tests**

Create `src/ast-builder.test.ts`:

```typescript
import typescript from 'typescript';
import { buildPreCheck, buildBodyCapture, buildPostCheck, buildResultReturn } from './ast-builder';

function printNode(node: typescript.Node): string {
  const printer = typescript.createPrinter({ newLine: typescript.NewLineKind.LineFeed });
  const dummyFile = typescript.createSourceFile(
    'print.ts', '', typescript.ScriptTarget.ES2020, false, typescript.ScriptKind.TS
  );
  return printer.printNode(typescript.EmitHint.Unspecified, node, dummyFile);
}

function parseStatement(source: string): typescript.Statement {
  const sourceFile = typescript.createSourceFile(
    'test.ts', source, typescript.ScriptTarget.ES2020, true
  );
  const firstStatement = sourceFile.statements[0];
  if (!firstStatement) {
    throw new Error('No statement found');
  }
  return firstStatement;
}

describe('buildPreCheck', () => {
  it('wraps expression in negated if and throws ContractViolationError', () => {
    const node = buildPreCheck('amount > 0', 'Account.withdraw');
    const output = printNode(node);
    expect(output).toContain('!(amount > 0)');
    expect(output).toContain('ContractViolationError');
    expect(output).toContain('"PRE"');
    expect(output).toContain('"amount > 0"');
    expect(output).toContain('"Account.withdraw"');
  });
});

describe('buildPostCheck', () => {
  it('wraps expression in negated if and throws ContractViolationError', () => {
    const node = buildPostCheck('result >= 0', 'Account.deposit');
    const output = printNode(node);
    expect(output).toContain('!(result >= 0)');
    expect(output).toContain('"POST"');
    expect(output).toContain('"result >= 0"');
    expect(output).toContain('"Account.deposit"');
  });
});

describe('buildBodyCapture', () => {
  it('wraps original statements in an IIFE assigned to const result', () => {
    const originalBody = parseStatement('{ x = 1; return x; }') as typescript.Block;
    const node = buildBodyCapture(originalBody.statements);
    const output = printNode(node);
    expect(output).toContain('const result');
    expect(output).toContain('=>');
    expect(output).toContain('x = 1');
  });
});

describe('buildResultReturn', () => {
  it('produces return result statement', () => {
    const node = buildResultReturn();
    const output = printNode(node);
    expect(output).toContain('return result');
  });
});
```

- [ ] **Step 4.2: Run to verify it fails**

```bash
npm test -- --testPathPattern=ast-builder
```

Expected: FAIL — `Cannot find module './ast-builder'`

- [ ] **Step 4.3: Implement the AST builder**

Create `src/ast-builder.ts`:

```typescript
import typescript from 'typescript';

const { factory } = typescript;

function buildThrowContractViolation(
  contractType: 'PRE' | 'POST',
  expression: string,
  location: string,
): typescript.ThrowStatement {
  return factory.createThrowStatement(
    factory.createNewExpression(
      factory.createIdentifier('ContractViolationError'),
      undefined,
      [
        factory.createStringLiteral(contractType),
        factory.createStringLiteral(expression),
        factory.createStringLiteral(location),
      ],
    ),
  );
}

function buildGuardIf(
  expression: string,
  body: typescript.ThrowStatement,
): typescript.IfStatement {
  const parsedCondition = typescript.createSourceFile(
    'expr.ts',
    `!(${expression})`,
    typescript.ScriptTarget.ES2020,
    true,
  ).statements[0];

  if (!parsedCondition || !typescript.isExpressionStatement(parsedCondition)) {
    throw new Error(`Failed to parse contract expression: ${expression}`);
  }

  return factory.createIfStatement(parsedCondition.expression, body);
}

export function buildPreCheck(expression: string, location: string): typescript.IfStatement {
  return buildGuardIf(
    expression,
    buildThrowContractViolation('PRE', expression, location),
  );
}

export function buildPostCheck(expression: string, location: string): typescript.IfStatement {
  return buildGuardIf(
    expression,
    buildThrowContractViolation('POST', expression, location),
  );
}

export function buildBodyCapture(
  originalStatements: typescript.NodeArray<typescript.Statement>,
): typescript.VariableStatement {
  const iife = factory.createCallExpression(
    factory.createArrowFunction(
      undefined,
      undefined,
      [],
      undefined,
      factory.createToken(typescript.SyntaxKind.EqualsGreaterThanToken),
      factory.createBlock(Array.from(originalStatements), true),
    ),
    undefined,
    [],
  );

  return factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [factory.createVariableDeclaration(
        factory.createIdentifier('result'),
        undefined,
        undefined,
        iife,
      )],
      typescript.NodeFlags.Const,
    ),
  );
}

export function buildResultReturn(): typescript.ReturnStatement {
  return factory.createReturnStatement(factory.createIdentifier('result'));
}
```

- [ ] **Step 4.4: Run to verify it passes**

```bash
npm test -- --testPathPattern=ast-builder
```

Expected: PASS, all tests.

- [ ] **Step 4.5: Commit**

```bash
git add src/ast-builder.ts src/ast-builder.test.ts
git commit -m "feat: add AST builder for pre/post guard nodes"
```

---

## Task 5: Transformer

**Files:**
- Create: `src/transformer.ts`
- Create: `src/transformer.test.ts`

The transformer is the ts-patch plugin entry point. It wires the parser and builder together and handles the safety invariant (warn + skip on any error).

- [ ] **Step 5.1: Write the failing integration tests**

Create `src/transformer.test.ts`:

```typescript
import typescript from 'typescript';
import createTransformer from './transformer';

function transform(source: string): string {
  const result = typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2020,
      module: typescript.ModuleKind.CommonJS,
    },
    transformers: {
      before: [createTransformer()],
    },
  });
  return result.outputText;
}

describe('transformer', () => {
  it('leaves functions without contract tags unchanged', () => {
    const source = `
      export function add(aaa: number, bbb: number): number {
        return aaa + bbb;
      }
    `;
    const output = transform(source);
    expect(output).not.toContain('ContractViolationError');
    expect(output).not.toContain('result');
  });

  it('injects pre-check for @pre tag', () => {
    const source = `
      /**
       * @pre amount > 0
       */
      export function withdraw(amount: number): number {
        return amount;
      }
    `;
    const output = transform(source);
    expect(output).toContain('ContractViolationError');
    expect(output).toContain('!(amount > 0)');
    expect(output).toContain('"PRE"');
  });

  it('injects post-check and result capture for @post tag', () => {
    const source = `
      /**
       * @post result >= 0
       */
      export function deposit(amount: number): number {
        return amount;
      }
    `;
    const output = transform(source);
    expect(output).toContain('const result');
    expect(output).toContain('!(result >= 0)');
    expect(output).toContain('"POST"');
    expect(output).toContain('return result');
  });

  it('injects multiple @pre checks in order', () => {
    const source = `
      /**
       * @pre amount > 0
       * @pre amount <= 1000
       */
      export function pay(amount: number): number {
        return amount;
      }
    `;
    const output = transform(source);
    const firstPre = output.indexOf('!(amount > 0)');
    const secondPre = output.indexOf('!(amount <= 1000)');
    expect(firstPre).toBeGreaterThanOrEqual(0);
    expect(secondPre).toBeGreaterThan(firstPre);
  });

  it('injects both pre and post checks', () => {
    const source = `
      /**
       * @pre amount > 0
       * @post result >= 0
       */
      export function withdraw(amount: number): number {
        return amount;
      }
    `;
    const output = transform(source);
    const preIdx = output.indexOf('"PRE"');
    const captureIdx = output.indexOf('const result');
    const postIdx = output.indexOf('"POST"');
    const returnIdx = output.lastIndexOf('return result');
    expect(preIdx).toBeGreaterThanOrEqual(0);
    expect(captureIdx).toBeGreaterThan(preIdx);
    expect(postIdx).toBeGreaterThan(captureIdx);
    expect(returnIdx).toBeGreaterThan(postIdx);
  });

  it('injects import for ContractViolationError when any contract found', () => {
    const source = `
      /** @pre amount > 0 */
      export function withdraw(amount: number): number { return amount; }
    `;
    const output = transform(source);
    expect(output).toContain('ContractViolationError');
    expect(output).toContain('fsprepost');
  });

  it('skips non-exported functions silently', () => {
    const source = `
      /** @pre amount > 0 */
      function internal(amount: number): number { return amount; }
    `;
    const output = transform(source);
    expect(output).not.toContain('ContractViolationError');
  });

  it('safety invariant: compiles without crashing when expression is syntactically broken', () => {
    // Malformed expression — the transformer must fall back to the original body.
    // In a full ts-patch build this would also emit a diagnostic warning (deferred
    // because transpileModule does not provide a Program for diagnostic emission).
    const source = `
      /** @pre amount > */
      export function withdraw(amount: number): number { return amount; }
    `;
    expect(() => transform(source)).not.toThrow();
  });
});
```

- [ ] **Step 5.2: Run to verify it fails**

```bash
npm test -- --testPathPattern=transformer
```

Expected: FAIL — `Cannot find module './transformer'`

- [ ] **Step 5.3: Implement the transformer**

Create `src/transformer.ts`:

```typescript
import typescript from 'typescript';
import { extractContractTags } from './jsdoc-parser';
import { buildPreCheck, buildBodyCapture, buildPostCheck, buildResultReturn } from './ast-builder';
import type { ContractTag } from './jsdoc-parser';

const { factory } = typescript;

function isPublicTarget(node: typescript.FunctionLikeDeclaration): boolean {
  const modifiers = typescript.canHaveModifiers(node)
    ? typescript.getModifiers(node) ?? []
    : [];

  const isPrivateOrProtected = modifiers.some(
    (mod) =>
      mod.kind === typescript.SyntaxKind.PrivateKeyword ||
      mod.kind === typescript.SyntaxKind.ProtectedKeyword,
  );

  const isExportedFunction =
    typescript.isFunctionDeclaration(node) &&
    modifiers.some((mod) => mod.kind === typescript.SyntaxKind.ExportKeyword);

  const isPublicMethod = typescript.isMethodDeclaration(node) && !isPrivateOrProtected;

  return isExportedFunction || isPublicMethod;
}

function buildLocationName(node: typescript.FunctionLikeDeclaration): string {
  if (typescript.isMethodDeclaration(node)) {
    const className =
      typescript.isClassDeclaration(node.parent) && node.parent.name
        ? node.parent.name.text
        : 'UnknownClass';
    const methodName =
      typescript.isIdentifier(node.name) ? node.name.text : 'unknownMethod';
    return `${className}.${methodName}`;
  }
  if (typescript.isFunctionDeclaration(node) && node.name) {
    return node.name.text;
  }
  return 'anonymous';
}

function buildGuardedStatements(
  preTags: ContractTag[],
  postTags: ContractTag[],
  originalBody: typescript.Block,
  location: string,
): typescript.Statement[] {
  const statements: typescript.Statement[] = [];

  for (const tag of preTags) {
    statements.push(buildPreCheck(tag.expression, location));
  }

  if (postTags.length > 0) {
    statements.push(buildBodyCapture(originalBody.statements));
    for (const tag of postTags) {
      statements.push(buildPostCheck(tag.expression, location));
    }
    statements.push(buildResultReturn());
  } else {
    statements.push(...Array.from(originalBody.statements));
  }

  return statements;
}

function buildImportDeclaration(): typescript.ImportDeclaration {
  return factory.createImportDeclaration(
    undefined,
    factory.createImportClause(
      false,
      undefined,
      factory.createNamedImports([
        factory.createImportSpecifier(
          false,
          undefined,
          factory.createIdentifier('ContractViolationError'),
        ),
      ]),
    ),
    factory.createStringLiteral('fsprepost'),
  );
}

function rewriteFunction(
  node: typescript.FunctionLikeDeclaration,
): typescript.FunctionLikeDeclaration | null {
  const originalBody = node.body;
  if (!originalBody || !typescript.isBlock(originalBody)) {
    return null;
  }

  const tags = extractContractTags(node);
  const preTags = tags.filter((tag) => tag.kind === 'pre');
  const postTags = tags.filter((tag) => tag.kind === 'post');
  const location = buildLocationName(node);
  const newStatements = buildGuardedStatements(preTags, postTags, originalBody, location);
  const newBody = factory.createBlock(newStatements, true);

  if (typescript.isMethodDeclaration(node)) {
    return factory.updateMethodDeclaration(
      node,
      typescript.getModifiers(node),
      node.asteriskToken,
      node.name,
      node.questionToken,
      node.typeParameters,
      node.parameters,
      node.type,
      newBody,
    );
  }

  if (typescript.isFunctionDeclaration(node)) {
    return factory.updateFunctionDeclaration(
      node,
      typescript.getModifiers(node),
      node.asteriskToken,
      node.name,
      node.typeParameters,
      node.parameters,
      node.type,
      newBody,
    );
  }

  return null;
}

function tryRewriteFunction(
  node: typescript.FunctionLikeDeclaration,
  transformed: { value: boolean },
): typescript.FunctionLikeDeclaration {
  try {
    const tags = extractContractTags(node);
    if (tags.length === 0) {
      return node;
    }
    const rewritten = rewriteFunction(node);
    if (rewritten === null) {
      return node;
    }
    transformed.value = true;
    return rewritten;
  } catch (_err) {
    // Safety invariant: on any error, return original node unmodified.
    // In a full ts-patch context with a Program, emit a diagnostic warning here.
    return node;
  }
}

function visitNode(
  node: typescript.Node,
  context: typescript.TransformationContext,
  transformed: { value: boolean },
): typescript.Node {
  if (
    (typescript.isMethodDeclaration(node) || typescript.isFunctionDeclaration(node)) &&
    isPublicTarget(node as typescript.FunctionLikeDeclaration)
  ) {
    return tryRewriteFunction(node as typescript.FunctionLikeDeclaration, transformed);
  }
  return typescript.visitEachChild(
    node,
    (child) => visitNode(child, context, transformed),
    context,
  );
}

// ts-patch plugin entry point. program is optional so the transformer can
// also be used in transpileModule() for unit testing.
export default function createTransformer(
  _program?: typescript.Program,
): typescript.TransformerFactory<typescript.SourceFile> {
  return (context: typescript.TransformationContext) =>
    (sourceFile: typescript.SourceFile): typescript.SourceFile => {
      const transformed = { value: false };
      const visited = typescript.visitEachChild(
        sourceFile,
        (node) => visitNode(node, context, transformed),
        context,
      );

      if (!transformed.value) {
        return visited;
      }

      const importDecl = buildImportDeclaration();
      return factory.updateSourceFile(visited, [importDecl, ...Array.from(visited.statements)]);
    };
}
```

- [ ] **Step 5.4: Run the tests**

```bash
npm test -- --testPathPattern=transformer
```

Expected: PASS, all tests.

- [ ] **Step 5.5: Commit**

```bash
git add src/transformer.ts src/transformer.test.ts
git commit -m "feat: add TypeScript transformer for @pre/@post contract injection"
```

---

## Task 6: Public API and Acceptance Criteria

**Files:**
- Create: `src/index.ts`
- Create: `test/fixtures/account.ts`

- [ ] **Step 6.1: Write the index tests**

Create `src/index.test.ts`:

```typescript
import { ContractViolationError } from './index';

describe('public API', () => {
  it('exports ContractViolationError', () => {
    expect(ContractViolationError).toBeDefined();
    const err = new ContractViolationError('PRE', 'x > 0', 'foo');
    expect(err).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 6.2: Run to verify it fails**

```bash
npm test -- --testPathPattern=src/index
```

Expected: FAIL — `Cannot find module './index'`

- [ ] **Step 6.3: Implement index.ts**

Create `src/index.ts`:

```typescript
export { ContractViolationError } from './contract-violation-error';
export { default as transformer } from './transformer';
```

- [ ] **Step 6.4: Run to verify it passes**

```bash
npm test -- --testPathPattern=src/index
```

Expected: PASS.

- [ ] **Step 6.5: Create the acceptance-criteria fixture**

Create `test/fixtures/account.ts` (this is not a test file — it is the example that the dev build transforms):

```typescript
import { ContractViolationError } from 'fsprepost';

// ContractViolationError is imported here only to satisfy the type-checker
// when running this file directly. The transformer will inject its own import.
void ContractViolationError;

export class Account {
  public balance: number = 100;

  /**
   * @pre amount > 0
   * @pre amount <= this.balance
   * @post result === this.balance
   */
  public withdraw(amount: number): number {
    this.balance -= amount;
    return this.balance;
  }
}
```

- [ ] **Step 6.6: Run all tests and check coverage**

```bash
npm run test:coverage
```

Expected: PASS, all tests. Coverage at or above 80% across branches, functions, lines, statements. If coverage is below 80% on any metric, add targeted tests for the uncovered branches (check the coverage HTML report in `coverage/lcov-report/index.html`).

- [ ] **Step 6.7: Run lint**

```bash
npm run lint
```

Expected: No errors. Fix any errors before proceeding.

- [ ] **Step 6.8: Run typecheck**

```bash
npm run typecheck
```

Expected: No errors.

- [ ] **Step 6.9: Commit**

```bash
git add src/index.ts src/index.test.ts test/fixtures/account.ts
git commit -m "feat: add public API index and acceptance fixture"
```

---

## Task 7: Verify Acceptance Criteria

These are the acceptance criteria from spec 002. Run them manually to confirm the full pipeline works end to end.

- [ ] **Step 7.1: Build the dev version**

```bash
npm run build:dev
```

Expected: Compiles without errors. `dist/` contains the compiled output with contract checks injected into the fixture.

- [ ] **Step 7.2: Verify pre-condition fires on bad input**

Create a temporary script `test-acceptance.mjs` in the project root:

```javascript
import { Account } from './dist/test/fixtures/account.js';

const account = new Account();

// Should throw ContractViolationError with type PRE
try {
  account.withdraw(-1);
  console.error('FAIL: expected ContractViolationError, got nothing');
  process.exit(1);
} catch (err) {
  if (err.type === 'PRE' && err.expression === 'amount > 0') {
    console.log('PASS: pre-condition fired correctly');
  } else {
    console.error('FAIL: wrong error:', err);
    process.exit(1);
  }
}

// Should succeed on valid input
const result = account.withdraw(50);
if (result === 50) {
  console.log('PASS: withdraw(50) returned 50');
} else {
  console.error('FAIL: expected 50, got', result);
  process.exit(1);
}

console.log('All acceptance criteria passed.');
```

```bash
node test-acceptance.mjs
```

Expected output:
```
PASS: pre-condition fired correctly
PASS: withdraw(50) returned 50
All acceptance criteria passed.
```

- [ ] **Step 7.3: Verify release build has zero contract code**

```bash
npm run build
grep -r 'ContractViolationError' dist/test/fixtures/account.js && echo "FAIL: contract code found in release build" || echo "PASS: zero contract code in release build"
```

Expected: `PASS: zero contract code in release build`

- [ ] **Step 7.4 (Acceptance criterion 4): Verify malformed expression compiles with warning**

Add this to `test/fixtures/account.ts` temporarily, then run `npm run build:dev`:

```typescript
/** @pre amount > */
export function brokenContract(amount: number): number { return amount; }
```

Expected: `build:dev` completes (does not crash), `brokenContract` body is unmodified in output, and a `[WARNING]` line appears in compiler output identifying the file and reason.

> **Note:** Diagnostic emission requires the full `ts-patch` Program API. The unit test in Step 5.1 covers the no-crash guarantee via `transpileModule`. The warning output from the actual ts-patch run verifies criterion 4 fully. Remove the test function after verifying.

- [ ] **Step 7.5: Delete the temporary acceptance script**

```bash
rm test-acceptance.mjs
```

- [ ] **Step 7.6: Final commit**

```bash
git add -A
git commit -m "chore: verify acceptance criteria — MVP complete"
```

---

## Known Limitations (from spec 002)

The following are explicitly out of scope for this MVP. Do not attempt to fix them during implementation — capture them as issues instead.

| Limitation | Risk |
| :--- | :--- |
| No `async`/`Promise` support | `@post` fires before promise resolves |
| No `@invariant` | Class-level state not enforced |
| No inheritance of invariants | Subclass contracts incomplete |
| No `#private` field access in expressions | Private state unverifiable |
| No warning on `@pre`/`@post` on private methods | Silent skip with no feedback |
| `const result` name collision | If original function declares `const result`, compilation breaks |
| Stack traces point to injection site, not caller | Slightly harder to locate the bug |