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

## Supported cases

- `@pre` tags on exported functions and public class methods
- `@post` tags — the special identifier `result` refers to the return value
- Multiple `@pre` and `@post` tags on the same function (evaluated in order)
- `this` references inside contract expressions (e.g. `amount <= this.balance`)
- Zero contract overhead in release builds — plain `tsc` ignores JSDoc entirely

## Not yet in scope

- `@invariant`
- Arrow functions and function expressions
- Private and protected methods
- `async` functions and generators
- Constructor contracts
- Inherited contracts (contracts defined on base class methods)
- Integration with `ts-patch` via the `type: raw` loader under TypeScript 6 + `moduleResolution: node16` (a known ts-node 10.x incompatibility; tests use `ts.transpileModule` directly as the canonical verification path)

## Outside scope

- Runtime contract checking in release builds — the zero-overhead guarantee is a hard design constraint
- Contracts on non-function nodes (class fields, variables, type aliases)
- Arbitrary JavaScript in contract expressions that has side effects — expressions are expected to be pure predicates
- Source map rewriting or debugger integration for contract failures
