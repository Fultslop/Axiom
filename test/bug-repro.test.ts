import createTransformer from '../src/transformer';
import typescript from 'typescript';

function fullProgramMode(source: string, warn?: (msg: string) => void): string {
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

describe('BUG FIX VERIFICATION: invalid property chain with TypeChecker', () => {
  it('should drop invalid contract when TypeChecker is available', () => {
    const source = `
      /**
       * @pre config.missing.value > 0
       */
      export function invalidParamChain(config: { value: number }): boolean {
        return config.value > 0;
      }
    `;

    const warnings: string[] = [];
    const output = fullProgramMode(source, (msg) => warnings.push(msg));
    
    console.log('=== OUTPUT ===');
    console.log(output);
    console.log('=== WARNINGS ===');
    console.log(warnings);
    
    // With TypeChecker, the invalid contract should be dropped
    const hasInvalidGuard = output.includes('config.missing.value') && 
                            output.includes('ContractViolationError');
    
    // This should PASS - no invalid guard should be present
    expect(hasInvalidGuard).toBe(false);
    expect(warnings.some(w => w.includes('missing'))).toBe(true);
  });
});
