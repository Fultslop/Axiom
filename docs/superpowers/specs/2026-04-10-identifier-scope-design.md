# Identifier Scope Gaps — Design Doc

**Date:** 2026-04-10
**Covers limitations:** #1 (destructured parameters), #4 (enum and external constant references), #5 (global objects not in whitelist)

---

## 1. Problem

Three related gaps cause valid contract expressions to be dropped with a spurious `unknown-identifier` warning:

1. **#5 — Missing globals**: `Math`, `Object`, `Array`, and other standard built-ins are absent from `GLOBAL_IDENTIFIERS`, so `@pre Math.abs(delta) < 1` warns and the contract is skipped.

2. **#1 — Destructured parameters**: `buildKnownIdentifiers` in `node-helpers.ts` only handles `isIdentifier(param.name)`. For `({ x, y }: Point)`, neither `x` nor `y` is added to the known set, and any contract that references them is dropped.

3. **#4 — Enum and module-level constants**: Identifiers like `Status` in `Status.Active` are not parameters and not in `GLOBAL_IDENTIFIERS`, so they trigger an unknown-identifier warning even when they are valid imported enum members or module-level constants.

All three share the same root: the known identifier set is built without awareness of scope-level symbols beyond parameters and a small hardcoded global list.

---

## 2. Goals

- Contracts referencing common built-in globals (`Math.abs`, `Object.keys`, `Array.isArray`, etc.) inject without warnings.
- Binding names from destructured parameters are recognised as known identifiers.
- Destructured binding types are included in type mismatch detection when a TypeChecker is available.
- Enum members and imported constants are recognised as valid when a TypeChecker is available.
- A transformer option provides a manual whitelist for non-checker environments (ts-jest with `isolatedModules: true`).

---

## 3. Fix #5 — Extend `GLOBAL_IDENTIFIERS`

**File:** `src/contract-validator.ts`

Extend the constant with standard built-ins commonly referenced in contract expressions:

```typescript
const GLOBAL_IDENTIFIERS = new Set([
  'undefined', 'NaN', 'Infinity', 'globalThis', 'arguments',
  // Built-in constructors and namespaces
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Math', 'JSON', 'Date', 'RegExp', 'Error',
  // Promise / async
  'Promise',
  // Utility functions
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent',
  // console (useful in dev contracts)
  'console',
]);
```

This is a standalone change with no architectural implications.

---

## 4. Fix #1 — Destructured Parameter Binding Names

### 4.1 Known identifier extraction (`src/node-helpers.ts`)

Replace the inline `isIdentifier(param.name)` check in `buildKnownIdentifiers` with a recursive helper that walks any `BindingName`:

```typescript
function extractBindingNames(name: typescript.BindingName, names: Set<string>): void {
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
```

`buildKnownIdentifiers` calls `extractBindingNames(param.name, names)` for each parameter instead of the current `isIdentifier` guard. Nested destructuring is handled by recursion:

```typescript
function foo({ a: { b } }: Nested): void { … }
// 'b' is added to known identifiers
```

For aliased bindings (`{ original: alias }`), `element.name` is the local alias — the name used in the function body and in contract expressions. The original property name is not added.

### 4.2 Type map for destructured bindings (`src/type-helpers.ts`)

Extend `buildParameterTypes` with a helper that resolves the type of each binding element via the TypeChecker:

```typescript
function extractBindingTypes(
  name: typescript.BindingName,
  checker: typescript.TypeChecker,
  types: Map<string, SimpleType>,
): void {
  if (typescript.isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      if (typescript.isIdentifier(element.name)) {
        const type = checker.getTypeAtLocation(element);
        const simpleType = simpleTypeFromFlags(type.flags);
        if (simpleType !== undefined) types.set(element.name.text, simpleType);
      } else {
        extractBindingTypes(element.name, checker, types);
      }
    }
  } else if (typescript.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (!typescript.isOmittedExpression(element) && typescript.isIdentifier(element.name)) {
        const type = checker.getTypeAtLocation(element);
        const simpleType = simpleTypeFromFlags(type.flags);
        if (simpleType !== undefined) types.set(element.name.text, simpleType);
      }
    }
  }
}
```

Called from `buildParameterTypes` for each parameter where `param.name` is a binding pattern.

---

## 5. Fix #4 — Enum and External Constants

Two components: TypeChecker-based scope resolution (checker mode) and a transformer option fallback.

### 5.1 TypeChecker scope resolution

When a `TypeChecker` is available, collect all value-level symbols accessible at the function declaration site using `checker.getSymbolsInScope`. This returns imported enums, module-level constants, class references, and other accessible identifiers.

**New helper in `src/function-rewriter.ts`:**

```typescript
function buildScopeIdentifiers(
  node: typescript.FunctionLikeDeclaration,
  checker: typescript.TypeChecker,
): Set<string> {
  const scopeNode = node.parent; // class body or module scope
  const symbols = checker.getSymbolsInScope(
    scopeNode,
    typescript.SymbolFlags.Value,
  );
  return new Set(symbols.map((s) => s.name));
}
```

This set is merged into `preKnown` and `postKnown` before `filterValidTags` is called. In transpileModule mode (no checker), `buildScopeIdentifiers` is not called and the set remains empty.

### 5.2 Transformer option: `allowIdentifiers`

Add `allowIdentifiers?: string[]` to the transformer plugin options. The specified names are appended to the known identifiers set for every function in the compilation.

**Configuration:**
```json
{
  "transform": "axiom/dist/src/transformer",
  "allowIdentifiers": ["Status", "Direction", "MAX_SIZE"]
}
```

**Change in `src/transformer.ts`:** Read the option and forward to `buildKnownIdentifiers` (or merge into the set before validation). This is the recommended fallback for projects using ts-jest with `isolatedModules: true`.

---

## 6. Data Flow Summary

```
buildKnownIdentifiers(node, includeResult)
  └── extractBindingNames(param.name, names)      [NEW — #1]
  └── merge scopeIdentifiers(checker)             [NEW — #4, checker mode]
  └── merge allowIdentifiers (option)             [NEW — #4, fallback]

GLOBAL_IDENTIFIERS                                [EXTENDED — #5]

buildParameterTypes(node, checker)
  └── extractBindingTypes(param.name, checker, …) [NEW — #1 type map]
```

---

## 7. Testing Plan

### #5
- `@pre Math.abs(delta) < 1` on `function nudge(delta: number)` → injected, no warning
- `@pre isNaN(x)` on any function → injected, no warning
- `@pre JSON.stringify(obj) !== ""` → injected, no warning

### #1 — known identifiers
- `@pre x > 0` on `function move({ x, y }: Point)` → injected, no warning
- `@pre label.length > 0` on `function tag({ label }: Named)` → injected
- Nested: `@pre b > 0` on `function f({ a: { b } }: Nested)` → injected
- Array: `@pre first > 0` on `function head([first]: number[])` → injected
- Aliased: `@pre alias > 0` on `function f({ original: alias }: T)` → injected; `original` alone is NOT in the known set

### #1 — type map (requires checker)
- `@pre x === "hello"` on `({ x }: { x: number })` → type-mismatch warning (x is number, not string)
- `@pre x > 0` on `({ x }: { x: number })` → injected, no warning

### #4 — TypeChecker mode
- `@pre status === Status.Active` where `Status` is an imported enum → injected, no warning
- `@pre amount <= MAX_SIZE` where `MAX_SIZE` is a module-level const → injected, no warning

### #4 — transformer option
- `allowIdentifiers: ['Status']` in plugin config → `Status` accepted without warning in transpileModule mode

---

## 8. Out of Scope

- Renaming identifiers in contract expressions when a destructuring alias is used — the contract author is expected to use the binding name (alias), not the property name.
- Default values in destructuring (`{ x = 0 }: T`) — `x` is extracted as a known identifier; the default value expression is not validated.
- Rest elements (`{ x, ...rest }`) — `rest` is added to the known set but its element type is not resolved for type mismatch detection.
