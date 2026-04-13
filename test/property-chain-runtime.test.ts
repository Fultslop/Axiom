import createTransformer from '../src/transformer';
import typescript from 'typescript';

function transformWithProgram(source: string, warn?: (msg: string) => void): string {
  const fileName = 'virtual-test.ts';
  const compilerOptions: typescript.CompilerOptions = {
    target: typescript.ScriptTarget.ES2020,
    module: typescript.ModuleKind.CommonJS,
    skipLibCheck: true,
    strict: true,
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
  const options = warn !== undefined ? { warn } : undefined;
  let output = '';
  program.emit(
    sourceFile,
    (_, text) => { output = text; },
    undefined,
    false,
    { before: [createTransformer(program, options)] },
  );
  return output;
}

describe('property chain runtime validation', () => {
  it('should drop invalid contract at runtime (parameter property chain)', () => {
    const source = `
      /**
       * @pre config.missing.value > 0
       */
      export function invalidParamChain(config: { value: number }): boolean {
        return config.value > 0;
      }
    `;

    const warnings: string[] = [];
    const output = transformWithProgram(source, (msg) => warnings.push(msg));
    
    // Should emit warning about missing property
    expect(warnings.some((w) => w.includes('missing'))).toBe(true);
    
    // Should NOT contain the invalid guard - check for the actual runtime guard code
    expect(output).not.toContain('!(config.missing.value > 0)');
    expect(output).not.toContain('ContractViolationError');
  });

  it('should keep valid contract at runtime (valid parameter property chain)', () => {
    const source = `
      /**
       * @pre config.value > 0
       */
      export function validParamChain(config: { value: number }): boolean {
        return config.value > 0;
      }
    `;

    const warnings: string[] = [];
    const output = transformWithProgram(source, (msg) => warnings.push(msg));
    
    // Should NOT emit warnings
    expect(warnings).toHaveLength(0);
    
    // Should contain the valid guard
    expect(output).toContain('config.value');
  });

  it('should drop invalid contract with deep property chain', () => {
    const source = `
      interface Level1 {
        level2: { value: number };
      }
      
      /**
       * @pre root.level1.missing.value > 0
       */
      export function invalidDeepChain(root: { level1: Level1 }): boolean {
        return root.level1.level2.value > 0;
      }
    `;

    const warnings: string[] = [];
    const output = transformWithProgram(source, (msg) => warnings.push(msg));
    
    // Should emit warning about missing property
    expect(warnings.some((w) => w.includes('missing'))).toBe(true);
    
    // Should NOT contain the invalid guard
    expect(output).not.toContain('!(root.level1.missing.value > 0)');
    expect(output).not.toContain('ContractViolationError');
  });
});
