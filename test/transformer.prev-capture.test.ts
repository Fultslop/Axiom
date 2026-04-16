import { transform, transformWithProgram } from './helpers';

describe('transformer — @prev capture for @post conditions', () => {
  it('injects const prev = { ...this } for method with prev in @post and no @prev tag', () => {
    const source = `
      class Account {
        balance = 100;
        /** @post this.balance === prev.balance + x */
        public addToBalance(x: number): void {
          this.balance += x;
        }
      }
    `;
    const output = transformWithProgram(source);
    expect(output).toContain('const __axiom_prev__ = ({ ...this })');
    expect(output).toContain('!(this.balance === __axiom_prev__.balance + x)');
  });

  it('injects deepSnapshot(this) for @prev deep', () => {
    const source = `
      class Account {
        balance = 100;
        /** @prev deep @post this.balance === prev.balance + x */
        public addToBalance(x: number): void {
          this.balance += x;
        }
      }
    `;
    const output = transformWithProgram(source);
    expect(output).toContain('const __axiom_prev__ = deepSnapshot(this)');
  });

  it('injects verbatim expression for @prev with custom expression', () => {
    const source = `
      class Account {
        balance = 100;
        /** @prev { balance: this.balance, x } @post this.balance === prev.balance + x */
        public addToBalance(x: number): void {
          this.balance += x;
        }
      }
    `;
    const output = transformWithProgram(source);
    expect(output).toContain('const __axiom_prev__ = ({ balance: this.balance, x })');
  });

  it('supports scalar prev capture', () => {
    const source = `
      class Account {
        balance = 100;
        /** @prev this.balance @post this.balance === prev + x */
        public addToBalance(x: number): void {
          this.balance += x;
        }
      }
    `;
    const output = transformWithProgram(source);
    expect(output).toContain('const __axiom_prev__ = this.balance');
    expect(output).toContain('!(this.balance === __axiom_prev__ + x)');
  });

  it('warns and drops @post for standalone function with prev in @post and no @prev', () => {
    const warn = jest.fn();
    const source = `
      /** @post result === prev.x + 1 */
      export function foo(x: number): number { return x + 1; }
    `;
    const output = transform(source, warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("'prev' used but no @prev"));
    expect(output).not.toContain('const __axiom_prev__');
  });

  it('works for standalone function with @prev expression', () => {
    const source = `
      /** @prev { x } @post result === prev.x + 1 */
      export function foo(x: number): number { return x + 1; }
    `;
    const output = transformWithProgram(source);
    expect(output).toContain('const __axiom_prev__ =');
    expect(output).toContain('!(__axiom_result__ === __axiom_prev__.x + 1)');
  });

  it('does not inject const prev when @post has no prev reference', () => {
    const source = `
      /** @post result > 0 */
      export function foo(x: number): number { return x + 1; }
    `;
    const output = transform(source);
    expect(output).not.toContain('const __axiom_prev__');
  });

  it('warns when multiple @prev tags are present, uses first', () => {
    const warn = jest.fn();
    const source = `
      class Account {
        balance = 100;
        /** @prev this.balance @prev deep @post this.balance === prev + x */
        public addToBalance(x: number): void {
          this.balance += x;
        }
      }
    `;
    const output = transformWithProgram(source, warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('multiple @prev'));
    expect(output).toContain('const __axiom_prev__ = this.balance');
  });
});
