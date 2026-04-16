import typescript from 'typescript';
import createTransformer from '@src/transformer';
import { transform, transformWithProgram } from './helpers';

describe('transformer — interface contracts', () => {
  it('injects @pre from interface when class has no own @pre', () => {
    const source = `
      interface IFoo {
        /** @pre amount > 0 */
        bar(amount: number): number;
      }
      class Foo implements IFoo {
        bar(amount: number): number { return amount; }
      }
    `;
    const output = transformWithProgram(source);
    expect(output).toContain('ContractViolationError');
    expect(output).toContain('amount > 0');
  });

  it('does not inject contracts when interface has none', () => {
    const source = `
      interface IFoo {
        bar(amount: number): number;
      }
      class Foo implements IFoo {
        bar(amount: number): number { return amount; }
      }
    `;
    const output = transformWithProgram(source);
    expect(output).not.toContain('ContractViolationError');
  });

  it('emits merge warning when both interface and class define @pre', () => {
    const warnings: string[] = [];
    const source = `
      interface IFoo {
        /** @pre amount > 0 */
        bar(amount: number): number;
      }
      class Foo implements IFoo {
        /** @pre amount < 1000 */
        bar(amount: number): number { return amount; }
      }
    `;
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes('Contract merge warning'))).toBe(true);
    expect(warnings.some((w) => w.includes('@pre'))).toBe(true);
  });

  it('emits merge warning when both interface and class define @invariant', () => {
    const warnings: string[] = [];
    const source = `
      /** @invariant this.balance >= 0 */
      interface IFoo { bar(): void; }
      /** @invariant this.owner !== null */
      class Foo implements IFoo {
        balance = 0;
        owner = '';
        bar(): void {}
      }
    `;
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes('Contract merge warning'))).toBe(true);
    expect(warnings.some((w) => w.includes('@invariant'))).toBe(true);
  });

  it('emits warning when TypeChecker is unavailable and class has implements clause', () => {
    const warnings: string[] = [];
    const source = `
      interface IFoo { bar(): void; }
      class Foo implements IFoo { bar(): void {} }
    `;
    transform(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes('Interface contract resolution skipped'))).toBe(true);
  });

  it('respects interfaceParamMismatch: ignore option', () => {
    const warnings: string[] = [];
    const source = `
      interface IFoo {
        /** @pre amount > 0 */
        bar(amount: number): number;
      }
      class Foo implements IFoo {
        bar(value: number): number { return value; }
      }
    `;
    const fileName = 'virtual-test.ts';
    const compilerOptions: typescript.CompilerOptions = {
      target: typescript.ScriptTarget.ES2020,
      module: typescript.ModuleKind.CommonJS,
      skipLibCheck: true,
    };
    const defaultHost = typescript.createCompilerHost(compilerOptions);
    const customHost: typescript.CompilerHost = {
      ...defaultHost,
      getSourceFile(name, version) {
        if (name === fileName) {
          return typescript.createSourceFile(name, source, version, true);
        }
        return defaultHost.getSourceFile(name, version);
      },
      fileExists(name) {
        return name === fileName || defaultHost.fileExists(name);
      },
      readFile(name) {
        return name === fileName ? source : defaultHost.readFile(name);
      },
    };
    const program = typescript.createProgram([fileName], compilerOptions, customHost);
    const sourceFile = program.getSourceFile(fileName)!;
    let output = '';
    program.emit(
      sourceFile,
      (_, text) => { output = text; },
      undefined,
      false,
      {
        before: [createTransformer(
          program,
          { warn: (msg) => warnings.push(msg), interfaceParamMismatch: 'ignore' },
        )],
      },
    );
    expect(output).not.toContain('amount > 0');
    expect(warnings.some((w) => w.includes('skipped'))).toBe(true);
  });
});
