import typescript from 'typescript';
import createTransformer from '@src/transformer';

type TransformOptions = {
  warn?: (msg: string) => void;
  keepContracts?: boolean | 'pre' | 'post' | 'invariant' | 'all';
};

export function transform(
  source: string,
  optionsOrWarn?: ((msg: string) => void) | TransformOptions,
): string {
  const options = typeof optionsOrWarn === 'function'
    ? { warn: optionsOrWarn }
    : optionsOrWarn;
  const result = typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2020,
      module: typescript.ModuleKind.CommonJS,
    },
    transformers: {
      before: [createTransformer(undefined, options)],
    },
  });
  return result.outputText;
}

export function transformWithProgram(source: string, warn?: (msg: string) => void): string {
  const fileName = 'virtual-test.ts';
  const compilerOptions: typescript.CompilerOptions = {
    target: typescript.ScriptTarget.ES2020,
    module: typescript.ModuleKind.CommonJS,
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

export function transpileWithWarn(source: string, warn: (msg: string) => void): string {
  return transform(source, warn);
}

export function transformES2022(
  source: string,
  optionsOrWarn?: ((msg: string) => void) | TransformOptions,
): string {
  const opts = typeof optionsOrWarn === 'function'
    ? { warn: optionsOrWarn }
    : optionsOrWarn;
  return typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2022,
      module: typescript.ModuleKind.CommonJS,
    },
    transformers: { before: [createTransformer(undefined, opts)] },
  }).outputText;
}
