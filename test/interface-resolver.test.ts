import typescript from 'typescript';
import {
  resolveInterfaceContracts,
  type ParamMismatchMode,
  type InterfaceContracts,
} from '@src/interface-resolver';

// Helper: build a single-file Program with TypeChecker
function buildProgram(fileName: string, source: string): typescript.Program {
  const options: typescript.CompilerOptions = {
    target: typescript.ScriptTarget.ES2020,
    module: typescript.ModuleKind.CommonJS,
    skipLibCheck: true,
  };
  const defaultHost = typescript.createCompilerHost(options);
  const host: typescript.CompilerHost = {
    ...defaultHost,
    getSourceFile(name, version) {
      if (name === fileName) {
        return typescript.createSourceFile(name, source, version, true);
      }
      return defaultHost.getSourceFile(name, version);
    },
    fileExists: (name) => name === fileName || defaultHost.fileExists(name),
    readFile: (name) => (name === fileName ? source : defaultHost.readFile(name)),
  };
  return typescript.createProgram([fileName], options, host);
}

// Helper: build a multi-file Program with TypeChecker
function buildMultiFileProgram(
  files: Record<string, string>,
): typescript.Program {
  const options: typescript.CompilerOptions = {
    target: typescript.ScriptTarget.ES2020,
    module: typescript.ModuleKind.CommonJS,
    skipLibCheck: true,
  };
  const defaultHost = typescript.createCompilerHost(options);
  const fileMap = new Map(Object.entries(files));

  function resolveFileName(name: string): string | undefined {
    const base = name.split(/[\\/]/).pop() ?? name;
    if (fileMap.has(base)) {
      return base;
    }
    if (fileMap.has(name)) {
      return name;
    }
    return undefined;
  }

  const host: typescript.CompilerHost = {
    ...defaultHost,
    getSourceFile(name, version) {
      const source = resolveFileName(name);
      if (source !== undefined) {
        const content = files[source]!;
        return typescript.createSourceFile(name, content, version, true);
      }
      return defaultHost.getSourceFile(name, version);
    },
    fileExists(name) {
      return resolveFileName(name) !== undefined || defaultHost.fileExists(name);
    },
    readFile(name) {
      const resolved = resolveFileName(name);
      if (resolved !== undefined) {
        return files[resolved];
      }
      return defaultHost.readFile(name);
    },
    resolveModuleNameLiterals(
      moduleLiterals,
      containingFile,
      _redirectedReference,
      _compilerOptions,
    ) {
      return moduleLiterals.map((moduleLiteral) => {
        const moduleName = moduleLiteral.text;
        // Handle relative imports like './iface' -> 'iface.ts'
        if (moduleName.startsWith('./')) {
          const baseName = moduleName.slice(2);
          const candidate = `${baseName}.ts`;
          if (fileMap.has(candidate)) {
            return {
              resolvedModule: {
                resolvedFileName: candidate,
                extension: '.ts',
                isExternalLibraryImport: false,
              },
            };
          }
        }
        return typescript.resolveModuleName(
          moduleName, containingFile, options,
          { fileExists: host.fileExists, readFile: host.readFile },
        );
      });
    },
  };
  return typescript.createProgram(Object.keys(files), options, host);
}

function getClassDecl(
  program: typescript.Program,
  fileName: string,
): typescript.ClassDeclaration {
  const sourceFile = program.getSourceFile(fileName)!;
  const decl = sourceFile.statements.find(typescript.isClassDeclaration);
  if (decl === undefined) throw new Error(`No class found in ${fileName}`);
  return decl;
}

function runResolver(
  program: typescript.Program,
  fileName: string,
  mode: ParamMismatchMode = 'rename',
): { contracts: InterfaceContracts; warnings: string[] } {
  const checker = program.getTypeChecker();
  const classDecl = getClassDecl(program, fileName);
  const cache = new Map<string, typescript.SourceFile>();
  const warnings: string[] = [];
  const contracts = resolveInterfaceContracts(
    classDecl, checker, cache, (msg) => warnings.push(msg), mode,
  );
  return { contracts, warnings };
}

describe('resolveInterfaceContracts — basic extraction', () => {
  it('returns empty contracts when class has no implements clause', () => {
    const program = buildProgram('test.ts', `
      class Foo { bar(amount: number): void {} }
    `);
    const { contracts, warnings } = runResolver(program, 'test.ts');
    expect(contracts.methods.size).toBe(0);
    expect(contracts.invariants).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('extracts @pre tags from a same-file interface', () => {
    const program = buildProgram('test.ts', `
      interface IFoo {
        /** @pre amount > 0 */
        bar(amount: number): number;
      }
      class Foo implements IFoo {
        bar(amount: number): number { return amount; }
      }
    `);
    const { contracts, warnings } = runResolver(program, 'test.ts');
    expect(contracts.methods.get('bar')?.preTags).toHaveLength(1);
    const preTag = contracts.methods.get('bar')!.preTags[0]!;
    expect(preTag.expression).toBe('amount > 0');
    expect(warnings).toHaveLength(0);
  });

  it('extracts @post tags from a same-file interface', () => {
    const program = buildProgram('test.ts', `
      interface IFoo {
        /** @post result > 0 */
        bar(amount: number): number;
      }
      class Foo implements IFoo {
        bar(amount: number): number { return amount; }
      }
    `);
    const { contracts } = runResolver(program, 'test.ts');
    expect(contracts.methods.get('bar')?.postTags).toHaveLength(1);
    const postTag = contracts.methods.get('bar')!.postTags[0]!;
    expect(postTag.expression).toBe('result > 0');
  });

  it('extracts @invariant expressions from a same-file interface', () => {
    const program = buildProgram('test.ts', `
      /** @invariant this.balance >= 0 */
      interface IFoo {
        bar(): void;
      }
      class Foo implements IFoo {
        balance = 0;
        bar(): void {}
      }
    `);
    const { contracts } = runResolver(program, 'test.ts');
    expect(contracts.invariants).toContain('this.balance >= 0');
  });
});

describe('resolveInterfaceContracts — parameter name mismatch', () => {
  it('renames expression identifiers when param names differ (rename mode)', () => {
    const program = buildProgram('test.ts', `
      interface IFoo {
        /** @pre amount > 0 */
        bar(amount: number): number;
      }
      class Foo implements IFoo {
        bar(value: number): number { return value; }
      }
    `);
    const { contracts, warnings } = runResolver(program, 'test.ts', 'rename');
    expect(contracts.methods.get('bar')?.preTags).toHaveLength(1);
    const renamedPre = contracts.methods.get('bar')!.preTags[0]!;
    expect(renamedPre.expression).toBe('value > 0');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('renamed');
  });

  it('drops method contracts when param names differ (ignore mode)', () => {
    const program = buildProgram('test.ts', `
      interface IFoo {
        /** @pre amount > 0 */
        bar(amount: number): number;
      }
      class Foo implements IFoo {
        bar(value: number): number { return value; }
      }
    `);
    const { contracts, warnings } = runResolver(program, 'test.ts', 'ignore');
    expect(contracts.methods.get('bar')?.preTags).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('skipped');
  });

  it('skips all interface contracts for method when param counts differ', () => {
    const program = buildProgram('test.ts', `
      interface IFoo {
        /** @pre amount > 0 */
        bar(amount: number, extra: number): number;
      }
      class Foo implements IFoo {
        bar(amount: number): number { return amount; }
      }
    `);
    const { contracts, warnings } = runResolver(program, 'test.ts');
    expect(contracts.methods.get('bar')?.preTags).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Parameter count mismatch');
  });
});

describe('resolveInterfaceContracts — cross-file', () => {
  it('extracts @pre tags from an interface in a separate file', () => {
    const program = buildMultiFileProgram({
      'iface.ts': `
        export interface IBankAccount {
          /** @pre amount > 0 */
          withdraw(amount: number): number;
        }
      `,
      'bank.ts': `
        import type { IBankAccount } from './iface';
        class BankAccount implements IBankAccount {
          withdraw(amount: number): number { return 0; }
        }
      `,
    });
    const { contracts, warnings } = runResolver(program, 'bank.ts');
    expect(contracts.methods.get('withdraw')?.preTags).toHaveLength(1);
    const crossPre = contracts.methods.get('withdraw')!.preTags[0]!;
    expect(crossPre.expression).toBe('amount > 0');
    expect(warnings).toHaveLength(0);
  });
});
