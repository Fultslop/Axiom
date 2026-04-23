# FS-Axiom

**Version 0.9 (alpha)**

[![npm](https://img.shields.io/npm/v/@fultslop/axiom)](https://www.npmjs.com/package/@fultslop/axiom)
[![license](https://img.shields.io/npm/l/@fultslop/axiom)](LICENSE)
[![CI](https://github.com/Fultslop/axiom/actions/workflows/ci.yml/badge.svg)](https://github.com/Fultslop/axiom/actions/workflows/ci.yml)

Agents write code faster than humans can read it. Axiom shifts the review surface: instead of auditing implementations line by line, you audit contracts. `@pre`, `@post`, and `@invariant` tags express what a function guarantees, enforced at runtime in dev builds so they can't drift from the code. The discipline runs both ways — an agent that must declare contracts before implementation is an agent that reasons about the spec first.

Axiom provides a TypeScript compiler transformer that reads `@pre`, `@post`, `@invariant` and `@prev` JSDoc tags and injects runtime contract checks in dev builds. Release builds use plain `tsc` — no contract code is emitted.

## Project Background

Axiom is part of an exploration into how far AI-assisted development can go when building non-trivial tools, widgets and apps. This project has been built based on a human-defined architecture, co-authored functional spec and a series of interface contracts, then implemented using Claude, Qwen and to a lesser extent Gemini.

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

Declare your project as ESM in `package.json` (required when `verbatimModuleSyntax` is enabled):

```json
{
  "type": "module",
  ...
}
```

Add a dev build script to `package.json`:

```json
"build:dev": "tspc -p tsconfig.dev.json"
```

Run the compiled output with:

```bash
node dist/index.js
```

### CJS and ESM output

The transformer adjusts guard expressions automatically based on your module output format — no extra configuration required.

| Module setting | Guard style | Example |
|---|---|---|
| `"commonjs"` | `exports.X` | `!(n <= exports.MAX_LIMIT)` |
| `"esnext"`, `"es2022"`, etc. | bare identifier | `!(n <= MAX_LIMIT)` |
| `"node16"` / `"nodenext"` | per-file (see below) | — |

Under `"module": "node16"` or `"nodenext"`, TypeScript determines the output format file-by-file:

- `.ts` files → CJS output → guards use `exports.X`
- `.mts` files → ESM output → guards use bare `X`

The transformer reads TypeScript's `impliedNodeFormat` on each source file, so the correct guard style is applied automatically regardless of the project-level module setting.

> **Important:** You must invoke `tspc` (from `ts-patch`), not plain `tsc`, to run the transformer. Using `tsc` skips all plugins — no guards are emitted.

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

## Async functions

`@pre` and `@post` work on `async` functions and async class methods. Pre-conditions run synchronously before the async body; post-conditions check the **resolved** value, not the `Promise` object. `result` in a `@post` expression refers to the awaited `T`, not `Promise<T>`.

```typescript
/**
 * @pre id > 0
 * @post result !== null
 */
export async function findUser(id: number): Promise<User | null> {
  return db.query(id);
}
```

A `@post` on an `async` function with return type `Promise<void>` behaves like `void` — it is dropped with a warning because there is no meaningful `result` to check.

Generators (`function*`) and async generators (`async function*`) are not yet supported.

## Arrow functions and function expressions

`@pre` and `@post` work on exported `const` arrow functions and function expressions. The JSDoc comment must precede the `const` keyword:

```typescript
/** @pre x > 0 @post result >= 0 */
export const double = (x: number): number => x * 2;

/** @pre input.length > 0 */
export const trim = function(input: string): string {
  return input.trim();
};
```

Expression-body arrows are normalised to block bodies automatically — `result` capture works identically to named function declarations. The location string in error messages uses the variable name (`"double"`, `"trim"`).

Non-exported `const` arrows and class field arrows are not instrumented (no warning is emitted for the non-exported case).

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

## Further reading

- [Feature Reference](docs/reference.md) — interface contracts, `keepContracts` for library authors, full supported-cases list, limitations, and scope boundaries

## Local development

To build and test axiom locally, or to consume it from another local project before it is published, use [Verdaccio](https://verdaccio.org).

Start Verdaccio (if not running):
```bash
npx verdaccio
```

Log in (first time):
```bash
npm adduser --registry http://localhost:4873
```

Publish locally:
```bash
npm publish --registry http://localhost:4873
```

Consume from another local project:
```bash
npm install @fultslop/axiom --registry http://localhost:4873
```

Or add to the consuming project's `.npmrc`:
```
registry=http://localhost:4873
```
