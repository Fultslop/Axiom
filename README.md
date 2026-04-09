# fsprepost

A TypeScript compiler transformer that reads `@pre` and `@post` JSDoc tags and injects runtime contract checks in dev builds. Release builds use plain `tsc` — no contract code is emitted.

## How it works

Write contracts as JSDoc tags on public functions and methods:

```typescript
import { ContractViolationError } from 'fsprepost';

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
npm install fsprepost --registry http://localhost:4873
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
    "plugins": [{ "transform": "fsprepost/dist/src/transformer" }]
  }
}
```

Add a dev build script to `package.json`:

```json
"build:dev": "tspc -p tsconfig.dev.json"
```

## Testing with Jest

To run contracts inside Jest tests without a separate build step, configure `ts-jest` to apply the transformer via `astTransformers`:

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
      astTransformers: {
        before: ['fsprepost/dist/src/transformer']
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
import { InvariantViolationError } from 'fsprepost';

const acct = new BankAccount('Alice', 100);
acct.withdraw(200);
// throws InvariantViolationError: [INVARIANT] Invariant violated at BankAccount.withdraw: this.balance >= 0
```

The transformer injects a single private `#checkInvariants(location)` method on the class and calls it at each applicable exit point. Private and static methods are not instrumented.

## Error hierarchy

All contract errors share a common base so you can catch them with a single `instanceof` check:

```typescript
import { ContractError, ContractViolationError, InvariantViolationError } from 'fsprepost';

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
import { ContractViolationError } from 'fsprepost';

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

For cases the transformer cannot reach (destructured parameters, enum references, complex expressions), `pre` and `post` are plain assertion functions you can call directly inside a function body:

```typescript
import { pre, post } from 'fsprepost';

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
- `@post` tags — the special identifier `result` refers to the return value
- `@invariant` tags on classes — checked after constructor and after every public method exit
- Multiple `@pre`, `@post`, and `@invariant` tags on the same target (evaluated in order)
- `this` references inside contract expressions (e.g. `amount <= this.balance`)
- Zero contract overhead in release builds — plain `tsc` ignores JSDoc entirely

## Not yet in scope

- previous capture (`@post this.balance === prev - amount`)
- Arrow functions and function expressions
- `async` functions and generators
- Constructor contracts
- Inherited contracts (contracts defined on base class methods)
- Integration with `ts-patch` via the `type: raw` loader under TypeScript 6 + `moduleResolution: node16` (a known ts-node 10.x incompatibility; tests use `ts.transpileModule` directly as the canonical verification path)

## Outside scope

- Runtime contract checking in release builds — the zero-overhead guarantee is a hard design constraint
- Contracts on non-function nodes (class fields, variables, type aliases)
- Arbitrary JavaScript in contract expressions that has side effects — expressions are expected to be pure predicates
- Source map rewriting or debugger integration for contract failures
- private / protected methods

## Limitations

Apart from the features not yet in scope, some of the existing features are limited. For instance fsprepost offers partial syntax, type and definition checking of the pre and post conditions. It does not however offer a full set of checks yet. The following is a non-exhaustive list of constructs which are currently not covered:

**1. Destructured parameters** — binding names inside destructured parameters are not recognised as known identifiers. The contract is skipped with an unknown-identifier warning.
```typescript
/** @pre x > 0 */                          // warns: 'x' is not a known parameter
public move({ x, y }: Point): void { … }
```

**2. Non-primitive parameter types** — type mismatch detection only applies to `number`, `string`, and `boolean`. Array, object, and interface types are not type-checked in contract expressions.
```typescript
/** @pre items === 42 */                   // no type-mismatch warning emitted
export function first(items: string[]): string { … }
```

**3. Union-typed parameters** — parameters with union types (including common patterns like `T | undefined`) are excluded from type mismatch detection because the TypeScript `TypeFlags` check does not match union types.
```typescript
/** @pre amount === "zero" */             // no type-mismatch warning emitted
export function pay(amount: number | undefined): void { … }
```

**4. Enum and external constant references** — identifiers that are not function parameters (enum members, module-level constants) are flagged as unknown and the contract is skipped.
```typescript
/** @pre status === Status.Active */      // warns: 'Status' is not a known parameter
export function activate(status: Status): void { … }
```

**5. Global objects not in the whitelist** — only `undefined`, `NaN`, `Infinity`, `globalThis`, and `arguments` are whitelisted. Other global objects trigger an unknown-identifier warning.
```typescript
/** @pre Math.abs(delta) < 1 */           // warns: 'Math' is not a known parameter
export function nudge(delta: number): void { … }
```

**6. Template literals** — template literals are not recognised as typed string literals, so type mismatch between a typed parameter and a template literal is not detected.
```typescript
/** @pre label === `item_${id}` */        // no type-mismatch warning emitted
export function tag(label: number, id: string): void { … }
```

**7. Non-primitive return types** — `result` is added to the type map only when the return type is `number`, `string`, or `boolean`. For object, array, or union return types, `result` is omitted and type mismatch on it is not detected.
```typescript
/** @post result === "ok" */              // no type-mismatch warning emitted
export function load(id: number): Record<string, unknown> { … }
```

**8. Multi-level property chains** — only the root object of a property access chain is scope-checked. Intermediate and leaf members are not validated.
```typescript
/** @pre this.config.limit > 0 */         // 'this' is scope-checked; 'config' and 'limit' are not
public run(input: number): void { … }
```

**9. Unary operands** — identifiers inside unary expressions are scope-checked, but type mismatch detection does not extend to the unary result.
```typescript
/** @pre -amount > 0 */                   // 'amount' is scope-checked; the negated result is not type-checked
export function negate(amount: string): number { … }
```

**10. Compound conditions and type narrowing** — type mismatch detection examines each binary sub-expression in isolation. Type narrowing established by a sibling clause is not taken into account.
```typescript
/** @pre amount !== null && amount === "zero" */  // no type-mismatch warning on the second clause
export function pay(amount: number | null): void { … }
```
