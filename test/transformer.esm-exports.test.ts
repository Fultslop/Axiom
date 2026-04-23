import typescript from 'typescript';
import createTransformer from '@src/transformer';

function transformWithProgramAndModule(
  source: string,
  moduleKind: typescript.ModuleKind,
  warn?: (msg: string) => void,
  fileName = 'virtual-test.ts',
): string {
  const compilerOptions: typescript.CompilerOptions = {
    target: typescript.ScriptTarget.ES2020,
    module: moduleKind,
    skipLibCheck: true,
  };
  const defaultHost = typescript.createCompilerHost(compilerOptions);
  const customHost: typescript.CompilerHost = {
    ...defaultHost,
    getSourceFile(name, languageVersion) {
      if (name === fileName) {
        return typescript.createSourceFile(name, source, languageVersion, true);
      }
      return defaultHost.getSourceFile(name, languageVersion);
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
  const transformerOptions = warn !== undefined ? { warn } : undefined;
  let output = '';
  program.emit(
    sourceFile,
    (_, text) => { output = text; },
    undefined,
    false,
    { before: [createTransformer(program, transformerOptions)] },
  );
  return output;
}

describe('transformer — ESM exports prefix', () => {
  describe('CJS target regression', () => {
    it('emits exports. prefix for exported const in @pre with CommonJS output', () => {
      const source = `
        export const MAX_LIMIT = 100;
        /**
         * @pre n <= MAX_LIMIT
         */
        export function cap(n: number): number { return n; }
      `;
      const output = transformWithProgramAndModule(source, typescript.ModuleKind.CommonJS);
      expect(output).toContain('exports.MAX_LIMIT');
      expect(output).toContain('!(n <= exports.MAX_LIMIT)');
    });

    it('emits exports. prefix for exported enum in @pre with CommonJS output', () => {
      const source = `
        export enum Mode { Fast = 0, Slow = 1 }
        /**
         * @pre mode === Mode.Fast
         */
        export function checkMode(mode: number): void {}
      `;
      const output = transformWithProgramAndModule(source, typescript.ModuleKind.CommonJS);
      expect(output).toContain('!(mode === exports.Mode.Fast)');
    });
  });

  describe('ESM targets — ESNext', () => {
    it('emits bare identifier for exported const in @pre with ESNext output', () => {
      const source = `
        export const MAX_LIMIT = 100;
        /**
         * @pre n <= MAX_LIMIT
         */
        export function cap(n: number): number { return n; }
      `;
      const output = transformWithProgramAndModule(source, typescript.ModuleKind.ESNext);
      expect(output).toContain('!(n <= MAX_LIMIT)');
      expect(output).not.toContain('!(n <= exports.MAX_LIMIT)');
    });

    it('emits bare identifier for exported const in @post with ESNext output', () => {
      const source = `
        export const MAX = 50;
        /**
         * @post result <= MAX
         */
        export function clamp(n: number): number { return Math.min(n, MAX); }
      `;
      const output = transformWithProgramAndModule(source, typescript.ModuleKind.ESNext);
      expect(output).toContain('__axiom_result__ <= MAX)');
      expect(output).not.toContain('exports.MAX');
    });

    it('does not emit exports. in guard for parameter-only @pre with ESNext output', () => {
      const source = `
        /**
         * @pre n > 0
         */
        export function positive(n: number): number { return n; }
      `;
      const output = transformWithProgramAndModule(source, typescript.ModuleKind.ESNext);
      expect(output).toContain('!(n > 0)');
    });
  });

  describe('ESM targets — ES2022', () => {
    it('emits bare identifier for exported const in @pre with ES2022 output', () => {
      const source = `
        export const CAP = 200;
        /**
         * @pre x < CAP
         */
        export function limit(x: number): number { return x; }
      `;
      const output = transformWithProgramAndModule(source, typescript.ModuleKind.ES2022);
      expect(output).toContain('!(x < CAP)');
      expect(output).not.toContain('!(x < exports.CAP)');
    });
  });

  describe('ESM targets — Node16', () => {
    it('emits bare identifier in guard for exported enum in @post with Node16', () => {
      const source = `
        export enum Status { Ok = 0, Fail = 1 }
        /**
         * @post result === Status.Ok
         */
        export function run(): number { return 0; }
      `;
      const output = transformWithProgramAndModule(source, typescript.ModuleKind.Node16, undefined, 'virtual-test.mts');
      expect(output).toContain('!(__axiom_result__ === Status.Ok)');
    });
  });
});
