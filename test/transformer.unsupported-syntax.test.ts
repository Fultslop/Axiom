import { transform, transformWithProgram, transpileWithWarn } from './helpers';

describe('transformer — unsupported syntax and misuse warnings', () => {
  describe('@pre/@post on constructor (simple cases)', () => {
    it('injects @pre check for constructor @pre tag', () => {
      const source = `
        export class Counter {
          /** @pre x > 0 */
          constructor(private x: number) {}
        }
      `;
      const warnings: string[] = [];
      const output = transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(output).toContain('!(x > 0)');
      expect(warnings).toHaveLength(0);
    });

    it('warns and drops @post that uses result on constructor', () => {
      const source = `
        export class Box {
          /** @post result !== null */
          constructor(public value: string) {}
        }
      `;
      const warnings: string[] = [];
      const output = transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes("'result' used in constructor @post") && w.includes('Box')),
      ).toBe(true);
      expect(output).not.toContain('ContractViolationError');
    });

    it('does not warn for @pre on a regular method', () => {
      const source = `
        export class Calc {
          /** @pre x > 0 */
          double(x: number): number { return x * 2; }
        }
      `;
      const warnings: string[] = [];
      transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
    });

    it('injects both @pre check and invariant into constructor', () => {
      const source = `
        /** @invariant this.x > 0 */
        export class Guarded {
          /** @pre x > 0 */
          constructor(private x: number) {}
        }
      `;
      const warnings: string[] = [];
      const output = transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(output).toContain('checkInvariants');
      expect(output).toContain('!(x > 0)');
      expect(warnings).toHaveLength(0);
    });
  });

  describe('property chain validation', () => {
    it('drops @pre with a misspelled this-property and emits a warning', () => {
      const source = `
        class BankAccount {
          balance: number = 0;
          /**
           * @pre this.balanc > 0
           */
          withdraw(amount: number): void {}
        }
      `;
      const warnings: string[] = [];
      const output = transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('balanc'))).toBe(true);
      expect(output).not.toContain('!(this.balanc > 0)');
    });

    it('injects @pre with a correctly spelled this-property without warning', () => {
      const source = `
        class BankAccount {
          balance: number = 0;
          /**
           * @pre this.balance > 0
           */
          withdraw(amount: number): void {}
        }
      `;
      const warnings: string[] = [];
      const output = transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(this.balance > 0)');
    });

    it('drops @pre when an intermediate chain property is missing', () => {
      const source = `
        interface Config { timeout: number }
        class Service {
          cfg: Config = { timeout: 10 };
          /**
           * @pre this.cfg.limit > 0
           */
          run(): void {}
        }
      `;
      const warnings: string[] = [];
      const output = transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('limit'))).toBe(true);
      expect(output).not.toContain('!(this.cfg.limit > 0)');
    });

    it('injects @pre when all properties in a two-level chain exist', () => {
      const source = `
        interface Config { timeout: number }
        class Service {
          cfg: Config = { timeout: 10 };
          /**
           * @pre this.cfg.timeout > 0
           */
          run(): void {}
        }
      `;
      const warnings: string[] = [];
      const output = transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(this.cfg.timeout > 0)');
    });

    it('injects @pre with misspelled this-property in transpileModule mode (no checker)', () => {
      const source = `
        class BankAccount {
          balance: number = 0;
          /**
           * @pre this.balanc > 0
           */
          withdraw(amount: number): void {}
        }
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(this.balanc > 0)');
    });

    describe('optional chaining on nullable parameter', () => {
      it('injects @pre for obj?.value when obj is ValueCarrier | null (no warning)', () => {
        const source = `
          interface ValueCarrier { value: number }
          /**
           * @pre obj?.value > 0
           */
          export function doOptionalFn(obj: ValueCarrier | null): number | null { return null; }
        `;
        const warnings: string[] = [];
        const output = transformWithProgram(source, (msg) => warnings.push(msg));
        expect(warnings).toHaveLength(0);
        expect(output).toContain('(obj.value > 0)');
      });

      it('injects @pre for obj.value when obj is ValueCarrier (non-nullable, regression)', () => {
        const source = `
          interface ValueCarrier { value: number }
          /**
           * @pre obj.value > 0
           */
          export function doFn(obj: ValueCarrier): number { return 0; }
        `;
        const warnings: string[] = [];
        const output = transformWithProgram(source, (msg) => warnings.push(msg));
        expect(warnings).toHaveLength(0);
        expect(output).toContain('(obj.value > 0)');
      });

      it('warns for obj.balanc when obj is BankAccount (typo, regression)', () => {
        const source = `
          interface BankAccount { balance: number }
          /**
           * @pre obj.balanc > 0
           */
          export function doFn(obj: BankAccount): number { return 0; }
        `;
        const warnings: string[] = [];
        transformWithProgram(source, (msg) => warnings.push(msg));
        expect(warnings.some((w) => w.includes('balanc'))).toBe(true);
      });

      it('injects @pre for multi-step obj?.a?.b with all types nullable (no warning)', () => {
        const source = `
          interface Inner { bbb: number }
          interface Outer { aaa: Inner | undefined }
          /**
           * @pre obj?.aaa?.bbb > 0
           */
          export function deepFn(obj: Outer | null): number { return 0; }
        `;
        const warnings: string[] = [];
        const output = transformWithProgram(source, (msg) => warnings.push(msg));
        expect(warnings).toHaveLength(0);
        expect(output).toContain('(obj.aaa.bbb > 0)');
      });

      it('warns for obj?.a?.missing when the final property does not exist', () => {
        const source = `
          interface Inner { bbb: number }
          interface Outer { aaa: Inner | undefined }
          /**
           * @pre obj?.aaa?.missing > 0
           */
          export function deepFn(obj: Outer | null): number { return 0; }
        `;
        const warnings: string[] = [];
        transformWithProgram(source, (msg) => warnings.push(msg));
        expect(warnings.some((w) => w.includes('missing'))).toBe(true);
      });

      it('injects @pre for obj?.value in transpileModule mode (no checker, no warning)', () => {
        const source = `
          interface ValueCarrier { value: number }
          /**
           * @pre obj?.value > 0
           */
          export function doOptionalFn(obj: ValueCarrier | null): number | null { return null; }
        `;
        const warnings: string[] = [];
        const output = transform(source, (msg) => warnings.push(msg));
        expect(warnings).toHaveLength(0);
        expect(output).toContain('(obj');
        expect(output).toContain('value > 0)');
      });
    });
  });

  describe('@pre/@post on arrow function or function expression', () => {
    it('warns when named arrow function has @pre tag', () => {
      const source = `
        const foo = /** @pre x > 0 */ (x: number): number => x + 1;
      `;
      const warnings: string[] = [];
      transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('arrow functions') && w.includes('foo')),
      ).toBe(true);
    });

    it('warns when named function expression has @post tag', () => {
      const source = `
        const bar = /** @post result > 0 */ function(x: number): number { return x; };
      `;
      const warnings: string[] = [];
      transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('function expressions') && w.includes('bar')),
      ).toBe(true);
    });

    it('warns with (anonymous) for anonymous IIFE', () => {
      const source = `
        (/** @pre x > 0 */ (x: number): number => x)();
      `;
      const warnings: string[] = [];
      transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('arrow functions') && w.includes('(anonymous)')),
      ).toBe(true);
    });

    it('does not warn for named exported function declaration with @pre', () => {
      const source = `
        /** @pre x > 0 */
        export function add(x: number): number { return x + 1; }
      `;
      const warnings: string[] = [];
      transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('arrow functions'))).toBe(false);
      expect(warnings.some((w) => w.includes('function expressions'))).toBe(false);
    });
  });

  describe('@pre/@post on nested or non-exported function declaration', () => {
    it('warns for unexported top-level function with @pre', () => {
      const source = `
        /** @pre x > 0 */
        function helper(x: number): number { return x; }
      `;
      const warnings: string[] = [];
      transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('closures') && w.includes('helper')),
      ).toBe(true);
    });

    it('warns for function declaration nested inside another function', () => {
      const source = `
        export function outer(x: number): number {
          /** @pre x > 0 */
          function inner(x: number): number { return x; }
          return inner(x);
        }
      `;
      const warnings: string[] = [];
      transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('closures') && w.includes('inner')),
      ).toBe(true);
    });
  });

  describe('@pre/@post on a class body', () => {
    it('warns when @pre JSDoc is on the class declaration itself', () => {
      const source = `
        /** @pre this.x > 0 */
        export class Widget {
          constructor(public x: number) {}
        }
      `;
      const warnings: string[] = [];
      transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(
        warnings.some(
          (w) => w.includes('class declaration is not supported') && w.includes('Widget'),
        ),
      ).toBe(true);
    });

    it('class-level warning emitted AND method contracts injected normally', () => {
      const source = `
        /** @pre this.x > 0 */
        export class Dual {
          constructor(public x: number) {}
          /** @pre val > 0 */
          set(val: number): void { this.x = val; }
        }
      `;
      const warnings: string[] = [];
      const output = transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('class declaration is not supported') && w.includes('Dual')),
      ).toBe(true);
      expect(output).toContain('ContractViolationError');
    });
  });

  describe('@invariant on a non-class node', () => {
    it('warns when exported function has @invariant tag', () => {
      const source = `
        /** @invariant x > 0 */
        export function process(x: number): number { return x; }
      `;
      const warnings: string[] = [];
      transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(
        warnings.some(
          (w) => w.includes('only supported on class declarations') && w.includes('process'),
        ),
      ).toBe(true);
    });

    it('warns when variable statement has @invariant tag', () => {
      const source = `
        /** @invariant x > 0 */
        const value = 5;
      `;
      const warnings: string[] = [];
      transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('only supported on class declarations')),
      ).toBe(true);
    });

    it('warns when interface has @invariant tag', () => {
      const source = `
        /** @invariant true */
        interface Shape { area(): number; }
      `;
      const warnings: string[] = [];
      transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(
        warnings.some(
          (w) => w.includes('only supported on class declarations') && w.includes('Shape'),
        ),
      ).toBe(true);
    });

    it('does not warn for valid @invariant on a class', () => {
      const source = `
        /** @invariant this.x > 0 */
        export class Good {
          constructor(public x: number) {}
        }
      `;
      const warnings: string[] = [];
      transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('only supported on class declarations'))).toBe(false);
    });
  });
});
