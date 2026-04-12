# FS-Axiom

**Version 0.8**

Agents write code faster than humans can read it. Axiom shifts the review surface: instead of auditing implementations line by line, you audit contracts. `@pre`, `@post`, and `@invariant` tags express what a function guarantees, enforced at runtime in dev builds so they can't drift from the code. The discipline runs both ways — an agent that must declare contracts before implementation is an agent that reasons about the spec first.

Axiom provides a TypeScript compiler transformer that reads `@pre`, `@post`, `@invariant` and `@prev` JSDoc tags and injects runtime contract checks in dev builds. Release builds use plain `tsc` — no contract code is emitted.

## Project Background

Axiom is part of an exploration into how far AI-assisted development can go when building a non-trivial tools, widgets and apps. This project has been built based on a human defined architecture, co-authored functional spec and a series of interface contracts, then implemented using using Claude, Qwen and to a lesser extent Gemini.

## How it works

Write contracts as JSDoc tags on public functions and methods:

```typescript
import { ContractViolationError } from '@fultslop/axiom';

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

When compiled with the transformer active (`npm run build:dev`), the injected guards run before and after the function body. Violations throw a `ContractViolationError`:

```typescript
const acct = new Account();
acct.withdraw(-1);
// throws ContractViolationError: [PRE] Contract violated at Account.withdraw: amount > 0
```

A release build (`npm run build`) strips all contract code — the output contains no references to `ContractViolationError`.

## Installation

Axiom is currently in version 0.8 and not available on npm yet. The recommended installation path for now is to install `Verdaccio` locally, build and publish it there. Then install axiom 

```bash
npm install @fultslop/axiom
```

Install `ts-patch` and patch TypeScript:

```bash
npm install --save-dev ts-patch
npx ts-patch install
```

Add the transformer to your dev tsconfig:

```json
// tsconfig.dev.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "plugins": [{ "transform": "@fultslop/axiom/dist/src/transformer" }]
  }
}
```

Add a dev build script to `package.json`:

```json
"build:dev": "tspc -p tsconfig.dev.json"
```

## Testing with Jest

> **Required for any contract enforcement in Jest — including interface contracts.**
> Without `astTransformers`, the transformer never runs and no contracts are checked.

Configure `ts-jest` to apply the transformer and keep `isolatedModules` at its default (`false`):

```js
// jest.config.js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@src/(.*)$': '<rootDir>/src/$1'
  },
  globals: {
    'ts-jest': {
      // Do NOT set isolatedModules: true — see note below
      astTransformers: {
        before: ['@fultslop/axiom/dist/src/transformer']
      }
    }
  }
};
```

If you use path aliases (e.g. `@src/`), also add them to `tsconfig.json`:

```json
"compilerOptions": {
  "paths": {
    "@src/*": ["src/*"]
  }
}
```

Tests stay as `.ts` files and VSCode debugs them with full source maps — no `build:dev` step needed for testing.

### Why `isolatedModules: false` matters

ts-jest has two compilation modes:

| `isolatedModules` | TypeScript program | Interface contracts (cross-file) |
|---|---|---|
| `false` (default) | Full program, type info available | ✅ enforced |
| `true` | Single-file transpilation, no type info | ❌ skipped with warning |

When `isolatedModules: false`, ts-jest builds a full TypeScript program and passes it to the transformer — the same path that `build:dev` uses. This is the only mode where interface contracts defined in a separate file are resolved and applied to implementing classes.

If you have explicitly set `isolatedModules: true` (often done for speed), you must remove it to get interface contract enforcement in Jest.

## Class invariants

Annotate a class with `@invariant` to declare conditions that must hold after every public method exits and after the constructor exits. Requires `"target": "ES2022"` or later in `tsconfig`.

```typescript
/**
 * @invariant this.balance >= 0
 * @invariant this.owner !== null
 */
export class BankAccount {
  balance: number;
  owner: string;

  constructor(owner: string, initial: number) {
    this.owner = owner;
    this.balance = initial;
    // invariant checked here — throws if initial < 0
  }

  /**
   * @pre amount > 0
   * @pre amount <= this.balance
   */
  withdraw(amount: number): void {
    this.balance -= amount;
    // invariant checked after body — throws if balance went negative
  }

  deposit(amount: number): void {
    this.balance += amount;
    // invariant checked after body
  }
}
```

Invariant violations throw `InvariantViolationError`:

```typescript
import { InvariantViolationError } from '@fultslop/axiom';

const acct = new BankAccount('Alice', 100);
acct.withdraw(200);
// throws InvariantViolationError: [INVARIANT] Invariant violated at BankAccount.withdraw: this.balance >= 0
```

The transformer injects a single private `#checkInvariants(location)` method on the class and calls it at each applicable exit point. Private and static methods are not instrumented.

## Capturing previous state with `@prev`

Use `@prev` to capture state before the function body executes, making it available as `prev` inside `@post` expressions. This enables postconditions that compare before and after state:

```typescript
export class Account {
  public balance: number = 100;

  /** @post this.balance === prev.balance + x */
  public addToBalance(x: number): void {
    this.balance += x;
  }
}
```

### Three-tier syntax

| Tag | Injected code | When to use |
|---|---|---|
| No `@prev` tag (method only) | `const prev = ({ ...this });` | Default — shallow clone of `this` |
| `@prev deep` | `const prev = deepSnapshot(this);` | Full clone via `structuredClone` with JSON fallback |
| `@prev <expression>` | `const prev = (<expression>);` | User-controlled — any valid TS expression |

### Methods vs standalone functions

- **Methods**: If a `@post` expression references `prev` and no `@prev` tag is present, the transformer automatically injects `const prev = ({ ...this })` (shallow clone).
- **Standalone functions**: There is no `this` to clone. If `prev` is used in `@post` without a corresponding `@prev` tag, the `@post` is dropped with a warning. Provide an explicit `@prev` expression referencing parameters:

```typescript
/** @prev { x } @post result === prev.x + 1 */
export function foo(x: number): number { return x + 1; }
```

### Custom capture expressions

Capture exactly what you need for precise comparisons:

```typescript
/** @prev { balance: this.balance } @post this.balance > prev.balance */
public deposit(amount: number): void { this.balance += amount; }

/** @prev this.balance @post this.balance === prev + amount */
public addToBalance(amount: number): void { this.balance += amount; }
```

### Runtime utilities

`snapshot` and `deepSnapshot` are exported from `@fultslop/axiom` and can be used directly in `@prev` expressions:

```typescript
/** @prev snapshot(this.items) */
/** @prev deepSnapshot(this) */
```

- `snapshot(obj)` — shallow clone via spread (`{ ...obj }`)
- `deepSnapshot(obj)` — deep clone via `structuredClone` (with `JSON.parse/stringify` fallback for environments where `structuredClone` is unavailable)

> **Note:** `@prev deep` relies on `structuredClone` being available. In older environments, the fallback uses `JSON.parse(JSON.stringify(obj))`, which does not handle `undefined`, `Symbol`, functions, or circular references.

### Interface inheritance

`@prev` tags on interface method signatures are inherited by implementing classes, with parameter name renaming applied just like `@pre`/`@post` expressions. If both the interface and the class define `@prev`, a warning is emitted and the class-level tag takes precedence.

### Known identifiers

`prev` is automatically available in `@post` expressions (alongside `result`). No additional declaration is needed.

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

## Error hierarchy

All contract errors share a common base so you can catch them with a single `instanceof` check:

```typescript
import { ContractError, ContractViolationError, InvariantViolationError } from '@fultslop/axiom';

try {
  acct.withdraw(-1);
} catch (err) {
  if (err instanceof ContractError) {
    // catches both ContractViolationError and InvariantViolationError
    err.expression; // the violated expression
    err.location;   // 'BankAccount.withdraw'
  }
}
```

## ContractViolationError

```typescript
import { ContractViolationError } from '@fultslop/axiom';

try {
  acct.withdraw(999);
} catch (err) {
  if (err instanceof ContractViolationError) {
    err.type;       // 'PRE' | 'POST'
    err.expression; // 'amount <= this.balance'
    err.location;   // 'Account.withdraw'
    err.message;    // '[PRE] Contract violated at Account.withdraw: amount <= this.balance'
  }
}
```

## Manual assertions

For cases the transformer cannot reach (enum references, complex expressions), `pre` and `post` are plain assertion functions you can call directly inside a function body:

```typescript
import { pre, post } from '@fultslop/axiom';

export function move({ x, y }: Point, speed: number): Point {
  pre(x >= 0 && y >= 0, 'coordinates must be non-negative');
  pre(speed > 0, 'speed must be positive');

  const result = { x: x + speed, y: y + speed };

  post(result.x >= x, 'x must not decrease');
  return result;
}
```

Both functions throw a `ContractViolationError` (with `type: 'PRE'` or `'POST'`) when the condition is `false`.

> **Note:** Unlike the transformer-injected checks, these functions are always present in the compiled output. They are not stripped in release builds. If you need zero overhead in production, guard the calls with a dev-only flag or remove them before releasing.

## Supported cases

- `@pre` tags on exported functions and public class methods
- `@post` tags — the special identifier `result` refers to the return value; requires an explicit non-void return type annotation, otherwise the `@post` is dropped with a warning
- `@prev` tags — capture state before function execution for use in `@post` expressions via the `prev` identifier; three-tier syntax (auto shallow clone for methods, `@prev deep`, or custom expression)
- `@invariant` tags on classes — checked after constructor and after every public method exit
- `@pre`, `@post`, and `@invariant` tags on interfaces — propagated to all implementing classes
- Multiple `@pre`, `@post`, `@prev`, and `@invariant` tags on the same target (evaluated in order)
- Cross-file interface resolution via the TypeScript type checker (requires full program — see [Testing with Jest](#testing-with-jest))
- Parameter name mismatch handling between interface and class signatures (rename or ignore mode)
- Additive merge when both interface and class define contracts for the same method
- `this` and `prev` references inside contract expressions (e.g. `this.balance === prev.balance + amount`)
- Destructured parameters — binding names from object and array destructuring are recognised as known identifiers (e.g. `{ x, y }`, `[first]`, `{ a: { b } }`, `{ original: alias }`)
- Standard global objects — `Math`, `JSON`, `Object`, `Array`, `String`, `Number`, `Boolean`, `Symbol`, `BigInt`, `Date`, `RegExp`, `Error`, `Promise`, `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `encodeURIComponent`, `decodeURIComponent`, and `console` are whitelisted
- No-substitution template literals — backtick strings without interpolation are fully supported (e.g. `` `hello` ``)
- Enum and module-level constants — automatically resolved via TypeChecker scope analysis in full program mode; use `allowIdentifiers` option in transpileModule mode
- `allowIdentifiers` transformer option — explicitly whitelist identifiers for environments without TypeChecker (e.g. enums, module constants)
- Zero contract overhead in release builds — plain `tsc` ignores JSDoc entirely

## Not yet in scope

- Arrow functions and function expressions
- `async` functions and generators
- Constructor contracts
- Inherited contracts from base classes (interface contracts are supported; class-to-class inheritance is not)
- Integration with `ts-patch` via the `type: raw` loader under TypeScript 6 + `moduleResolution: node16` (a known ts-node 10.x incompatibility; tests use `ts.transpileModule` directly as the canonical verification path)

## Outside scope

- Runtime contract checking in release builds — the zero-overhead guarantee is a hard design constraint
- Contracts on non-function nodes (class fields, variables, type aliases)
- Arbitrary JavaScript in contract expressions that has side effects — expressions are expected to be pure predicates
- Source map rewriting or debugger integration for contract failures
- private / protected methods

## Limitations

Apart from the features not yet in scope, some of the existing features are limited. For instance axiom offers partial syntax, type and definition checking of the pre and post conditions. It does not however offer a full set of checks yet. The following is a non-exhaustive list of constructs which are currently not covered:

**1. Non-primitive parameter types** — type mismatch detection only applies to `number`, `string`, and `boolean`. Array, object, and interface types are not type-checked in contract expressions.
```typescript
/** @pre items === 42 */                   // no type-mismatch warning emitted
export function first(items: string[]): string { … }
```

**2. Union-typed parameters** — parameters with union types (including common patterns like `T | undefined`) are excluded from type mismatch detection because the TypeScript `TypeFlags` check does not match union types.
```typescript
/** @pre amount === "zero" */             // no type-mismatch warning emitted
export function pay(amount: number | undefined): void { … }
```

**3. Enum and external constant references in transpileModule mode** — when compiled with a full TypeScript program (TypeChecker available), enum members and module-level constants are automatically resolved via scope analysis. In `transpileModule` mode, they must be listed in the `allowIdentifiers` transformer option.
```typescript
// transpileModule mode — requires allowIdentifiers option
/** @pre status === Status.Active */      // without allowIdentifiers: ['Status'], warns and skips
export function activate(status: Status): void { … }
```

**4. Interpolated template literals** — template expressions with interpolation (`` `item_${id}` ``) are not yet supported in contract expressions. No-substitution template literals (`` `hello` ``) work correctly.
```typescript
/** @pre label === `item_${id}` */        // not yet supported — contract dropped
export function tag(label: string, id: string): void { … }
```

**5. Non-primitive return types** — `result` is added to the type map only when the return type is `number`, `string`, or `boolean`. For object, array, or union return types, `result` is available in the expression but type mismatch against it is not detected.
```typescript
/** @post result === "ok" */              // injected, but no type-mismatch warning emitted
export function load(id: number): Record<string, unknown> { … }
```

**6. `result` used without a return type annotation** — if a `@post` expression references `result` but the function has no declared return type (or is declared `void`/`never`), the `@post` is dropped with a warning. This applies in all compilation modes — no TypeChecker is required.
```typescript
/** @post result === "foo" */
// warns: 'result' used but no return type is declared; @post dropped
export function noAnnotation(x: number) { return x; }

/** @post result === "foo" */
// warns: 'result' used but return type is 'void'; @post dropped
export function voidFn(x: number): void { }
```

**7. Multi-level property chains** — only the root object of a property access chain is scope-checked. Intermediate and leaf members are not validated.
```typescript
/** @pre this.config.limit > 0 */         // 'this' is scope-checked; 'config' and 'limit' are not
public run(input: number): void { … }
```

**8. Unary operands** — identifiers inside unary expressions are scope-checked, but type mismatch detection does not extend to the unary result.
```typescript
/** @pre -amount > 0 */                   // 'amount' is scope-checked; the negated result is not type-checked
export function negate(amount: string): number { … }
```

**9. Compound conditions and type narrowing** — type mismatch detection examines each binary sub-expression in isolation. Type narrowing established by a sibling clause is not taken into account.
```typescript
/** @pre amount !== null && amount === "zero" */  // no type-mismatch warning on the second clause
export function pay(amount: number | null): void { … }
```

## Agent Directives

Axiom is designed to work with AI coding agents. The premise is simple: require the agent to declare contracts *before* writing any implementation. This shifts your review surface from implementation lines to contract expressions — a much smaller, more auditable surface.

### The core directive

Add the following to your project instructions (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, Copilot workspace instructions, or however your agent reads project context):

```
Contract-driven development with Axiom:
- Before writing any function or method body, declare @pre, @post, and
  @invariant JSDoc contracts that express the complete behavioural specification.
- @pre  — conditions that must hold when the function is called
- @post — conditions that must hold when the function returns;
           use `result` for the return value, `prev` for pre-call state
- @invariant — conditions that must hold after every public method on a class
- Contracts must be valid TypeScript expressions (they are injected verbatim).
- Do not write implementation code until contracts are written and reviewed.
```

### Why contracts first

When an agent writes implementation first, you are reviewing code. When it writes contracts first, you are reviewing a spec. Contracts are:

- **Short** — a handful of expressions per function, not dozens of lines
- **Falsifiable** — the transformer enforces them at runtime in dev builds; a wrong contract breaks tests
- **Stable** — business logic changes, implementations change, but the contract on `withdraw` (`amount > 0`, `amount <= this.balance`) rarely does

Reviewing three contract expressions takes seconds. Reviewing the implementation they describe can take minutes.

### Workflow

Instruct the agent to follow this order for every non-trivial function or class:

1. **Declare the interface** — types, method signatures, return types
2. **Write contracts** — `@pre`, `@post`, `@invariant`, `@prev` on each method
3. **Pause for review** — contracts are the checkpoint; get human sign-off here
4. **Write implementation** — the agent fills in the body; contracts enforce correctness at runtime

A prompt like the following works well as a per-task instruction:

```
Implement `UserRepository.save`. Before writing any body:
1. Write the method signature with a full return type annotation.
2. Add @pre and @post JSDoc tags that fully specify the contract.
3. Stop and wait for my review before writing the implementation.
```

### What good contracts look like

```typescript
export interface PaymentService {
  /**
   * @pre amount > 0
   * @pre this.isConnected === true
   * @post result.status === 'ok' || result.status === 'declined'
   * @post result.transactionId.length > 0
   */
  charge(amount: number, token: string): PaymentResult;
}
```

The agent has committed to a spec. You review three expressions. Then it implements. If the implementation violates any expression, `ContractViolationError` is thrown during dev-build tests — the divergence surfaces immediately rather than in production.

### Auditing agent output

After implementation, your review checklist is:

1. Do the `@pre` conditions match the requirements?
2. Do the `@post` conditions fully describe the expected output?
3. For stateful classes, do `@invariant` conditions capture the class's core integrity rules?
4. Does the implementation pass all tests with the transformer active (`build:dev` / Jest with `astTransformers`)?

If all four hold, the implementation is correct by construction for the cases the contracts cover. Implementation details are the agent's concern; correctness of the spec is yours.
