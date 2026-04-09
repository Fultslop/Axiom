# Flat Module Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Break `transformer.ts` (632 lines) and `ast-builder.ts` (471 lines) into focused modules with one clear responsibility each, without changing any observable behaviour.

**Architecture:** Pure extract-and-move refactor. No new abstractions. Seven focused files replace two large ones. The import graph flows in one direction: `transformer.ts` → `function-rewriter.ts` / `class-rewriter.ts` → `ast-builder.ts` → `reifier.ts`. Shared node helpers and type helpers live in their own modules consumed by the rewriters. Each extraction is a green-bar commit — tests must pass after every task.

**Tech Stack:** TypeScript, Jest (128 tests must stay green throughout), ESLint (id-length ≥ 3, max-len 100, complexity ≤ 10, no bare `return;`).

---

## ESLint Constraints (read before touching any `src/` file)

- **`id-length: min 3`** — No identifiers shorter than 3 characters. Use `typescript` not `ts`.
- **No bare `return;`** — restructure with guards.
- **`complexity: 10`** — keep functions small, extract helpers.
- **`max-len: 100`** — lines under 100 chars.
- **No `console`** — use the injectable `warn` callback.

---

## File Map (target state)

| File | Responsibility | Status |
| :--- | :--- | :--- |
| `src/reifier.ts` | `reifyExpression`, `reifyStatement` and their helpers — pure AST node reconstruction | **Create** |
| `src/node-helpers.ts` | `isPublicTarget`, `buildLocationName`, `buildKnownIdentifiers` | **Create** |
| `src/type-helpers.ts` | `simpleTypeFromFlags`, `buildParameterTypes`, `buildPostParamTypes` | **Create** |
| `src/reparsed-index.ts` | `buildReparsedIndex` + `ReparsedIndex` type | **Create** |
| `src/ast-builder.ts` | Trimmed: contract-specific builders only (`buildPreCheck`, `buildPostCheck`, `buildBodyCapture`, `buildResultReturn`, `buildCheckInvariantsCall`, `buildCheckInvariantsMethod`, `parseContractExpression`) | **Trim** |
| `src/function-rewriter.ts` | `rewriteFunction`, `tryRewriteFunction`, `applyNewBody`, `buildGuardedStatements`, `buildInvariantCallIfNeeded`, `filterValidTags` | **Create** |
| `src/class-rewriter.ts` | `rewriteClass`, `tryRewriteClass`, `rewriteConstructor`, `rewriteMember`, `resolveEffectiveInvariants`, `filterValidInvariants`, `hasClashingMember` | **Create** |
| `src/transformer.ts` | Trimmed: `createTransformer`, `visitNode`, `buildRequireStatement`, `buildReparsedIndex` call | **Trim** |

**Import graph:**
```
transformer.ts
  ├── reparsed-index.ts
  ├── function-rewriter.ts
  │     ├── ast-builder.ts → reifier.ts
  │     ├── node-helpers.ts
  │     ├── type-helpers.ts
  │     └── contract-validator.ts (existing)
  └── class-rewriter.ts
        ├── function-rewriter.ts
        ├── ast-builder.ts
        ├── node-helpers.ts
        └── jsdoc-parser.ts (existing)
```

---

## Task 1: Extract `reifier.ts`

Move `reifyExpression`, `reifyStatement`, and all their private helpers out of `ast-builder.ts` into a new dedicated file. `ast-builder.ts` then imports `reifyExpression`/`reifyStatement` from it.

**Files:**
- Create: `src/reifier.ts`
- Modify: `src/ast-builder.ts`

- [ ] **Step 1.1: Run tests to confirm green baseline**

```bash
npm test
```

Expected: `Tests: 128 passed, 128 total`

- [ ] **Step 1.2: Create `src/reifier.ts`**

```typescript
import typescript from 'typescript';

/**
 * Rebuilds keyword / literal expression nodes using factory calls, producing
 * fully synthesized AST nodes. Returns undefined when the node is not a
 * keyword or literal handled here.
 */
function reifyLiteralOrKeyword(
  factory: typescript.NodeFactory,
  node: typescript.Expression,
): typescript.Expression | undefined {
  if (typescript.isIdentifier(node)) {
    return factory.createIdentifier(node.text);
  }
  if (typescript.isNumericLiteral(node)) {
    return factory.createNumericLiteral(node.text);
  }
  if (typescript.isStringLiteral(node)) {
    return factory.createStringLiteral(node.text);
  }
  if (node.kind === typescript.SyntaxKind.NullKeyword) {
    return factory.createNull();
  }
  if (node.kind === typescript.SyntaxKind.TrueKeyword) {
    return factory.createTrue();
  }
  if (node.kind === typescript.SyntaxKind.FalseKeyword) {
    return factory.createFalse();
  }
  if (node.kind === typescript.SyntaxKind.ThisKeyword) {
    return factory.createThis();
  }
  return undefined;
}

/* eslint-disable @typescript-eslint/no-use-before-define */
function reifyCompositeExpression(
  factory: typescript.NodeFactory,
  node: typescript.Expression,
): typescript.Expression | undefined {
  if (typescript.isConditionalExpression(node)) {
    return factory.createConditionalExpression(
      reifyExpression(factory, node.condition),
      factory.createToken(typescript.SyntaxKind.QuestionToken),
      reifyExpression(factory, node.whenTrue),
      factory.createToken(typescript.SyntaxKind.ColonToken),
      reifyExpression(factory, node.whenFalse),
    );
  }
  if (typescript.isCallExpression(node)) {
    return factory.createCallExpression(
      reifyExpression(factory, node.expression),
      undefined,
      Array.from(node.arguments).map((arg) => reifyExpression(factory, arg)),
    );
  }
  if (typescript.isElementAccessExpression(node)) {
    return factory.createElementAccessExpression(
      reifyExpression(factory, node.expression),
      reifyExpression(factory, node.argumentExpression),
    );
  }
  return undefined;
}

/**
 * Rebuilds an expression node entirely using factory calls, producing a fully
 * synthesized AST (no source-file text positions) so the printer can emit it
 * against any SourceFile — including a dummy empty one.
 *
 * Supports the subset of expression node types that appear in typical
 * design-by-contract assertions.
 */
export function reifyExpression(
  factory: typescript.NodeFactory,
  node: typescript.Expression,
): typescript.Expression {
  const literalResult = reifyLiteralOrKeyword(factory, node);
  if (literalResult !== undefined) {
    return literalResult;
  }

  if (typescript.isBinaryExpression(node)) {
    return factory.createBinaryExpression(
      reifyExpression(factory, node.left),
      node.operatorToken.kind,
      reifyExpression(factory, node.right),
    );
  }

  if (typescript.isPrefixUnaryExpression(node)) {
    return factory.createPrefixUnaryExpression(
      node.operator,
      reifyExpression(factory, node.operand),
    );
  }

  if (typescript.isPostfixUnaryExpression(node)) {
    return factory.createPostfixUnaryExpression(
      reifyExpression(factory, node.operand),
      node.operator,
    );
  }

  if (typescript.isParenthesizedExpression(node)) {
    return factory.createParenthesizedExpression(reifyExpression(factory, node.expression));
  }

  if (typescript.isPropertyAccessExpression(node)) {
    return factory.createPropertyAccessExpression(
      reifyExpression(factory, node.expression),
      factory.createIdentifier(node.name.text),
    );
  }

  if (typescript.isTypeOfExpression(node)) {
    return factory.createTypeOfExpression(reifyExpression(factory, node.expression));
  }

  const compositeResult = reifyCompositeExpression(factory, node);
  if (compositeResult !== undefined) {
    return compositeResult;
  }

  throw new Error(`Unsupported expression node kind: ${typescript.SyntaxKind[node.kind]}`);
}

function reifyForInitializer(
  factory: typescript.NodeFactory,
  node: typescript.ForInitializer,
): typescript.ForInitializer {
  if (typescript.isVariableDeclarationList(node)) {
    return factory.createVariableDeclarationList(
      Array.from(node.declarations).map((decl) =>
        factory.createVariableDeclaration(
          typescript.isIdentifier(decl.name)
            ? factory.createIdentifier(decl.name.text)
            : decl.name,
          undefined,
          undefined,
          decl.initializer ? reifyExpression(factory, decl.initializer) : undefined,
        ),
      ),
      node.flags,
    );
  }
  return reifyExpression(factory, node);
}

function reifyIfStatement(
  factory: typescript.NodeFactory,
  node: typescript.IfStatement,
): typescript.IfStatement {
  return factory.createIfStatement(
    reifyExpression(factory, node.expression),
    reifyStatement(factory, node.thenStatement),
    node.elseStatement !== undefined ? reifyStatement(factory, node.elseStatement) : undefined,
  );
}

function reifyLoopStatement(
  factory: typescript.NodeFactory,
  node: typescript.Statement,
): typescript.Statement | undefined {
  if (typescript.isForOfStatement(node)) {
    return factory.createForOfStatement(
      node.awaitModifier,
      reifyForInitializer(factory, node.initializer),
      reifyExpression(factory, node.expression),
      reifyStatement(factory, node.statement),
    );
  }
  if (typescript.isForInStatement(node)) {
    return factory.createForInStatement(
      reifyForInitializer(factory, node.initializer),
      reifyExpression(factory, node.expression),
      reifyStatement(factory, node.statement),
    );
  }
  if (typescript.isForStatement(node)) {
    return factory.createForStatement(
      node.initializer ? reifyForInitializer(factory, node.initializer) : undefined,
      node.condition ? reifyExpression(factory, node.condition) : undefined,
      node.incrementor ? reifyExpression(factory, node.incrementor) : undefined,
      reifyStatement(factory, node.statement),
    );
  }
  if (typescript.isWhileStatement(node)) {
    return factory.createWhileStatement(
      reifyExpression(factory, node.expression),
      reifyStatement(factory, node.statement),
    );
  }
  if (typescript.isDoStatement(node)) {
    return factory.createDoStatement(
      reifyStatement(factory, node.statement),
      reifyExpression(factory, node.expression),
    );
  }
  if (typescript.isSwitchStatement(node)) {
    return factory.createSwitchStatement(
      reifyExpression(factory, node.expression),
      factory.createCaseBlock(
        Array.from(node.caseBlock.clauses).map((clause) => reifyCaseClause(factory, clause)),
      ),
    );
  }
  return undefined;
}

function reifyCaseClause(
  factory: typescript.NodeFactory,
  clause: typescript.CaseOrDefaultClause,
): typescript.CaseOrDefaultClause {
  const stmts = Array.from(clause.statements).map((stmt) => reifyStatement(factory, stmt));
  if (typescript.isCaseClause(clause)) {
    return factory.createCaseClause(reifyExpression(factory, clause.expression), stmts);
  }
  return factory.createDefaultClause(stmts);
}

/* eslint-enable @typescript-eslint/no-use-before-define */

/**
 * Rebuilds a statement node using factory calls, producing a fully synthesized
 * AST for printing against any SourceFile.
 */
export function reifyStatement(
  factory: typescript.NodeFactory,
  node: typescript.Statement,
): typescript.Statement {
  if (typescript.isExpressionStatement(node)) {
    return factory.createExpressionStatement(reifyExpression(factory, node.expression));
  }

  if (typescript.isReturnStatement(node)) {
    return factory.createReturnStatement(
      node.expression !== undefined ? reifyExpression(factory, node.expression) : undefined,
    );
  }

  if (typescript.isVariableStatement(node)) {
    return factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        Array.from(node.declarationList.declarations).map((decl) =>
          factory.createVariableDeclaration(
            typescript.isIdentifier(decl.name)
              ? factory.createIdentifier(decl.name.text)
              : decl.name,
            undefined,
            undefined,
            decl.initializer !== undefined
              ? reifyExpression(factory, decl.initializer)
              : undefined,
          ),
        ),
        node.declarationList.flags,
      ),
    );
  }

  if (typescript.isIfStatement(node)) {
    return reifyIfStatement(factory, node);
  }

  if (typescript.isBlock(node)) {
    return factory.createBlock(
      Array.from(node.statements).map((stmt) => reifyStatement(factory, stmt)),
      true,
    );
  }

  if (typescript.isBreakStatement(node)) {
    return factory.createBreakStatement(node.label);
  }

  if (typescript.isContinueStatement(node)) {
    return factory.createContinueStatement(node.label);
  }

  const loopResult = reifyLoopStatement(factory, node);
  if (loopResult !== undefined) {
    return loopResult;
  }

  throw new Error(`Unsupported statement node kind: ${typescript.SyntaxKind[node.kind]}`);
}
```

- [ ] **Step 1.3: Trim `src/ast-builder.ts` — replace reify* functions with an import**

Delete everything from line 1 through the closing `/* eslint-enable */` at line 225 (all of `reifyLiteralOrKeyword`, `reifyCompositeExpression`, `reifyExpression`, `reifyForInitializer`, `reifyIfStatement`, `reifyLoopStatement`, `reifyCaseClause`, `reifyStatement`) and replace the top of the file with:

```typescript
import typescript from 'typescript';
import { reifyExpression, reifyStatement } from './reifier';
```

The rest of `ast-builder.ts` (from `parseContractExpression` onward) stays unchanged.

- [ ] **Step 1.4: Run tests**

```bash
npm test
```

Expected: `Tests: 128 passed, 128 total`

- [ ] **Step 1.5: Run lint**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 1.6: Commit**

```bash
git add src/reifier.ts src/ast-builder.ts
git commit -m "refactor: extract reifier.ts — move reifyExpression/reifyStatement out of ast-builder"
```

---

## Task 2: Extract `reparsed-index.ts`

Move `buildReparsedIndex` and the `ReparsedIndex` interface out of `transformer.ts`.

**Files:**
- Create: `src/reparsed-index.ts`
- Modify: `src/transformer.ts`

- [ ] **Step 2.1: Create `src/reparsed-index.ts`**

```typescript
import typescript from 'typescript';

export interface ReparsedIndex {
  functions: Map<number, typescript.FunctionLikeDeclaration>;
  classes: Map<number, typescript.ClassDeclaration>;
}

/**
 * Re-parse the source file with setParentNodes:true so JSDoc nodes are
 * attached. Returns maps from source position to reparsed node.
 */
export function buildReparsedIndex(sourceFile: typescript.SourceFile): ReparsedIndex {
  const reparsed = typescript.createSourceFile(
    sourceFile.fileName,
    sourceFile.text,
    sourceFile.languageVersion,
    /* setParentNodes */ true,
  );

  const functions = new Map<number, typescript.FunctionLikeDeclaration>();
  const classes = new Map<number, typescript.ClassDeclaration>();

  function visit(node: typescript.Node): void {
    if (typescript.isFunctionLike(node)) {
      functions.set(node.pos, node as typescript.FunctionLikeDeclaration);
    }
    if (typescript.isClassDeclaration(node)) {
      classes.set(node.pos, node);
    }
    typescript.forEachChild(node, visit);
  }

  visit(reparsed);
  return { functions, classes };
}
```

- [ ] **Step 2.2: Update `src/transformer.ts` — remove local definition, add import**

Remove the `ReparsedIndex` interface and `buildReparsedIndex` function (lines 19–51 of the current file). Add to the imports at the top:

```typescript
import { buildReparsedIndex, type ReparsedIndex } from './reparsed-index';
```

- [ ] **Step 2.3: Run tests**

```bash
npm test
```

Expected: `Tests: 128 passed, 128 total`

- [ ] **Step 2.4: Run lint**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 2.5: Commit**

```bash
git add src/reparsed-index.ts src/transformer.ts
git commit -m "refactor: extract reparsed-index.ts — isolate source-file reparsing"
```

---

## Task 3: Extract `node-helpers.ts`

Move the three node-inspection helpers out of `transformer.ts`.

**Files:**
- Create: `src/node-helpers.ts`
- Modify: `src/transformer.ts`

- [ ] **Step 3.1: Create `src/node-helpers.ts`**

```typescript
import typescript from 'typescript';

export function isPublicTarget(node: typescript.FunctionLikeDeclaration): boolean {
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

export function buildLocationName(node: typescript.FunctionLikeDeclaration): string {
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

export function buildKnownIdentifiers(
  node: typescript.FunctionLikeDeclaration,
  includeResult: boolean,
): Set<string> {
  const names = new Set<string>(['this']);
  for (const param of node.parameters) {
    if (typescript.isIdentifier(param.name)) {
      names.add(param.name.text);
    }
  }
  if (includeResult) {
    names.add('result');
  }
  return names;
}
```

- [ ] **Step 3.2: Update `src/transformer.ts` — remove local definitions, add import**

Remove `isPublicTarget` (lines 57–75), `buildLocationName` (lines 81–95), and `buildKnownIdentifiers` (lines 155–169) from `transformer.ts`. Add to imports:

```typescript
import { isPublicTarget, buildLocationName, buildKnownIdentifiers } from './node-helpers';
```

- [ ] **Step 3.3: Run tests**

```bash
npm test
```

Expected: `Tests: 128 passed, 128 total`

- [ ] **Step 3.4: Run lint**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 3.5: Commit**

```bash
git add src/node-helpers.ts src/transformer.ts
git commit -m "refactor: extract node-helpers.ts — isPublicTarget, buildLocationName, buildKnownIdentifiers"
```

---

## Task 4: Extract `type-helpers.ts`

Move the three TypeChecker-dependent helpers out of `transformer.ts`.

**Files:**
- Create: `src/type-helpers.ts`
- Modify: `src/transformer.ts`

- [ ] **Step 4.1: Create `src/type-helpers.ts`**

```typescript
import typescript from 'typescript';

export type SimpleType = 'number' | 'string' | 'boolean';

export function simpleTypeFromFlags(flags: number): SimpleType | undefined {
  /* eslint-disable no-bitwise */
  if (flags & typescript.TypeFlags.NumberLike) {
    return 'number';
  }
  if (flags & typescript.TypeFlags.StringLike) {
    return 'string';
  }
  if (flags & typescript.TypeFlags.BooleanLike) {
    return 'boolean';
  }
  /* eslint-enable no-bitwise */
  return undefined;
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
    }
  }
  return types;
}

export function buildPostParamTypes(
  node: typescript.FunctionLikeDeclaration,
  checker: typescript.TypeChecker | undefined,
  base: Map<string, SimpleType> | undefined,
): Map<string, SimpleType> | undefined {
  if (checker === undefined || base === undefined) {
    return base;
  }
  const sig = checker.getSignatureFromDeclaration(node);
  if (sig === undefined) {
    return base;
  }
  const returnType = checker.getReturnTypeOfSignature(sig);
  const resultSimpleType = simpleTypeFromFlags(returnType.flags);
  if (resultSimpleType === undefined) {
    return base;
  }
  const extended = new Map(base);
  extended.set('result', resultSimpleType);
  return extended;
}
```

- [ ] **Step 4.2: Update `src/transformer.ts` — remove local definitions and stale import, add new import**

Remove `simpleTypeFromFlags` (lines 101–114), `buildParameterTypes` (lines 116–131), and `buildPostParamTypes` (lines 133–153) from `transformer.ts`.

Remove the existing `import type { SimpleType } from './contract-validator';` line.

Add to imports:

```typescript
import {
  buildParameterTypes, buildPostParamTypes, type SimpleType,
} from './type-helpers';
```

- [ ] **Step 4.3: Run tests**

```bash
npm test
```

Expected: `Tests: 128 passed, 128 total`

- [ ] **Step 4.4: Run lint**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 4.5: Commit**

```bash
git add src/type-helpers.ts src/transformer.ts
git commit -m "refactor: extract type-helpers.ts — simpleTypeFromFlags, buildParameterTypes, buildPostParamTypes"
```

---

## Task 5: Extract `function-rewriter.ts`

Move all function-level rewriting logic out of `transformer.ts`.

**Files:**
- Create: `src/function-rewriter.ts`
- Modify: `src/transformer.ts`

- [ ] **Step 5.1: Create `src/function-rewriter.ts`**

```typescript
import typescript from 'typescript';
import {
  buildPreCheck, buildPostCheck, buildBodyCapture, buildResultReturn,
  parseContractExpression, buildCheckInvariantsCall,
} from './ast-builder';
import { validateExpression } from './contract-validator';
import { buildLocationName, buildKnownIdentifiers, isPublicTarget } from './node-helpers';
import { buildParameterTypes, buildPostParamTypes, type SimpleType } from './type-helpers';
import type { ContractTag } from './jsdoc-parser';
import { extractContractTags } from './jsdoc-parser';

const KIND_PRE = 'pre' as const;
const KIND_POST = 'post' as const;

export function filterValidTags(
  tags: ContractTag[],
  kind: 'pre' | 'post',
  location: string,
  warn: (msg: string) => void,
  knownIdentifiers: Set<string>,
  paramTypes?: Map<string, SimpleType>,
): ContractTag[] {
  return tags.filter((tag) => {
    const errors = validateExpression(
      parseContractExpression(tag.expression),
      tag.expression,
      location,
      knownIdentifiers,
      paramTypes,
    );
    if (errors.length > 0) {
      errors.forEach((err) => {
        warn(
          `[fsprepost] Contract validation warning in ${location}:`
          + `\n  @${kind} ${err.expression} — ${err.message}`,
        );
      });
      return false;
    }
    return true;
  });
}

function buildGuardedStatements(
  factory: typescript.NodeFactory,
  preTags: ContractTag[],
  postTags: ContractTag[],
  originalBody: typescript.Block,
  location: string,
  invariantCall: typescript.ExpressionStatement | null,
): typescript.Statement[] {
  const statements: typescript.Statement[] = [];

  for (const tag of preTags) {
    statements.push(buildPreCheck(tag.expression, location, factory));
  }

  if (postTags.length > 0 || invariantCall !== null) {
    statements.push(buildBodyCapture(originalBody.statements, factory));
    for (const tag of postTags) {
      statements.push(buildPostCheck(tag.expression, location, factory));
    }
    if (invariantCall !== null) {
      statements.push(invariantCall);
    }
    statements.push(buildResultReturn(factory));
  } else {
    statements.push(...Array.from(originalBody.statements));
  }

  return statements;
}

export function applyNewBody(
  factory: typescript.NodeFactory,
  node: typescript.FunctionLikeDeclaration,
  newBody: typescript.Block,
): typescript.FunctionLikeDeclaration | null {
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

function buildInvariantCallIfNeeded(
  factory: typescript.NodeFactory,
  node: typescript.FunctionLikeDeclaration,
  location: string,
  invariantExpressions: string[],
): typescript.ExpressionStatement | null {
  if (invariantExpressions.length > 0 && typescript.isMethodDeclaration(node)) {
    return buildCheckInvariantsCall(location, factory);
  }
  return null;
}

function rewriteFunction(
  factory: typescript.NodeFactory,
  node: typescript.FunctionLikeDeclaration,
  reparsedFunctions: Map<number, typescript.FunctionLikeDeclaration>,
  warn: (msg: string) => void,
  checker?: typescript.TypeChecker,
  invariantExpressions: string[] = [],
): typescript.FunctionLikeDeclaration | null {
  const originalBody = node.body;
  if (!originalBody || !typescript.isBlock(originalBody)) {
    return null;
  }

  const reparsedNode = reparsedFunctions.get(node.pos) ?? node;
  const tags = extractContractTags(reparsedNode);

  const location = buildLocationName(node);
  const preKnown = buildKnownIdentifiers(node, false);
  const postKnown = buildKnownIdentifiers(node, true);
  const paramTypes = checker !== undefined ? buildParameterTypes(node, checker) : undefined;
  const postParamTypes = buildPostParamTypes(node, checker, paramTypes);
  const preTags = filterValidTags(
    tags.filter((tag) => tag.kind === KIND_PRE), KIND_PRE, location, warn, preKnown, paramTypes,
  );
  const postTags = filterValidTags(
    tags.filter((tag) => tag.kind === KIND_POST),
    KIND_POST, location, warn, postKnown, postParamTypes,
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

export function tryRewriteFunction(
  factory: typescript.NodeFactory,
  node: typescript.FunctionLikeDeclaration,
  reparsedFunctions: Map<number, typescript.FunctionLikeDeclaration>,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker?: typescript.TypeChecker,
  invariantExpressions: string[] = [],
): typescript.FunctionLikeDeclaration {
  try {
    const rewritten = rewriteFunction(
      factory, node, reparsedFunctions, warn, checker, invariantExpressions,
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

export { isPublicTarget };
```

- [ ] **Step 5.2: Update `src/transformer.ts` — remove extracted functions, add import**

Remove from `transformer.ts`:
- `KIND_PRE`, `KIND_POST` constants
- `filterValidTags`
- `buildGuardedStatements`
- `applyNewBody`
- `buildInvariantCallIfNeeded`
- `rewriteFunction`
- `tryRewriteFunction`

Remove these imports (now handled inside `function-rewriter.ts`):
- `import { extractContractTags, ... } from './jsdoc-parser'`
- `import { buildPreCheck, buildBodyCapture, ... } from './ast-builder'`
- `import { validateExpression } from './contract-validator'`
- `import type { ContractTag } from './jsdoc-parser'`
- The `buildParameterTypes`, `buildPostParamTypes`, `SimpleType` import from `./type-helpers`
- The `buildKnownIdentifiers` import from `./node-helpers`

Add to imports at the top of `transformer.ts`:

```typescript
import { tryRewriteFunction, isPublicTarget } from './function-rewriter';
```

Keep the existing imports: `buildReparsedIndex`, `buildLocationName` (still used in `buildReparsedIndex` call site), `reparsed-index`, `node-helpers` as needed.

> **Note:** After this step `transformer.ts` still directly uses `buildLocationName` (via `buildReparsedIndex`'s result in `visitNode`) and `isPublicTarget` — both re-exported from `function-rewriter.ts` or still imported from `node-helpers.ts`. Check which imports remain needed and keep only those.

- [ ] **Step 5.3: Run tests**

```bash
npm test
```

Expected: `Tests: 128 passed, 128 total`

- [ ] **Step 5.4: Run lint**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 5.5: Commit**

```bash
git add src/function-rewriter.ts src/transformer.ts
git commit -m "refactor: extract function-rewriter.ts — move function/method rewriting out of transformer"
```

---

## Task 6: Extract `class-rewriter.ts`

Move all class-level rewriting logic out of `transformer.ts`.

**Files:**
- Create: `src/class-rewriter.ts`
- Modify: `src/transformer.ts`

- [ ] **Step 6.1: Create `src/class-rewriter.ts`**

```typescript
import typescript from 'typescript';
import { buildCheckInvariantsCall, buildCheckInvariantsMethod, parseContractExpression } from './ast-builder';
import { extractInvariantExpressions } from './jsdoc-parser';
import { validateExpression } from './contract-validator';
import { tryRewriteFunction, isPublicTarget } from './function-rewriter';
import type { ReparsedIndex } from './reparsed-index';

const CHECK_INVARIANTS_NAME = '#checkInvariants' as const;

export function filterValidInvariants(
  expressions: string[],
  className: string,
  warn: (msg: string) => void,
): string[] {
  const knownIdentifiers = new Set(['this']);
  return expressions.filter((expr) => {
    const errors = validateExpression(
      parseContractExpression(expr),
      expr,
      className,
      knownIdentifiers,
    );
    if (errors.length > 0) {
      errors.forEach((err) => {
        warn(
          `[fsprepost] Invariant validation warning in ${className}:`
          + `\n  @invariant ${err.expression} — ${err.message}`,
        );
      });
      return false;
    }
    return true;
  });
}

function hasClashingMember(node: typescript.ClassDeclaration): boolean {
  return node.members.some(
    (member) =>
      (typescript.isMethodDeclaration(member) || typescript.isPropertyDeclaration(member)) &&
      typescript.isPrivateIdentifier(member.name) &&
      member.name.text === CHECK_INVARIANTS_NAME,
  );
}

function rewriteConstructor(
  factory: typescript.NodeFactory,
  node: typescript.ConstructorDeclaration,
  className: string,
): typescript.ConstructorDeclaration {
  const originalBody = node.body;
  if (!originalBody) {
    return node;
  }
  const location = `${className}.constructor`;
  const newStatements = [
    ...Array.from(originalBody.statements),
    buildCheckInvariantsCall(location, factory),
  ];
  return factory.updateConstructorDeclaration(
    node,
    typescript.getModifiers(node),
    node.parameters,
    factory.createBlock(newStatements, true),
  );
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
): { element: typescript.ClassElement; changed: boolean } {
  if (typescript.isMethodDeclaration(member) && isPublicTarget(member)) {
    const rewritten = tryRewriteFunction(
      factory, member, reparsedIndex.functions, transformed, warn, checker, effectiveInvariants,
    );
    return { element: rewritten as typescript.MethodDeclaration, changed: rewritten !== member };
  }
  if (typescript.isConstructorDeclaration(member) && effectiveInvariants.length > 0) {
    return { element: rewriteConstructor(factory, member, className), changed: true };
  }
  return { element: member, changed: false };
}

function resolveEffectiveInvariants(
  node: typescript.ClassDeclaration,
  reparsedClass: typescript.ClassDeclaration | typescript.Node,
  className: string,
  warn: (msg: string) => void,
): string[] {
  const raw = extractInvariantExpressions(reparsedClass);
  const valid = filterValidInvariants(raw, className, warn);
  if (valid.length > 0 && hasClashingMember(node)) {
    const clashMsg = `${className}: ${CHECK_INVARIANTS_NAME} already defined`;
    warn(`[fsprepost] Cannot inject invariants into ${clashMsg}`);
    return [];
  }
  return valid;
}

function rewriteClass(
  factory: typescript.NodeFactory,
  node: typescript.ClassDeclaration,
  reparsedIndex: ReparsedIndex,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker?: typescript.TypeChecker,
): typescript.ClassDeclaration {
  const className = node.name?.text ?? 'UnknownClass';
  const reparsedClass = reparsedIndex.classes.get(node.pos) ?? node;
  const effectiveInvariants = resolveEffectiveInvariants(node, reparsedClass, className, warn);

  let classTransformed = false;
  const newMembers: typescript.ClassElement[] = [];

  for (const member of node.members) {
    const result = rewriteMember(
      factory, member, reparsedIndex, transformed, warn, checker, effectiveInvariants, className,
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

export function tryRewriteClass(
  factory: typescript.NodeFactory,
  node: typescript.ClassDeclaration,
  reparsedIndex: ReparsedIndex,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker?: typescript.TypeChecker,
): typescript.ClassDeclaration {
  try {
    return rewriteClass(factory, node, reparsedIndex, transformed, warn, checker);
  } catch {
    return node;
  }
}
```

- [ ] **Step 6.2: Update `src/transformer.ts` — remove extracted functions, add import**

Remove from `transformer.ts`:
- `CHECK_INVARIANTS_NAME` constant
- `hasClashingMember`
- `rewriteMember`
- `resolveEffectiveInvariants`
- `rewriteClass`
- `tryRewriteClass`
- `rewriteConstructor`
- `filterValidInvariants`

Remove any imports now handled inside `class-rewriter.ts` (e.g. `extractInvariantExpressions`).

Add to imports:

```typescript
import { tryRewriteClass } from './class-rewriter';
```

- [ ] **Step 6.3: Run tests**

```bash
npm test
```

Expected: `Tests: 128 passed, 128 total`

- [ ] **Step 6.4: Run lint**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 6.5: Commit**

```bash
git add src/class-rewriter.ts src/transformer.ts
git commit -m "refactor: extract class-rewriter.ts — move class/invariant rewriting out of transformer"
```

---

## Task 7: Verify final state and publish

Confirm sizes are in line with expectations, run full quality checks, bump patch version, and publish.

**Files:**
- Modify: `package.json` (version bump)

- [ ] **Step 7.1: Check final line counts**

```bash
wc -l src/reifier.ts src/reparsed-index.ts src/node-helpers.ts src/type-helpers.ts \
       src/function-rewriter.ts src/class-rewriter.ts src/ast-builder.ts src/transformer.ts
```

Expected rough targets (no file above ~150 lines):
- `reifier.ts` ~230 (large but single-purpose — pure AST reconstruction)
- `reparsed-index.ts` ~35
- `node-helpers.ts` ~55
- `type-helpers.ts` ~55
- `function-rewriter.ts` ~130
- `class-rewriter.ts` ~130
- `ast-builder.ts` ~180 (trimmed from 471)
- `transformer.ts` ~80 (trimmed from 632)

- [ ] **Step 7.2: Run full quality suite**

```bash
npm test && npm run lint && npm run typecheck
```

Expected: all pass, `Tests: 128 passed`.

- [ ] **Step 7.3: Bump patch version**

In `package.json`, increment the `"version"` field by one patch (e.g. `"1.2.3"` → `"1.2.4"`).

- [ ] **Step 7.4: Commit version bump**

```bash
git add package.json
git commit -m "chore: bump patch version for flat module split release"
```

- [ ] **Step 7.5: Publish to local Verdaccio**

```bash
npm publish
```

Expected: `+ fsprepost@<new-version>` published to `http://localhost:4873`.

---

## Self-Review

**Spec coverage:** The agreed Option 1 spec called for 7 focused files. This plan creates exactly those:
`reifier.ts`, `reparsed-index.ts`, `node-helpers.ts`, `type-helpers.ts`, `function-rewriter.ts`, `class-rewriter.ts`, plus trimmed `ast-builder.ts` and `transformer.ts`. ✓

**Placeholder scan:** No TBDs, no "implement later", no "similar to Task N". Every step has exact code or exact commands. ✓

**Type consistency:** `SimpleType` is defined in `type-helpers.ts` and imported from there in every subsequent task. `ReparsedIndex` defined in `reparsed-index.ts` and imported by `class-rewriter.ts`. `ContractTag` stays in `jsdoc-parser.ts` throughout. ✓

**Ordering note (Task 5 imports):** `transformer.ts` after Task 5 still needs `isPublicTarget` for `visitNode`'s function-declaration branch. It can import this from either `node-helpers.ts` or `function-rewriter.ts` (which re-exports it). Either works — pick one and be consistent. The plan re-exports from `function-rewriter.ts` to keep `transformer.ts`'s import list short.