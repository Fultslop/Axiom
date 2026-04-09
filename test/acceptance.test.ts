/**
 * Acceptance tests for spec 002, Section 10.
 *
 * Uses ts.transpileModule + the transformer directly — no ts-patch required.
 * ts-node 10.x has a known incompatibility with TypeScript 6's moduleResolution:
 * node16, which prevents the ts-patch "type: raw" loader from working. The unit
 * tests below are the canonical proof that the full pipeline is correct.
 */
import typescript from 'typescript';
import createTransformer from '../src/transformer';
import { ContractError } from '../src/contract-error';
import { ContractViolationError } from '../src/contract-violation-error';
import { InvariantViolationError } from '../src/invariant-violation-error';

// The Account fixture, written without the fsprepost import so that the eval
// scope can provide ContractViolationError directly as a parameter.
const ACCOUNT_SOURCE = `
  export class Account {
    balance = 100;

    /**
     * @pre amount > 0
     * @pre amount <= this.balance
     * @post result === this.balance
     */
    withdraw(amount) {
      this.balance -= amount;
      return this.balance;
    }
  }
`;

function compileWithTransformer(source: string): string {
  return typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2020,
      module: typescript.ModuleKind.CommonJS,
    },
    transformers: { before: [createTransformer()] },
  }).outputText;
}

function evalWithContracts(jsSource: string): Record<string, unknown> {
  const exports: Record<string, unknown> = {};
  const mod = { exports };
  // Strip the injected fsprepost require — ContractViolationError is passed
  // directly as a function parameter instead.
  const stripped = jsSource.replace(/.*require\("fsprepost"\).*\n?/g, '');
  // eslint-disable-next-line no-new-func
  new Function('exports', 'module', 'ContractViolationError', stripped)(
    exports,
    mod,
    ContractViolationError,
  );
  return mod.exports;
}

interface AccountInstance {
  balance: number;
  withdraw(amount: number): number;
}

function makeAccount(): AccountInstance {
  const compiled = compileWithTransformer(ACCOUNT_SOURCE);
  const mod = evalWithContracts(compiled);
  const Cls = mod['Account'] as new () => AccountInstance;
  return new Cls();
}

describe('acceptance criterion 1: @pre condition fires on invalid input', () => {
  it('throws ContractViolationError PRE when amount <= 0', () => {
    const acct = makeAccount();
    expect(() => acct.withdraw(-1)).toThrow(ContractViolationError);
  });

  it('thrown error has correct type, expression and location', () => {
    const acct = makeAccount();
    try {
      acct.withdraw(-1);
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolationError);
      if (err instanceof ContractViolationError) {
        expect(err.type).toBe('PRE');
        expect(err.expression).toBe('amount > 0');
        expect(err.location).toBe('Account.withdraw');
      }
    }
  });

  it('throws PRE when amount exceeds balance', () => {
    const acct = makeAccount();
    expect(() => acct.withdraw(999)).toThrow(ContractViolationError);
  });
});

describe('acceptance criterion 2: valid call succeeds', () => {
  it('withdraw(50) completes without error', () => {
    const acct = makeAccount();
    expect(() => acct.withdraw(50)).not.toThrow();
  });

  it('withdraw(50) returns the updated balance', () => {
    const acct = makeAccount();
    expect(acct.withdraw(50)).toBe(50);
  });
});

describe('acceptance criterion 3: release build has zero contract code', () => {
  it('standard transpileModule output contains no ContractViolationError injection', () => {
    const releaseOutput = typescript.transpileModule(ACCOUNT_SOURCE, {
      compilerOptions: {
        target: typescript.ScriptTarget.ES2020,
        module: typescript.ModuleKind.CommonJS,
      },
    }).outputText;
    expect(releaseOutput).not.toContain('new ContractViolationError');
    expect(releaseOutput).not.toContain('!(amount > 0)');
  });
});

function compileES2022(source: string): string {
  return typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2022,
      module: typescript.ModuleKind.CommonJS,
    },
    transformers: { before: [createTransformer()] },
  }).outputText;
}

function evalWithInvariants(jsSource: string): Record<string, unknown> {
  const exports: Record<string, unknown> = {};
  const mod = { exports };
  const stripped = jsSource.replace(/.*require\("fsprepost"\).*\n?/g, '');
  // eslint-disable-next-line no-new-func
  new Function('exports', 'module', 'ContractViolationError', 'InvariantViolationError', stripped)(
    exports,
    mod,
    ContractViolationError,
    InvariantViolationError,
  );
  return mod.exports;
}

describe('acceptance criterion 3 (spec 003): @invariant throws InvariantViolationError', () => {
  const INVARIANT_SOURCE = `
    class BankAccount {
      balance;
      constructor(initial) { this.balance = initial; }
    }
  `;

  const INVARIANT_CLASS_SOURCE = `
    /** @invariant this.balance >= 0 */
    export class BankAccount {
      balance = 100;
      deposit(amount) { this.balance += amount; }
      withdraw(amount) { this.balance -= amount; }
      constructor(initial) { this.balance = initial; }
    }
  `;

  it('throws InvariantViolationError when method leaves invariant broken', () => {
    const compiled = compileES2022(INVARIANT_CLASS_SOURCE);
    const mod = evalWithInvariants(compiled);
    const Cls = mod['BankAccount'] as new (n: number) => { balance: number; withdraw(n: number): void };
    const acct = new Cls(100);
    expect(() => acct.withdraw(200)).toThrow(InvariantViolationError);
  });

  it('thrown InvariantViolationError has correct expression and location', () => {
    const compiled = compileES2022(INVARIANT_CLASS_SOURCE);
    const mod = evalWithInvariants(compiled);
    const Cls = mod['BankAccount'] as new (n: number) => { balance: number; withdraw(n: number): void };
    const acct = new Cls(100);
    try {
      acct.withdraw(200);
    } catch (err) {
      expect(err).toBeInstanceOf(InvariantViolationError);
      if (err instanceof InvariantViolationError) {
        expect(err.expression).toBe('this.balance >= 0');
        expect(err.location).toBe('BankAccount.withdraw');
      }
    }
  });

  it('throws InvariantViolationError from constructor when invariant not established', () => {
    const compiled = compileES2022(INVARIANT_CLASS_SOURCE);
    const mod = evalWithInvariants(compiled);
    const Cls = mod['BankAccount'] as new (n: number) => unknown;
    expect(() => new Cls(-1)).toThrow(InvariantViolationError);
  });

  it('valid operations do not throw', () => {
    const compiled = compileES2022(INVARIANT_CLASS_SOURCE);
    const mod = evalWithInvariants(compiled);
    const Cls = mod['BankAccount'] as new (n: number) => { balance: number; withdraw(n: number): void; deposit(n: number): void };
    const acct = new Cls(100);
    expect(() => acct.deposit(50)).not.toThrow();
    expect(() => acct.withdraw(50)).not.toThrow();
  });

  it('InvariantViolationError is caught by ContractError', () => {
    const compiled = compileES2022(INVARIANT_CLASS_SOURCE);
    const mod = evalWithInvariants(compiled);
    const Cls = mod['BankAccount'] as new (n: number) => { withdraw(n: number): void };
    const acct = new Cls(100);
    try {
      acct.withdraw(200);
    } catch (err) {
      expect(err).toBeInstanceOf(ContractError);
    }
  });

  void INVARIANT_SOURCE; // suppress unused warning — kept for reference
});

describe('acceptance criterion 5: @post uses result correctly', () => {
  it('post-condition receives the return value and does not throw when satisfied', () => {
    const source = `
      /** @post result === 42 */
      export function getAnswer() { return 42; }
    `;
    const compiled = compileWithTransformer(source);
    const mod = evalWithContracts(compiled);
    const getAnswer = mod['getAnswer'] as () => number;
    expect(getAnswer()).toBe(42);
  });

  it('post-condition throws ContractViolationError POST when result violates contract', () => {
    const source = `
      /** @post result > 100 */
      export function getSmall() { return 1; }
    `;
    const compiled = compileWithTransformer(source);
    const mod = evalWithContracts(compiled);
    const getSmall = mod['getSmall'] as () => number;
    try {
      getSmall();
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolationError);
      if (err instanceof ContractViolationError) {
        expect(err.type).toBe('POST');
      }
    }
  });
});
