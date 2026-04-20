# Axiom — Feature Reference

This document covers advanced features, the full supported-cases list, limitations, and scope boundaries. For installation, core usage, and agent directives, see the [README](../README.md).

---

## Interface contracts

`@pre`, `@post`, and `@invariant` tags on interface methods and interfaces are inherited by every class that implements the interface. You do not need to repeat the contracts on each implementing class — the transformer injects them automatically.

```typescript
// model/repository.ts

/**
 * @invariant this.isConnected === true
 */
export interface Repository<T> {}

export interface UserRepository extends Repository<User> {
  /**
   * @pre id > 0
   * @post result !== null
   */
  findById(id: number): User | null;

  /**
   * @pre user.name.length > 0
   */
  save(user: User): void;
}
```

```typescript
// framework/sqlUserRepository.ts
import { UserRepository } from '../model/repository';

// Contracts from UserRepository are injected here automatically.
// No need to repeat @pre/@post on these methods.
export class SqlUserRepository implements UserRepository {
  isConnected = true;

  findById(id: number): User | null {
    // [PRE] id > 0  is checked on entry
    return this.db.query(id);
    // [POST] result !== null  is checked on exit
    // [INVARIANT] this.isConnected === true  is checked on exit
  }

  save(user: User): void {
    // [PRE] user.name.length > 0  is checked on entry
    this.db.insert(user);
    // [INVARIANT] this.isConnected === true  is checked on exit
  }
}
```

### Parameter name mismatches

When the implementing class uses different parameter names than the interface signature, the transformer renames identifiers in the interface's contract expressions to match the class. A warning is emitted:

```
[axiom] Parameter name mismatch in SqlUserRepository.findById:
  interface UserRepository: 'id' → 'userId' — expression renamed
```

To skip the contract instead of renaming, pass `interfaceParamMismatch: 'ignore'` in the transformer options:

```json
{ "transform": "@fultslop/axiom/dist/src/transformer", "interfaceParamMismatch": "ignore" }
```

### What is required from you

The table below shows what works under each build/test path. The requirements differ and it is important to get them right.

| Scenario | Interface contracts enforced? | What you must do |
|---|---|---|
| `build:dev` (tspc) | ✅ always | Nothing extra — tspc provides a full TypeScript program |
| Jest with `astTransformers`, `isolatedModules: false` | ✅ cross-file and same-file | Add `astTransformers` to jest.config; do **not** set `isolatedModules: true` |
| Jest with `astTransformers`, `isolatedModules: true` | ❌ cross-file skipped | Remove `isolatedModules: true` to fix |
| Jest without `astTransformers` | ❌ transformer not running | Add `astTransformers` to jest.config |
| `build` (plain tsc) | ❌ by design | This is the release build — no contracts emitted |

**The single most common mistake:** configuring `astTransformers` but also setting `isolatedModules: true`. The transformer runs but cannot see the interface file, so it silently skips interface contracts while still applying class-level contracts. The warning emitted to stderr is:

```
[axiom] Interface contract resolution skipped in framework/sqlUserRepository.ts:
  no TypeChecker available (transpileModule mode) — class-level contracts unaffected
```

If you see this warning during Jest, check your ts-jest configuration for `isolatedModules: true`.

### Additive merge

If both the interface and the implementing class define contracts for the same method or invariant, both sets are applied — interface contracts first, then class contracts. A merge warning is emitted so you are aware of the overlap:

```
[axiom] Contract merge warning in SqlUserRepository.findById:
  both UserRepository and SqlUserRepository define @pre tags — additive merge applied
```

---

## `keepContracts` — contracts in release builds

By default, Axiom's zero-overhead guarantee means contract code only exists when `tspc` is active in the build pipeline. A plain `tsc` release build produces no contract code at all.

This is the right default for application authors. Library authors face a different situation: a library cannot control the build pipeline of its callers. If a consuming application compiles without the transformer, all contracts on the library's public API are silently absent in production — misuse by callers goes undetected at runtime.

`keepContracts` is an opt-in that bakes contracts into the compiled `.js` output at library-build time, so callers run the checks unconditionally regardless of whether they use the transformer.

### Option values

Pass `keepContracts` in the transformer plugin options:

| Value | Behaviour |
|---|---|
| `false` (default, including omitted) | Standard behaviour — contracts are injected only while the transformer is active. |
| `true` or `'all'` | All contract kinds (`@pre`, `@post`, `@invariant`) are emitted as unconditional checks. |
| `'pre'` | Only `@pre` checks are kept; `@post` and `@invariant` behave as today. |
| `'post'` | Only `@post` checks (and the `prev`/`result` scaffolding they require) are kept. |
| `'invariant'` | Only `@invariant` checks are kept. |

`true` is normalised to `'all'` internally.

### Recommended pattern for library authors

Create a dedicated tsconfig for the release build you publish:

```json
// tsconfig.release-with-contracts.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "plugins": [
      {
        "transform": "@fultslop/axiom/dist/src/transformer",
        "keepContracts": "all"
      }
    ]
  }
}
```

Invoke it from your build script:

```json
{
  "scripts": {
    "build": "tspc --project tsconfig.release-with-contracts.json"
  }
}
```

The compiled `dist/` then includes all contract checks as plain unconditional runtime code. Publish normally — consumers run the checks whether or not they use the transformer themselves.

**Important:** When `keepContracts` is active, the emitted JS files contain a `require('@fultslop/axiom/contracts')` import. If your library currently lists `@fultslop/axiom` as a `devDependency`, move it to `dependencies` before publishing.

### File-level directive

A `// @axiom keepContracts` comment on the first line of a source file enables `keepContracts: 'all'` for that file, overriding the global option. An optional kind qualifier is accepted:

```typescript
// @axiom keepContracts
// @axiom keepContracts pre
// @axiom keepContracts post
// @axiom keepContracts invariant
// @axiom keepContracts all
```

This lets a monorepo or multi-module library opt individual files in without changing the transformer configuration. The directive must appear on the first line; a directive on a subsequent line is ignored. The comment is not stripped from the output.

### Considerations

- Contract failures throw at runtime in production. Decide whether throwing is the right error-handling strategy for your library, or whether a custom `warn` callback that logs rather than throws is preferable.
- There is no runtime opt-out or environment-variable gate on the emitted checks. When `keepContracts` is active the checks are unconditional; any `process.env.NODE_ENV` guard is the author's responsibility at the call site.
- Per-function or per-class granularity (e.g. a `@keepContracts` JSDoc tag on individual methods) is not yet supported.

---

## Constructor contracts

`@pre` and `@post` tags on a constructor are supported. Pre-conditions are checked at the entry of the constructor body. Post-conditions are checked after user code completes, before invariant checks run.

```typescript
class Account {
  balance: number;

  /**
   * @pre initialBalance >= 0
   * @post this.balance === initialBalance
   */
  constructor(initialBalance: number) {
    this.balance = initialBalance;
  }
}
```

### Restrictions

`result` and `prev` cannot be used in constructor `@post` expressions — a constructor has no return value and no meaningful pre-construction snapshot. Both are dropped with a warning:

```
[axiom] Warning: @post on constructor of Account references 'result' — constructors have no return value; tag dropped
[axiom] Warning: @post on constructor of Account references 'prev' — @prev is not supported on constructors; tag dropped
```

`@prev` tags on constructors are similarly not supported.

**`@pre` expressions referencing `this` in derived classes** — when a subclass constructor calls `super()`, `this` is not accessible until after the `super()` call. A `@pre` expression that reads `this` in a derived class constructor will throw a `ReferenceError` at runtime. Axiom does not currently detect or warn about this pattern; it is the author's responsibility to avoid `this` references in derived class constructor pre-conditions.

The location string in error messages uses the class name only (`Account`), not `Account.constructor`.

---

## Class inheritance contracts

When a class extends a base class, contracts defined on the base class methods and invariants are automatically inherited by the subclass. You do not need to repeat the contracts on the overriding method.

```typescript
class Animal {
  /**
   * @pre name.length > 0
   * @post result.length > 0
   */
  describe(name: string): string {
    return `Animal: ${name}`;
  }
}

class Dog extends Animal {
  // @pre and @post from Animal.describe are injected here automatically.
  describe(name: string): string {
    return `Dog: ${name}`;
  }
}
```

### Merge order

When a class both inherits from a base class and implements an interface, contracts are merged additively in this order: interface contracts → base class contracts → subclass contracts. All sets are applied; a merge warning is emitted when multiple sources define contracts for the same method.

### Parameter name mismatches

The same rename/ignore mechanism used for interface parameter mismatches applies here. If the overriding method uses different parameter names, identifiers in the inherited expression are renamed to match, and a warning is emitted. Pass `interfaceParamMismatch: 'ignore'` to skip the contract instead.

### Requires full program mode

Class inheritance resolution requires the TypeScript type checker (full program mode). In `transpileModule` mode the inherited contracts are silently skipped and a warning is emitted to stderr:

```
[axiom] Base class contract resolution skipped in Dog:
  no TypeChecker available (transpileModule mode) — class-level contracts unaffected
```

### What is not inherited

- Constructor contracts from a base class are **not** inherited by subclasses.
- Only the **direct** parent class is resolved. Grandparent and more distant ancestor contracts are not inherited.

---

## Nested function contracts

`@pre` and `@post` tags on a named inner function or a `const`-assigned arrow inside an exported function or public class method are injected automatically — no extra configuration required.

### Supported forms

**Named inner `FunctionDeclaration`** — place the JSDoc tag immediately before the inner function:

```typescript
export function processItems(items: string[]): string[] {
  /** @pre item.length > 0 */
  function sanitise(item: string): string { return item.trim(); }
  return items.map(sanitise);
}
```

**`const`-assigned arrow or function expression** — same placement rule:

```typescript
export function outer(values: number[]): number[] {
  /** @pre x > 0 */
  const double = (x: number): number => x * 2;
  return values.map(double);
}
```

Multiple tagged nested functions at the same depth are all rewritten:

```typescript
export function outer(): void {
  /** @pre x > 0 */
  function named(x: number): number { return x * 2; }
  /** @pre y > 0 */
  const arrow = (y: number): number => y * 3;
  named(2);
  arrow(3);
}
```

### Location strings

Injected contract errors use a `>` separator to show nesting depth. For nested functions inside a top-level exported function, the format is `outerName > innerName`. For nested functions inside a class method, it is `ClassName.methodName > innerName`:

```
[axiom] ContractViolationError: PRE — outer > sanitise: item.length > 0
[axiom] ContractViolationError: PRE — Processor.process > sanitise: item.length > 0
```

### Depth limit — one level only

Only functions nested **one level deep** inside a public target are rewritten. A grandchild function (a function nested inside an already-nested function) and any IIFE still emit the `#13` misuse warning and are not injected:

```typescript
export function outer(): void {
  function middle(): void {
    /** @pre x > 0 */
    function inner(x: number): void { /* NOT injected — grandchild */ }
    inner(1);
  }
  middle();
}
```

```typescript
export function outer(): void {
  /** @pre x > 0 */
  ((x: number) => { /* NOT injected — IIFE */ })(-1);
}
```

---

## Supported cases

- `@pre` tags on exported functions and public class methods
- `@post` tags — the special identifier `result` refers to the return value; requires an explicit non-void return type annotation, otherwise the `@post` is dropped with a warning
- `@prev` tags — capture state before function execution for use in `@post` expressions via the `prev` identifier; three-tier syntax (auto shallow clone for methods, `@prev deep`, or custom expression)
- `@invariant` tags on classes — checked after constructor and after every public method exit
- `@pre`, `@post`, and `@invariant` tags on interfaces — propagated to all implementing classes
- Multiple `@pre`, `@post`, `@prev`, and `@invariant` tags on the same target (evaluated in order)
- Cross-file interface resolution via the TypeScript type checker (requires full program — see [Testing with Jest](../README.md#testing-with-jest))
- Parameter name mismatch handling between interface and class signatures (rename or ignore mode)
- Additive merge when both interface and class define contracts for the same method
- `this` and `prev` references inside contract expressions (e.g. `this.balance === prev.balance + amount`)
- Destructured parameters — binding names from object and array destructuring are recognised as known identifiers (e.g. `{ x, y }`, `[first]`, `{ a: { b } }`, `{ original: alias }`)
- Standard global objects — `Math`, `JSON`, `Object`, `Array`, `String`, `Number`, `Boolean`, `Symbol`, `BigInt`, `Date`, `RegExp`, `Error`, `Promise`, `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `encodeURIComponent`, `decodeURIComponent`, and `console` are whitelisted
- Template literals — both no-substitution (`` `hello` ``) and interpolated (`` `item_${id}` ``) are fully supported in contract expressions
- Enum and module-level constants — automatically resolved via TypeChecker scope analysis in full program mode; use `allowIdentifiers` option in transpileModule mode
- `allowIdentifiers` transformer option — explicitly whitelist identifiers for environments without TypeChecker (e.g. enums, module constants)
- Non-primitive parameter types — array, object, and interface parameters compared to a primitive literal emit a type-mismatch warning (e.g. `items === 42` where `items: string[]`)
- Union-typed parameters — `T | null` and `T | undefined` patterns are resolved to their non-nullable constituent and type-checked; ambiguous unions such as `number | string` are skipped
- Non-primitive return types — `result` type-checking now covers object and array return types; comparing `result` to a primitive literal emits a warning when the declared return type is non-primitive
- Unary operand type mismatch — identifiers inside unary prefix expressions (`-x`, `+x`, `!x`) are type-checked against the literal operand of the comparison (e.g. `-amount > 0` warns when `amount` is `string`)
- Zero contract overhead in release builds — plain `tsc` ignores JSDoc entirely
- `keepContracts` option — opt-in baking of contracts into release builds for library authors; supports granular selection by kind (`'pre'`, `'post'`, `'invariant'`, `'all'`) and a file-level `// @axiom keepContracts` directive
- `@pre` and `@post` on `async` functions and async class methods — post-conditions check the **resolved** value (`T`), not the `Promise<T>` object; `result` refers to the awaited value; `@post` on `async` functions returning `Promise<void>` is dropped with a warning (no meaningful `result`)
- `@pre` and `@post` on exported `const` arrow functions and function expressions, including `async` arrows — expression-body arrows are normalised to block bodies automatically; `async` arrows await the IIFE result identically to `async function` declarations; the location string uses the variable name; JSDoc must precede the `const` keyword
- `@pre` and `@post` on named inner `FunctionDeclaration` and `const`-assigned arrow/function expressions nested one level deep inside an exported function or public class method — location string uses `outerName > innerName` or `ClassName.methodName > innerName` format; multiple tagged nested functions at the same depth are all rewritten
- `@pre` and `@post` on constructors — pre-conditions checked at constructor entry; post-conditions checked after user code and before invariant checks; `result` and `prev` are not valid in constructor `@post` and are dropped with a warning; `@prev` is not supported on constructors
- `@pre` and `@post` on functions whose body contains `try/catch` — the body is wrapped in an IIFE that captures the return value from any branch; `@pre` guards run before the try block; `@post` checks the resolved value; `finally` blocks are preserved and execute normally
- Method and `@invariant` contracts inherited from base classes via `extends` — base class contracts are merged additively with subclass and interface contracts (interface → base → subclass order); parameter name mismatches are handled via rename (default) or ignore mode; requires full TypeScript program (TypeChecker); only the direct parent class is resolved
- Misuse detection — `@pre`/`@post` on non-exported initialisers, grandchild functions (nested more than one level deep), IIFEs, and class declarations all emit targeted `[axiom] Warning:` diagnostics; `@invariant` on non-class nodes is similarly reported

---

## Not yet in scope

- Generators (`function*`) and async generators (`async function*`) — `yield` semantics make a single `result` post-condition ambiguous; deferred to a future spec
- Multi-level (transitive) class inheritance — only the direct parent class is resolved; grandparent and more distant ancestor contracts are not inherited
- Constructor contracts inherited from base classes — `@pre`/`@post` on a base class constructor are not propagated to subclass constructors
- Liskov-aware contract merging — precondition weakening and postcondition strengthening are not enforced; only additive merge is performed; heuristic LSP violation detection is deferred to v2.0
- `@pre` expressions referencing `this` in derived class constructors — Axiom does not detect or warn when a pre-condition in a subclass constructor reads `this` before `super()` is called
- Integration with `ts-patch` via the `type: raw` loader under TypeScript 6 + `moduleResolution: node16` (a known ts-node 10.x incompatibility; tests use `ts.transpileModule` directly as the canonical verification path)

## Outside scope

- Runtime contract checking in release builds without `keepContracts` — the zero-overhead guarantee is a hard design constraint for application builds
- Contracts on non-function nodes (class fields, variables, type aliases)
- Arbitrary JavaScript in contract expressions that has side effects — expressions are expected to be pure predicates
- Source map rewriting or debugger integration for contract failures
- private / protected methods

## Limitations

Apart from the features not yet in scope, some of the existing features are limited. For instance, axiom offers partial syntax, type and definition checking of the pre and post conditions. It does not, however, offer a full set of checks yet. The following is a non-exhaustive list of constructs which are currently not covered:

**1. Union-typed parameters with ambiguous types** — parameters with union types containing multiple distinct primitives (e.g. `number | string`) are excluded from type mismatch detection because the constituent types are contradictory. Nullable unions such as `T | null` and `T | undefined` are fully supported and resolve to `T`.
```typescript
/** @pre val === 1 */                     // no type-mismatch warning emitted for ambiguous union
export function foo(val: number | string): void { … }
```

**2. Enum and external constant references in transpileModule mode** — when compiled with a full TypeScript program (TypeChecker available), enum members and module-level constants are automatically resolved via scope analysis. In `transpileModule` mode, they must be listed in the `allowIdentifiers` transformer option.
```typescript
// transpileModule mode — requires allowIdentifiers option
/** @pre status === Status.Active */      // without allowIdentifiers: ['Status'], warns and skips
export function activate(status: Status): void { … }
```

**3. Narrowing in `&&` chains is limited to `typeof` guards** — `typeof x === 'string'` guards in `&&` chains are recognised and applied to subsequent clauses, enabling type-mismatch detection for ambiguous union parameters. Other narrowing patterns — null checks, truthiness, `instanceof`, `||` chains — are not recognised.
```typescript
// Works — typeof guard applied:
/** @pre typeof x === "string" && x === 42 */  // warns: x narrowed to string, 42 is number literal
export function foo(x: string | number): void { … }

// Not recognised — || chains never apply narrowing:
/** @pre typeof x === "string" || x === 42 */  // no warning (x is ambiguous union; guard ignored)
export function foo(x: string | number): void { … }
```

**4. `@pre` expressions on derived class constructors that reference `this`** — `this` is not accessible in a subclass constructor before `super()` completes. A `@pre` condition that reads `this` will throw a `ReferenceError` at runtime. Axiom does not detect this pattern; avoid `this` references in derived class constructor pre-conditions.

**5. Unsupported expression constructs drop only the affected tag** — the contract reifier handles a defined set of expression node kinds. When a contract expression contains an unsupported construct — an array literal, an arrow function, or a `void` expression — that specific tag is dropped with a targeted warning. Other contracts on the same function are unaffected. The warning format is:
```
[axiom] Warning: @post result === [1, 2, 3] — array literal — use a property check such as result.length === N instead (in getItems); tag dropped
```
```typescript
// @post tag dropped — array literal in contract expression
/** @post result === [1, 2, 3] */
// warns: array literal — use a property check such as result.length === N instead
export function getItems(): number[] { … }

// @post tag dropped — arrow function in contract expression
/** @post result === items.map(x => x * 2) */
// warns: function expression — contract expressions must be pure predicates, not callbacks
export function doubled(items: number[]): number[] { … }
```
