import { transform, transformES2022 } from './helpers';

describe('transformer — constructor contracts', () => {
  describe('basic @pre injection', () => {
    it('injects pre-check for constructor @pre tag', () => {
      const source = `
        export class Account {
          balance: number;
          /**
           * @pre initialBalance >= 0
           */
          constructor(initialBalance: number) {
            this.balance = initialBalance;
          }
        }
      `;
      const output = transform(source);
      expect(output).toContain('ContractViolationError');
      expect(output).toContain('!(initialBalance >= 0)');
      expect(output).toContain('"PRE"');
    });

    it('throws at runtime when constructor @pre is violated', () => {
      const source = `
        export class Account {
          balance: number;
          /**
           * @pre initialBalance >= 0
           */
          constructor(initialBalance: number) {
            this.balance = initialBalance;
          }
        }
      `;
      const output = transform(source);
      const mod = { exports: {} as Record<string, unknown> };
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function('module', 'exports', 'require', output)(
        mod,
        mod.exports,
        () => ({ ContractViolationError: class ContractViolationError extends Error {} }),
      );
      const AccountClass = mod.exports['Account'] as new (n: number) => unknown;
      expect(() => new AccountClass(100)).not.toThrow();
    });

    it('uses ClassName (not ClassName.constructor) as the location string', () => {
      const source = `
        export class Account {
          balance: number;
          /**
           * @pre initialBalance >= 0
           */
          constructor(initialBalance: number) {
            this.balance = initialBalance;
          }
        }
      `;
      const output = transform(source);
      expect(output).toContain('"Account"');
      expect(output).not.toContain('"Account.constructor"');
    });
  });

  describe('basic @post injection', () => {
    it('injects post-check for constructor @post tag', () => {
      const source = `
        export class Account {
          balance: number;
          /**
           * @post this.balance === initialBalance
           */
          constructor(initialBalance: number) {
            this.balance = initialBalance;
          }
        }
      `;
      const output = transform(source);
      expect(output).toContain('ContractViolationError');
      expect(output).toContain('!(this.balance === initialBalance)');
      expect(output).toContain('"POST"');
    });

    it('injects both @pre and @post with original statements in between', () => {
      const source = `
        export class Account {
          balance: number;
          /**
           * @pre initialBalance >= 0
           * @post this.balance === initialBalance
           */
          constructor(initialBalance: number) {
            this.balance = initialBalance;
          }
        }
      `;
      const output = transform(source);
      const preIndex = output.indexOf('!(initialBalance >= 0)');
      const postIndex = output.indexOf('!(this.balance === initialBalance)');
      expect(preIndex).toBeGreaterThan(-1);
      expect(postIndex).toBeGreaterThan(-1);
      expect(preIndex).toBeLessThan(postIndex);
    });
  });

  describe('result and prev filtering', () => {
    it('warns and drops @post that uses result', () => {
      const source = `
        export class Account {
          balance: number;
          /**
           * @post result > 0
           */
          constructor(initialBalance: number) {
            this.balance = initialBalance;
          }
        }
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes("'result' used in constructor @post") && w.includes('Account')),
      ).toBe(true);
      expect(output).not.toContain('ContractViolationError');
    });

    it('warns and drops @post that uses prev', () => {
      const source = `
        export class Account {
          balance: number;
          /**
           * @post this.balance === prev.balance
           */
          constructor(initialBalance: number) {
            this.balance = initialBalance;
          }
        }
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes("'prev' used in constructor @post") && w.includes('Account')),
      ).toBe(true);
      expect(output).not.toContain('ContractViolationError');
    });

    it('drops result @post but still injects a valid sibling @post', () => {
      const source = `
        export class Account {
          balance: number;
          /**
           * @post result > 0
           * @post this.balance === initialBalance
           */
          constructor(initialBalance: number) {
            this.balance = initialBalance;
          }
        }
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes("'result' used in constructor @post"))).toBe(true);
      expect(output).toContain('!(this.balance === initialBalance)');
    });
  });

  describe('ordering with invariants', () => {
    it('places @post check before #checkInvariants() call', () => {
      const source = `
        /**
         * @invariant this.balance >= 0
         */
        export class Account {
          balance: number;
          /**
           * @post this.balance === initialBalance
           */
          constructor(initialBalance: number) {
            this.balance = initialBalance;
          }
        }
      `;
      const output = transformES2022(source);
      const postIndex = output.indexOf('!(this.balance === initialBalance)');
      const invariantIndex = output.indexOf('this.#checkInvariants(');
      expect(postIndex).toBeGreaterThan(-1);
      expect(invariantIndex).toBeGreaterThan(-1);
      expect(postIndex).toBeLessThan(invariantIndex);
    });

    it('places @pre at top, then original statements, then invariant (no @post)', () => {
      const source = `
        /**
         * @invariant this.balance >= 0
         */
        export class Account {
          balance: number;
          /**
           * @pre initialBalance >= 0
           */
          constructor(initialBalance: number) {
            this.balance = initialBalance;
          }
        }
      `;
      const output = transformES2022(source);
      const preIndex = output.indexOf('!(initialBalance >= 0)');
      const assignIndex = output.indexOf('this.balance = initialBalance');
      const invariantIndex = output.indexOf('this.#checkInvariants(');
      expect(preIndex).toBeGreaterThan(-1);
      expect(assignIndex).toBeGreaterThan(-1);
      expect(invariantIndex).toBeGreaterThan(-1);
      expect(preIndex).toBeLessThan(assignIndex);
      expect(assignIndex).toBeLessThan(invariantIndex);
    });

    it('existing invariant-only constructor injection still works (no @pre/@post)', () => {
      const source = `
        /**
         * @invariant this.balance >= 0
         */
        export class Account {
          balance: number;
          constructor(initialBalance: number) {
            this.balance = initialBalance;
          }
        }
      `;
      const output = transformES2022(source);
      expect(output).toContain('#checkInvariants');
      expect(output).not.toContain('throw new ContractViolationError');
    });
  });

  describe('identifier validation', () => {
    it('validates @pre with this.x (this is in scope)', () => {
      const source = `
        export class Account {
          balance: number;
          /**
           * @pre this.balance === 0
           */
          constructor(initialBalance: number) {
            this.balance = initialBalance;
          }
        }
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(this.balance === 0)');
    });

    it('warns and drops @pre with unknown identifier', () => {
      const source = `
        export class Account {
          balance: number;
          /**
           * @pre unknownVar > 0
           */
          constructor(initialBalance: number) {
            this.balance = initialBalance;
          }
        }
      `;
      const warnings: string[] = [];
      transform(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('unknownVar') && w.includes('Account')),
      ).toBe(true);
    });
  });

  describe('no-op cases', () => {
    it('returns constructor node unchanged when no @pre/@post and no invariants', () => {
      const source = `
        export class Account {
          balance: number;
          constructor(initialBalance: number) {
            this.balance = initialBalance;
          }
        }
      `;
      const output = transform(source);
      expect(output).not.toContain('ContractViolationError');
      expect(output).not.toContain('#checkInvariants');
    });

    it('does not throw on a constructor without a body (declare class)', () => {
      const source = `
        export declare class Account {
          balance: number;
          /**
           * @pre initialBalance >= 0
           */
          constructor(initialBalance: number);
        }
      `;
      expect(() => transform(source)).not.toThrow();
    });

    it('injects nothing when all @post tags are filtered out and no @pre and no invariants', () => {
      const source = `
        export class Account {
          balance: number;
          /**
           * @post result > 0
           */
          constructor(initialBalance: number) {
            this.balance = initialBalance;
          }
        }
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes("'result' used in constructor @post"))).toBe(true);
      expect(output).not.toContain('ContractViolationError');
    });
  });
});
