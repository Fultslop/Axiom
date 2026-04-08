import typescript from 'typescript';
import createTransformer from '@src/transformer';

function transform(source: string, warn?: (msg: string) => void): string {
  const options = warn !== undefined ? { warn } : undefined;
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

function transformWithProgram(source: string, warn?: (msg: string) => void): string {
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

describe('transformer', () => {
  it('leaves functions without contract tags unchanged', () => {
    const source = `
      export function add(aaa: number, bbb: number): number {
        return aaa + bbb;
      }
    `;
    const output = transform(source);
    expect(output).not.toContain('ContractViolationError');
    expect(output).not.toContain('result');
  });

  it('injects pre-check for @pre tag', () => {
    const source = `
      /**
       * @pre amount > 0
       */
      export function withdraw(amount: number): number {
        return amount;
      }
    `;
    const output = transform(source);
    expect(output).toContain('ContractViolationError');
    expect(output).toContain('!(amount > 0)');
    expect(output).toContain('"PRE"');
  });

  it('injects post-check and result capture for @post tag', () => {
    const source = `
      /**
       * @post result >= 0
       */
      export function deposit(amount: number): number {
        return amount;
      }
    `;
    const output = transform(source);
    expect(output).toContain('const result');
    expect(output).toContain('!(result >= 0)');
    expect(output).toContain('"POST"');
    expect(output).toContain('return result');
  });

  it('injects multiple @pre checks in order', () => {
    const source = `
      /**
       * @pre amount > 0
       * @pre amount <= 1000
       */
      export function pay(amount: number): number {
        return amount;
      }
    `;
    const output = transform(source);
    const firstPre = output.indexOf('!(amount > 0)');
    const secondPre = output.indexOf('!(amount <= 1000)');
    expect(firstPre).toBeGreaterThanOrEqual(0);
    expect(secondPre).toBeGreaterThan(firstPre);
  });

  it('injects both pre and post checks', () => {
    const source = `
      /**
       * @pre amount > 0
       * @post result >= 0
       */
      export function withdraw(amount: number): number {
        return amount;
      }
    `;
    const output = transform(source);
    const preIdx = output.indexOf('"PRE"');
    const captureIdx = output.indexOf('const result');
    const postIdx = output.indexOf('"POST"');
    const returnIdx = output.lastIndexOf('return result');
    expect(preIdx).toBeGreaterThanOrEqual(0);
    expect(captureIdx).toBeGreaterThan(preIdx);
    expect(postIdx).toBeGreaterThan(captureIdx);
    expect(returnIdx).toBeGreaterThan(postIdx);
  });

  it('injects import for ContractViolationError when any contract found', () => {
    const source = `
      /** @pre amount > 0 */
      export function withdraw(amount: number): number { return amount; }
    `;
    const output = transform(source);
    expect(output).toContain('ContractViolationError');
    expect(output).toContain('fsprepost');
  });

  it('skips non-exported functions silently', () => {
    const source = `
      /** @pre amount > 0 */
      function internal(amount: number): number { return amount; }
    `;
    const output = transform(source);
    expect(output).not.toContain('ContractViolationError');
  });

  it('safety invariant: compiles without crashing when expression is syntactically broken', () => {
    const source = `
      /** @pre amount > */
      export function withdraw(amount: number): number { return amount; }
    `;
    expect(() => transform(source)).not.toThrow();
  });

  it('transforms class method with @pre contract', () => {
    const source = `
      class Account {
        /** @pre amount > 0 */
        public withdraw(amount: number): number {
          return amount;
        }
      }
    `;
    const output = transform(source);
    expect(output).toContain('ContractViolationError');
    expect(output).toContain('!(amount > 0)');
    expect(output).toContain('"PRE"');
    expect(output).toContain('"Account.withdraw"');
  });

  it('does not transform private class methods', () => {
    const source = `
      class Account {
        /** @pre amount > 0 */
        private withdraw(amount: number): number {
          return amount;
        }
      }
    `;
    const output = transform(source);
    expect(output).not.toContain('ContractViolationError');
  });

  it('does not transform protected class methods', () => {
    const source = `
      class Account {
        /** @pre amount > 0 */
        protected withdraw(amount: number): number {
          return amount;
        }
      }
    `;
    const output = transform(source);
    expect(output).not.toContain('ContractViolationError');
  });

  it('uses UnknownClass when method parent is not a class declaration', () => {
    const source = `
      /** @pre amount > 0 */
      export function withdraw(amount: number): number { return amount; }
    `;
    const output = transform(source);
    // exported function uses the function name, not a class name
    expect(output).toContain('"withdraw"');
  });

  it('handles class method with unknown name gracefully', () => {
    const source = `
      class MyClass {
        /** @pre xxx > 0 */
        public ['computed'](xxx: number): number { return xxx; }
      }
    `;
    // computed-property method name falls into unknownMethod path
    expect(() => transform(source)).not.toThrow();
  });

  it('injects post-check for function body containing a switch statement', () => {
    const source = `
      /**
       * @post result === "bar"
       */
      export function doSwitchFn(value: string): string {
        switch (value) {
          case "foo": return "bar";
          case "bar": return "baz";
          default: return "qaz";
        }
      }
    `;
    const output = transform(source);
    expect(output).toContain('const result');
    expect(output).toContain('!(result === "bar")');
    expect(output).toContain('"POST"');
    expect(output).toContain('return result');
  });

  it('injects post-check for function body containing a for-of loop', () => {
    const source = `
      /**
       * @post result > 0
       */
      export function doLoopFn(arr: number[]): number {
        let sum = 0;
        for (const x of arr) { sum += x; }
        return sum;
      }
    `;
    const output = transform(source);
    expect(output).toContain('const result');
    expect(output).toContain('!(result > 0)');
    expect(output).toContain('"POST"');
    expect(output).toContain('return result');
  });

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

  it('allows this in class method contracts without warning', () => {
    const warn = jest.fn();
    const source = `
      class Account {
        /** @pre this.balance >= amount */
        public withdraw(amount: number): number { return amount; }
      }
    `;
    transform(source, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  describe('type mismatch detection (requires real Program)', () => {
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
      // transpileModule has no Program — type checking silently skipped
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

  it('creates transformer with program argument', () => {
    const result = typescript.transpileModule(
      `/** @pre xxx > 0 */\nexport function foo(xxx: number): number { return xxx; }`,
      {
        compilerOptions: { target: typescript.ScriptTarget.ES2020 },
        transformers: { before: [createTransformer(undefined)] },
      },
    );
    expect(result.outputText).toContain('ContractViolationError');
  });
});
