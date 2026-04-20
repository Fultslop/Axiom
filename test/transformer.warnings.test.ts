import { transform, transpileWithWarn, transformWithProgram, evalTransformedWith } from './helpers';

describe('transformer — warnings', () => {
  it('skips @pre tag with assignment operator and emits a warning', () => {
    const warn = jest.fn();
    const source = `
      /** @pre xxx = vvv */
      export function foo(vvv: number, xxx: number): number { return vvv; }
    `;
    const output = transform(source, warn);
    expect(output).not.toContain('ContractViolationError');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('assignment'));
  });

  it('injects clean tags and skips only the assignment tag', () => {
    const warn = jest.fn();
    const source = `
      /**
       * @pre amount > 0
       * @pre xxx = vvv
       */
      export function pay(amount: number, vvv: number, xxx: number): number { return amount; }
    `;
    const output = transform(source, warn);
    expect(output).toContain('!(amount > 0)');
    expect(output).not.toContain('!(xxx = vvv)');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pay'));
  });

  it('does not warn when all contract tags are clean', () => {
    const warn = jest.fn();
    const source = `
      /** @pre amount > 0 */
      export function clean(amount: number): number { return amount; }
    `;
    transform(source, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when @pre expression uses unknown identifier', () => {
    const warn = jest.fn();
    const source = `
      /**
       * @pre vvv === 5
       */
      export function shouldWarn(xxx: number): number { return xxx; }
    `;
    const output = transform(source, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('vvv'));
    expect(output).not.toContain('ContractViolationError');
  });

  it('does not warn when @pre expression uses only function parameters', () => {
    const warn = jest.fn();
    const source = `
      /** @pre amount > 0 */
      export function clean(amount: number): number { return amount; }
    `;
    transform(source, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when @post expression uses unknown identifier', () => {
    const warn = jest.fn();
    const source = `
      /**
       * @post vvv >= 0
       */
      export function postWarn(amount: number): number { return amount; }
    `;
    transform(source, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('vvv'));
  });

  it('allows result in @post expressions without warning', () => {
    const warn = jest.fn();
    const source = `
      /** @post result >= 0 */
      export function noWarn(amount: number): number { return amount; }
    `;
    transform(source, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and drops @post when result is used but no return type is declared', () => {
    const warn = jest.fn();
    const source = `
      /** @post result === "foo" */
      export function noReturn(x: number) { return x; }
    `;
    const output = transform(source, warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no return type is declared'));
    expect(output).not.toContain('const __axiom_result__ =');
    expect(output).not.toContain('"POST"');
  });

  it('warns and drops @post when result is used but return type is void', () => {
    const warn = jest.fn();
    const source = `
      /** @post result === "foo" */
      export function voidReturn(x: number): void { return; }
    `;
    const output = transform(source, warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("return type is 'void'"));
    expect(output).not.toContain('const __axiom_result__ =');
    expect(output).not.toContain('"POST"');
  });

  it('warns and drops @post when result is used but return type is never', () => {
    const warn = jest.fn();
    const source = `
      /** @post result === "foo" */
      export function neverReturn(x: number): never { throw new Error(); }
    `;
    const output = transform(source, warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("return type is 'never'"));
    expect(output).not.toContain('const __axiom_result__ =');
    expect(output).not.toContain('"POST"');
  });

  it('keeps @pre without result even when return type is void', () => {
    const warn = jest.fn();
    const source = `
      /** @pre x > 0 */
      export function sideEffect(x: number): void { return; }
    `;
    const output = transform(source, warn);
    expect(warn).not.toHaveBeenCalled();
    expect(output).toContain('!(x > 0)');
  });

  it('allows this in class method contracts without warning', () => {
    const warn = jest.fn();
    const source = `
      class Account {
        /** @pre this.balance >= amount */
        public withdraw(amount: number): number { return amount; }
      }
    `;
    transpileWithWarn(source, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it('A8 — strips JSDoc comment when @pre on arrow function is dropped due to unknown identifier', () => {
    const warns: string[] = [];
    const source = `
      /** @pre unknownVar > 0 */
      export const arrowWithUnknownId = (x: number): number => x;
    `;
    const output = transformWithProgram(source, (msg) => warns.push(msg));
    expect(warns.length).toBeGreaterThan(0);
    expect(output).not.toContain('unknownVar');
  });

  it('A10 — strips JSDoc comment when @post on void-return arrow function is dropped', () => {
    const warns: string[] = [];
    const source = `
      /** @post result === undefined */
      export const arrowVoidWithPost = (msg: string): void => { console.log(msg); };
    `;
    const output = transformWithProgram(source, (msg) => warns.push(msg));
    expect(warns.length).toBeGreaterThan(0);
    expect(output).not.toContain('result === undefined');
  });

  it('B3 — strips JSDoc comment when @post on Promise<void> async function is dropped', () => {
    const warns: string[] = [];
    const source = `
      /** @post result === undefined */
      export async function asyncVoidWithPost(msg: string): Promise<void> { console.log(msg); }
    `;
    const output = transformWithProgram(source, (msg) => warns.push(msg));
    expect(warns.length).toBeGreaterThan(0);
    expect(output).not.toContain('result === undefined');
  });

  describe('array literal in @post expression — targeted warning, other contracts preserved', () => {
    it('drops only the @post tag and keeps @pre', () => {
      const source = `
        /**
         * @pre items.length > 0
         * @post result === [1, 2, 3]
         */
        export function getItems(items: number[]): number[] {
          return items;
        }
      `;
      const warnings: string[] = [];
      const js = transform(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('Internal error'))).toBe(false);
      expect(warnings.some((w) => w.includes('array literal') || w.includes('ArrayLiteralExpression'))).toBe(true);
      const fn = evalTransformedWith(js, 'getItems') as (items: number[]) => number[];
      expect(() => fn([])).toThrow('PRE');
      expect(fn([1])).toEqual([1]);
    });
  });

  describe('arrow function in @post expression — targeted warning, other contracts preserved', () => {
    it('drops only the offending @post tag and keeps @pre', () => {
      const source = `
        /**
         * @pre items.length > 0
         * @post result === items.map(x => x * 2)
         */
        export function doubled(items: number[]): number[] {
          return items.map(x => x * 2);
        }
      `;
      const warnings: string[] = [];
      const js = transform(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('Internal error'))).toBe(false);
      expect(warnings.some((w) => w.includes('arrow') || w.includes('ArrowFunction') || w.includes('function expression'))).toBe(true);
      const fn = evalTransformedWith(js, 'doubled') as (items: number[]) => number[];
      expect(() => fn([])).toThrow('PRE');
      expect(fn([2])).toEqual([4]);
    });
  });

  describe('void expression in @pre — targeted warning', () => {
    it('drops the tag with a targeted warning', () => {
      const source = `
        /** @pre void 0 */
        export function noop(x: number): void {}
      `;
      const warnings: string[] = [];
      transform(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('Internal error'))).toBe(false);
      expect(warnings.length).toBeGreaterThan(0);
    });
  });
});
