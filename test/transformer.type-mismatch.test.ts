import { transform, transformWithProgram } from './helpers';

describe('transformer — type mismatch detection', () => {
  describe('requires real Program', () => {
    it('warns when @pre compares number param to string literal', () => {
      const warn = jest.fn();
      const source = `
        /** @pre amount === "foo" */
        export function bad(amount: number): number { return amount; }
      `;
      transformWithProgram(source, warn);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('type mismatch'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('amount'));
    });

    it('does not warn when @pre compares number param to number literal', () => {
      const warn = jest.fn();
      const source = `
        /** @pre amount > 0 */
        export function good(amount: number): number { return amount; }
      `;
      transformWithProgram(source, warn);
      expect(warn).not.toHaveBeenCalled();
    });

    it('warns when @pre compares string param to number literal', () => {
      const warn = jest.fn();
      const source = `
        /** @pre name !== 42 */
        export function badStr(name: string): string { return name; }
      `;
      transformWithProgram(source, warn);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('type mismatch'));
    });

    it('warns when @pre compares boolean param to string literal', () => {
      const warn = jest.fn();
      const source = `
        /** @pre flag === "true" */
        export function badBool(flag: boolean): boolean { return flag; }
      `;
      transformWithProgram(source, warn);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('type mismatch'));
    });

    it('does not warn for transpileModule path (no program)', () => {
      const warn = jest.fn();
      const source = `
        /** @pre amount === "foo" */
        export function noCheck(amount: number): number { return amount; }
      `;
      transform(source, warn);
      expect(warn).not.toHaveBeenCalled();
    });

    it('warns when @post compares result to string literal when return type is number', () => {
      const warn = jest.fn();
      const source = `
        /** @post result === "foo" */
        export function badPost(x: number): number { return x + 1; }
      `;
      transformWithProgram(source, warn);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('type mismatch'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('result'));
    });

    it('does not warn when @post result type matches return type', () => {
      const warn = jest.fn();
      const source = `
        /** @post result > 0 */
        export function goodPost(x: number): number { return x + 1; }
      `;
      transformWithProgram(source, warn);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('typeof guard narrowing in && chains', () => {
    it('warns when typeof-narrowed-to-string param is compared to number literal', () => {
      const source = `
        /**
         * @pre typeof x === "string" && x === 42
         */
        export function foo(x: string | number): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('type mismatch') && w.includes("'x'"))).toBe(true);
    });

    it('does not warn when typeof-narrowed-to-number param is used in numeric comparison', () => {
      const source = `
        /**
         * @pre typeof x === "number" && x > 0
         */
        export function foo(x: string | number): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
    });

    it('warns when typeof-narrowed-to-boolean param is compared to number literal', () => {
      const source = `
        /**
         * @pre typeof x === "boolean" && x === 1
         */
        export function foo(x: boolean | number): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('type mismatch') && w.includes("'x'"))).toBe(true);
    });

    it('does not warn when typeof-narrowed-to-string param is compared to string literal', () => {
      const source = `
        /**
         * @pre typeof x === "string" && x === "hello"
         */
        export function foo(x: string | number): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
    });
  });

  describe('typeof narrowing — existing behaviour preserved', () => {
    it('warns on non-union string param in typeof guard expression (existing path)', () => {
      const source = `
        /**
         * @pre typeof x === "string" && x === 42
         */
        export function foo(x: string): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('type mismatch') && w.includes("'x'"))).toBe(true);
    });

    it('does not warn for non-union number param in valid numeric comparison', () => {
      const source = `
        /**
         * @pre typeof x === "number" && x > 0
         */
        export function foo(x: number): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
    });
  });

  describe('typeof narrowing — null-check union unaffected', () => {
    it('warns when number|null param is compared to string literal (existing union resolution)', () => {
      const source = `
        /**
         * @pre x !== null && x === "zero"
         */
        export function foo(x: number | null): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('type mismatch') && w.includes("'x'"))).toBe(true);
    });
  });

  describe('typeof narrowing — edge cases', () => {
    it('does not apply narrowing from || chains', () => {
      const source = `
        /**
         * @pre typeof x === "string" || x === 42
         */
        export function foo(x: string | number): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.filter((w) => w.includes('type mismatch'))).toHaveLength(0);
    });

    it('narrows multiple params independently in same && chain', () => {
      const source = `
        /**
         * @pre typeof x === "string" && typeof y === "number" && x === 42
         */
        export function foo(x: string | number, y: string | number): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('type mismatch') && w.includes("'x'"))).toBe(true);
      expect(warnings.filter((w) => w.includes("'y'"))).toHaveLength(0);
    });

    it('does not extract narrowing from loose-equality typeof guard (== not ===)', () => {
      const source = `
        /**
         * @pre typeof x == "string" && x === 42
         */
        export function foo(x: string | number): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.filter((w) => w.includes('type mismatch'))).toHaveLength(0);
    });

    it('does not warn when comparison appears before typeof guard (short-circuit)', () => {
      const source = `
        /**
         * @pre x === 42 && typeof x === "string"
         */
        export function foo(x: string | number): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.filter((w) => w.includes('type mismatch'))).toHaveLength(0);
    });

    it('warns when comparison appears after typeof guard in reversed position', () => {
      const source = `
        /**
         * @pre typeof x === "string" && x === 42
         */
        export function foo(x: string | number): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('type mismatch') && w.includes("'x'"))).toBe(true);
    });
  });

  describe('NoSubstitutionTemplateLiteral mismatch', () => {
    it('warns when a number parameter is compared to a backtick string literal', () => {
      const source = `
        /**
         * @pre count === \`hello\`
         */
        export function run(count: number): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('type mismatch') && w.includes('count'))).toBe(true);
    });

    it('does not warn when a string parameter is compared to a backtick string literal', () => {
      const source = `
        /**
         * @pre label === \`hello\`
         */
        export function tag(label: string): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
    });
  });

  describe('union type parameter mismatch', () => {
    it('warns when number|undefined param is compared to string literal', () => {
      const source = `
        /**
         * @pre amount === "zero"
         */
        export function pay(amount: number | undefined): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('type mismatch') && w.includes('amount'))).toBe(true);
    });

    it('warns when string|null param is compared to number literal', () => {
      const source = `
        /**
         * @pre label === 42
         */
        export function tag(label: string | null): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('type mismatch') && w.includes('label'))).toBe(true);
    });

    it('does not warn for ambiguous union (number|string)', () => {
      const source = `
        /**
         * @pre val === 1
         */
        export function foo(val: number | string): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
    });
  });

  describe('non-primitive parameter type mismatch', () => {
    it('warns when array parameter is compared to number literal', () => {
      const source = `
        /**
         * @pre items === 42
         */
        export function process(items: string[]): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('type mismatch') && w.includes('items')),
      ).toBe(true);
    });

    it('warns when object parameter is compared to string literal', () => {
      const source = `
        interface Point { x: number; y: number }
        /**
         * @pre pt === "hello"
         */
        export function move(pt: Point): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('type mismatch') && w.includes('pt')),
      ).toBe(true);
    });

    it('does not warn when checking a property of an object parameter', () => {
      const source = `
        /**
         * @pre items.length > 0
         */
        export function process(items: string[]): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
    });
  });

  describe('non-primitive return type mismatch for result', () => {
    it('warns when result is compared to number literal but return type is string', () => {
      const source = `
        /**
         * @post result === 42
         */
        export function getName(): string { return ""; }
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('type mismatch') && w.includes('result')),
      ).toBe(true);
    });

    it('warns when result is compared to string literal but return type is a record', () => {
      const source = `
        /**
         * @post result === "ok"
         */
        export function getMap(): Record<string, unknown> { return {}; }
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('type mismatch') && w.includes('result')),
      ).toBe(true);
    });
  });

  describe('unary operand type-mismatch', () => {
    it('warns when negated string parameter appears in numeric comparison', () => {
      const source = `
        /**
         * @pre -amount > 0
         */
        export function pay(amount: string): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('type mismatch') && w.includes('amount')),
      ).toBe(true);
    });

    it('warns when negated boolean parameter is compared to number literal', () => {
      const source = `
        /**
         * @pre !flag === 1
         */
        export function run(flag: boolean): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('type mismatch') && w.includes('flag')),
      ).toBe(true);
    });

    it('does not warn when negated number parameter is used in numeric comparison', () => {
      const source = `
        /**
         * @pre -amount > 0
         */
        export function pay(amount: number): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
    });
  });
});
