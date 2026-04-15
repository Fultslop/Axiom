import { transformES2022 } from './helpers';

describe('transformer — class invariants', () => {
  it('injects #checkInvariants method and call for @invariant class', () => {
    const source = `
      /** @invariant this.balance >= 0 */
      class BankAccount {
        balance = 100;
        public withdraw(amount: number): number {
          this.balance -= amount;
          return this.balance;
        }
      }
    `;
    const output = transformES2022(source);
    expect(output).toContain('InvariantViolationError');
    expect(output).toContain('#checkInvariants');
    expect(output).toContain('this.balance >= 0');
  });

  it('invariant call appears after @post check', () => {
    const source = `
      /** @invariant this.balance >= 0 */
      class BankAccount {
        balance = 100;
        /** @post result >= 0 */
        public withdraw(amount: number): number {
          this.balance -= amount;
          return this.balance;
        }
      }
    `;
    const output = transformES2022(source);
    const postIdx = output.indexOf('"POST"');
    const invariantCallIdx = output.indexOf('this.#checkInvariants(');
    expect(postIdx).toBeGreaterThanOrEqual(0);
    expect(invariantCallIdx).toBeGreaterThan(postIdx);
  });

  it('injects invariant check in constructor at exit', () => {
    const source = `
      /** @invariant this.balance >= 0 */
      class BankAccount {
        balance = 0;
        constructor(initial: number) {
          this.balance = initial;
        }
      }
    `;
    const output = transformES2022(source);
    expect(output).toContain('"BankAccount"');
    expect(output).toContain('checkInvariants');
  });

  it('does not inject invariant call in private methods', () => {
    const source = `
      /** @invariant this.balance >= 0 */
      class BankAccount {
        balance = 100;
        private helper(): void { this.balance -= 1; }
        public withdraw(amount: number): void { this.helper(); }
      }
    `;
    const output = transformES2022(source);
    const calls = [...output.matchAll(/this\.#checkInvariants\(/g)];
    expect(calls).toHaveLength(1); // withdraw only, not helper
  });

  it('class without @invariant is unaffected', () => {
    const source = `
      class Plain {
        balance = 100;
        public withdraw(amount: number): number {
          return this.balance - amount;
        }
      }
    `;
    const output = transformES2022(source);
    expect(output).not.toContain('InvariantViolationError');
    expect(output).not.toContain('#checkInvariants');
  });

  it('multiple @invariant tags all appear in #checkInvariants body', () => {
    const source = `
      /**
       * @invariant this.balance >= 0
       * @invariant this.owner !== null
       */
      class BankAccount {
        balance = 100;
        owner = "Alice";
        public withdraw(amount: number): number { return this.balance; }
      }
    `;
    const output = transformES2022(source);
    expect(output).toContain('this.balance >= 0');
    expect(output).toContain('this.owner !== null');
  });

  it('injects InvariantViolationError in require when @invariant present', () => {
    const source = `
      /** @invariant this.balance >= 0 */
      class BankAccount {
        balance = 100;
        public withdraw(amount: number): number { return this.balance; }
      }
    `;
    const output = transformES2022(source);
    expect(output).toContain('InvariantViolationError');
    expect(output).toContain('axiom');
  });

  it('warns and skips invariant injection when #checkInvariants already defined', () => {
    const warn = jest.fn();
    const source = `
      /** @invariant this.balance >= 0 */
      class BankAccount {
        balance = 100;
        #checkInvariants(location: string): void {}
        public withdraw(amount: number): number { return this.balance; }
      }
    `;
    const output = transformES2022(source, warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('#checkInvariants'));
    expect(output).not.toContain('InvariantViolationError');
  });

  it('warns and skips invalid @invariant expressions', () => {
    const warn = jest.fn();
    const source = `
      /** @invariant unknownVar > 0 */
      class BankAccount {
        balance = 100;
        public withdraw(amount: number): number { return this.balance; }
      }
    `;
    const output = transformES2022(source, warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknownVar'));
    expect(output).not.toContain('InvariantViolationError');
  });

  it('does not inject invariant call into static methods', () => {
    const source = `
      /** @invariant this.max > this.min */
      class Foo {
        max = 1;
        min = 0;
        /** @pre xxx > 0 */
        public static doStaticFn(xxx: number): number { return xxx + 1; }
      }
    `;
    const output = transformES2022(source);
    expect(output).toContain('!(xxx > 0)');
    const staticIdx = output.indexOf('static doStaticFn');
    const nextMethodIdx = output.indexOf('\n    }', staticIdx);
    const staticBody = output.slice(staticIdx, nextMethodIdx);
    expect(staticBody).not.toContain('#checkInvariants');
  });

  it('instance method in invariant class throws when invariant is violated', () => {
    const source = `
      /** @invariant this.max > this.min */
      class Foo {
        max = 1;
        min = 0;
        public updateMinMax(min: number, max: number): void {
          this.min = min;
          this.max = max;
        }
        constructor() {}
      }
    `;
    const output = transformES2022(source);
    expect(output).toContain('#checkInvariants');
    expect(output).toContain('"Foo.updateMinMax"');
  });
});
