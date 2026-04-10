# Multi-Level Property Chain Validation — Design Doc

**Date:** 2026-04-10
**Covers limitation:** #9 (multi-level property chains)

---

## 1. Problem

`collectUnknownIdentifiers` in `contract-validator.ts` handles `PropertyAccessExpression` by recursing only into `node.expression` (the base object). The property name (`node.name`) is never validated. For the expression `this.config.limit`:

- `this` is checked (it is in the known identifier set).
- `config` is never checked.
- `limit` is never checked.

A typo like `this.balanc` (missing `e`) passes validation silently, is injected into the compiled output, and fails at runtime with a `TypeError` instead of a compile-time warning.

---

## 2. Goal

When a TypeChecker is available, validate that each step in a property access chain refers to an actually declared member. Emit a warning and drop the contract when a property does not exist on the accessed type.

In transpileModule mode (no TypeChecker), the current behaviour is preserved — no change.

---

## 3. Approach

Contract expressions are re-parsed from strings into a new source file, so their AST nodes have no connection to the original TypeScript program. The TypeChecker cannot resolve symbols on re-parsed nodes directly.

The approach is to walk the **structure** of the property access chain (root identifier + sequence of property names) and resolve each step against the TypeChecker using the original program context:

1. Extract the chain: `this.config.limit` → root `'this'`, then properties `['config', 'limit']`.
2. Resolve the root type from the original node (e.g. the class type for `this`, or the parameter declaration type for a parameter).
3. For each property name in the chain, call `checker.getPropertyOfType(currentType, name)`.
4. If `getPropertyOfType` returns `undefined`, the property does not exist → emit a warning.

This avoids needing the re-parsed expression nodes to carry type information.

---

## 4. Architecture

### 4.1 Chain extraction helper (`src/contract-validator.ts`)

```typescript
interface PropertyChain {
  root: string;
  properties: string[];
}

function extractPropertyChain(node: typescript.Node): PropertyChain | undefined {
  if (typescript.isPropertyAccessExpression(node)) {
    const inner = extractPropertyChain(node.expression);
    if (inner === undefined) return undefined;
    return { root: inner.root, properties: [...inner.properties, node.name.text] };
  }
  if (typescript.isIdentifier(node)) {
    return { root: node.text, properties: [] };
  }
  return undefined; // call expressions, element access, etc. — not handled
}
```

### 4.2 Root type resolution (`src/contract-validator.ts`)

```typescript
function resolveRootType(
  rootName: string,
  checker: typescript.TypeChecker,
  contextNode: typescript.FunctionLikeDeclaration,
): typescript.Type | undefined {
  if (rootName === 'this') {
    // Get the instance type of the enclosing class — see Section 5 for details.
    if (typescript.isClassDeclaration(contextNode.parent) && contextNode.parent.name) {
      const classSymbol = checker.getSymbolAtLocation(contextNode.parent.name);
      if (classSymbol !== undefined) {
        return checker.getDeclaredTypeOfSymbol(classSymbol);
      }
    }
    return undefined;
  }
  // Find matching parameter in the original declaration
  for (const param of contextNode.parameters) {
    if (typescript.isIdentifier(param.name) && param.name.text === rootName) {
      return checker.getTypeAtLocation(param);
    }
  }
  return undefined;
}
```

### 4.3 New chain validator: `collectDeepPropertyErrors`

```typescript
function collectDeepPropertyErrors(
  node: typescript.Node,
  expression: string,
  location: string,
  checker: typescript.TypeChecker,
  contextNode: typescript.FunctionLikeDeclaration,
  errors: ValidationError[],
): void {
  if (typescript.isPropertyAccessExpression(node)) {
    const chain = extractPropertyChain(node);
    if (chain !== undefined && chain.properties.length > 0) {
      const rootType = resolveRootType(chain.root, checker, contextNode);
      if (rootType !== undefined) {
        let currentType: typescript.Type = rootType;
        for (const prop of chain.properties) {
          const symbol = checker.getPropertyOfType(currentType, prop);
          if (symbol === undefined) {
            errors.push({
              kind: 'unknown-identifier',
              expression,
              location,
              message: `property '${prop}' does not exist on type '${checker.typeToString(currentType)}'`,
            });
            break; // stop at first missing step in the chain
          }
          currentType = checker.getTypeOfSymbol(symbol);
        }
      }
    }
  }
  typescript.forEachChild(node, (child) =>
    collectDeepPropertyErrors(child, expression, location, checker, contextNode, errors));
}
```

### 4.4 `validateExpression` signature extension (`src/contract-validator.ts`)

```typescript
export function validateExpression(
  node: typescript.Expression,
  expression: string,
  location: string,
  knownIdentifiers?: Set<string>,
  paramTypes?: Map<string, SimpleType>,
  checker?: typescript.TypeChecker,
  contextNode?: typescript.FunctionLikeDeclaration,
): ValidationError[]
```

When both `checker` and `contextNode` are provided, `collectDeepPropertyErrors` is called after the existing checks. Existing call sites pass nothing for the new parameters — no breaking changes.

### 4.5 Threading through `function-rewriter.ts`

`filterValidTags` receives `checker` and `node` (already available in `rewriteFunction`) and forwards them to `validateExpression`.

---

## 5. `this` Type Resolution Note

`checker.getTypeAtLocation(classDeclaration)` returns the static (constructor) type, not the instance type. `resolveRootType` uses `checker.getDeclaredTypeOfSymbol(classSymbol)` instead, which returns the declared instance type — the type that `this.someProperty` resolves against inside instance methods.

---

## 6. Checker Availability

This feature requires a full TypeChecker. In transpileModule mode:
- `checker` is `undefined`
- `collectDeepPropertyErrors` is not called
- Current shallow validation only (no change in behaviour)

No warning is emitted about missing deep validation in transpileModule mode.

---

## 7. Testing Plan

- `@pre this.balanc > 0` on `BankAccount` (which has `balance` not `balanc`) → unknown-identifier warning, contract dropped
- `@pre this.balance > 0` on `BankAccount` (correct) → injected, no warning
- `@pre this.config.limit > 0` where `config` exists on the class but `limit` does not exist on the `config` type → warning at `limit`, contract dropped
- `@pre this.config.limit > 0` where both `config` and `limit` exist → injected, no warning
- In transpileModule mode: `@pre this.balanc > 0` → no warning, contract injected as before
- Standalone function (`this` not in scope): no deep chain validation attempted

---

## 8. Out of Scope

- Property chains on non-`this` identifier roots where the root is a destructured binding or module-level symbol — the same `resolveRootType` approach extends naturally but is not required by this spec.
- Optional chaining (`this.config?.limit`) — requires handling `OptionalChain` nodes; deferred.
- Index signatures and computed property names — not validated.
- Property chains in `@invariant` expressions — deferred; invariant expressions share the same validator but the `contextNode` threading needs to be verified for class-level invariant checks.
