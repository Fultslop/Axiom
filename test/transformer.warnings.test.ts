import { transform, transpileWithWarn } from './helpers';

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
});
