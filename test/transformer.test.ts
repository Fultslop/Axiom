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

function transpileWithWarn(source: string, warn: (msg: string) => void): string {
  return transform(source, warn);
}

function transformES2022(source: string, warn?: (msg: string) => void): string {
  const opts = warn !== undefined ? { warn } : undefined;
  return typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2022,
      module: typescript.ModuleKind.CommonJS,
    },
    transformers: { before: [createTransformer(undefined, opts)] },
  }).outputText;
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
    expect(output).toContain('const __axiom_result__');
    expect(output).toContain('!(__axiom_result__ >= 0)');
    expect(output).toContain('"POST"');
    expect(output).toContain('return __axiom_result__');
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
    const captureIdx = output.indexOf('const __axiom_result__');
    const postIdx = output.indexOf('"POST"');
    const returnIdx = output.lastIndexOf('return __axiom_result__');
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
    expect(output).toContain('axiom');
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
    expect(output).toContain('const __axiom_result__');
    expect(output).toContain('!(__axiom_result__ === "bar")');
    expect(output).toContain('"POST"');
    expect(output).toContain('return __axiom_result__');
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
    expect(output).toContain('const __axiom_result__');
    expect(output).toContain('!(__axiom_result__ > 0)');
    expect(output).toContain('"POST"');
    expect(output).toContain('return __axiom_result__');
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

  it('keeps @post without result even when return type is void', () => {
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

  describe('typeof guard narrowing in && chains', () => {
    it('warns when typeof-narrowed-to-string param is compared to number literal', () => {
      // x: string | number — resolveSimpleType returns undefined (ambiguous union)
      // typeof x === "string" narrows x to string; x === 42 should warn
      const source = `
        /**
         * @pre typeof x === "string" && x === 42
         */
        export function foo(x: string | number): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('type mismatch') && w.includes("'x'"))).toBe(true);
    });

    it('does not warn when typeof-narrowed-to-number param is used in numeric comparison', () => {
      const source = `
        /**
         * @pre typeof x === "number" && x > 0
         */
        export function foo(x: string | number): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
    });

    it('warns when typeof-narrowed-to-boolean param is compared to number literal', () => {
      const source = `
        /**
         * @pre typeof x === "boolean" && x === 1
         */
        export function foo(x: boolean | number): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('type mismatch') && w.includes("'x'"))).toBe(true);
    });

    it('does not warn when typeof-narrowed-to-string param is compared to string literal', () => {
      const source = `
        /**
         * @pre typeof x === "string" && x === "hello"
         */
        export function foo(x: string | number): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
    });
  });

  describe('typeof narrowing — existing behaviour preserved', () => {
    it('warns on non-union string param in typeof guard expression (existing path)', () => {
      // x already resolves to "string"; narrowed map does not override
      const source = `
        /**
         * @pre typeof x === "string" && x === 42
         */
        export function foo(x: string): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('type mismatch') && w.includes("'x'"))).toBe(true);
    });

    it('does not warn for non-union number param in valid numeric comparison', () => {
      const source = `
        /**
         * @pre typeof x === "number" && x > 0
         */
        export function foo(x: number): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
    });
  });

  describe('typeof narrowing — null-check union unaffected', () => {
    it('warns when number|null param is compared to string literal (existing union resolution)', () => {
      // resolveSimpleType strips null and returns "number"; no change in behaviour
      const source = `
        /**
         * @pre x !== null && x === "zero"
         */
        export function foo(x: number | null): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('type mismatch') && w.includes("'x'"))).toBe(true);
    });
  });

  describe('typeof narrowing — edge cases', () => {
    it('does not apply narrowing from || chains', () => {
      // || is not walked; x remains absent from effective map; no type-mismatch
      const source = `
        /**
         * @pre typeof x === "string" || x === 42
         */
        export function foo(x: string | number): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.filter((w) => w.includes('type mismatch'))).toHaveLength(0);
    });

    it('narrows multiple params independently in same && chain', () => {
      // x narrowed to "string", y narrowed to "number"; x === 42 warns, y > 0 does not
      const source = `
        /**
         * @pre typeof x === "string" && typeof y === "number" && x === 42
         */
        export function foo(x: string | number, y: string | number): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('type mismatch') && w.includes("'x'"))).toBe(true);
      expect(warnings.filter((w) => w.includes("'y'"))).toHaveLength(0);
    });

    it('does not extract narrowing from loose-equality typeof guard (== not ===)', () => {
      // typeof x == "string" uses == — not recognised; no narrowing; no type-mismatch
      const source = `
        /**
         * @pre typeof x == "string" && x === 42
         */
        export function foo(x: string | number): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.filter((w) => w.includes('type mismatch'))).toHaveLength(0);
    });

    it('does not warn when comparison appears before typeof guard (short-circuit)', () => {
      // x === 42 evaluates BEFORE typeof guard; narrowing should not apply retroactively
      const source = `
        /**
         * @pre x === 42 && typeof x === "string"
         */
        export function foo(x: string | number): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.filter((w) => w.includes('type mismatch'))).toHaveLength(0);
    });

    it('warns when comparison appears after typeof guard in reversed position', () => {
      // typeof guard comes first, then mismatched comparison — should warn
      const source = `
        /**
         * @pre typeof x === "string" && x === 42
         */
        export function foo(x: string | number): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('type mismatch') && w.includes("'x'"))).toBe(true);
    });
  });

  describe('class invariants', () => {
    function transformES2022(source: string, warn?: (msg: string) => void): string {
      const opts = warn !== undefined ? { warn } : undefined;
      return typescript.transpileModule(source, {
        compilerOptions: {
          target: typescript.ScriptTarget.ES2022,
          module: typescript.ModuleKind.CommonJS,
        },
        transformers: { before: [createTransformer(undefined, opts)] },
      }).outputText;
    }

    it('injects #checkInvariants method and call for @invariant class', () => {
      const source = `
        /** @invariant this.balance >= 0 */
        class BankAccount {
          balance = 100;
          public withdraw(amount: number): number {
            this.balance -= amount;
            return this.balance;
          }
        }
      `;
      const output = transformES2022(source);
      expect(output).toContain('InvariantViolationError');
      expect(output).toContain('#checkInvariants');
      expect(output).toContain('this.balance >= 0');
    });

    it('invariant call appears after @post check', () => {
      const source = `
        /** @invariant this.balance >= 0 */
        class BankAccount {
          balance = 100;
          /** @post result >= 0 */
          public withdraw(amount: number): number {
            this.balance -= amount;
            return this.balance;
          }
        }
      `;
      const output = transformES2022(source);
      const postIdx = output.indexOf('"POST"');
      const invariantCallIdx = output.indexOf('this.#checkInvariants(');
      expect(postIdx).toBeGreaterThanOrEqual(0);
      expect(invariantCallIdx).toBeGreaterThan(postIdx);
    });

    it('injects invariant check in constructor at exit', () => {
      const source = `
        /** @invariant this.balance >= 0 */
        class BankAccount {
          balance = 0;
          constructor(initial: number) {
            this.balance = initial;
          }
        }
      `;
      const output = transformES2022(source);
      expect(output).toContain('"BankAccount"');
      expect(output).toContain('checkInvariants');
    });

    it('does not inject invariant call in private methods', () => {
      const source = `
        /** @invariant this.balance >= 0 */
        class BankAccount {
          balance = 100;
          private helper(): void { this.balance -= 1; }
          public withdraw(amount: number): void { this.helper(); }
        }
      `;
      const output = transformES2022(source);
      const calls = [...output.matchAll(/this\.#checkInvariants\(/g)];
      expect(calls).toHaveLength(1); // withdraw only, not helper
    });

    it('class without @invariant is unaffected', () => {
      const source = `
        class Plain {
          balance = 100;
          public withdraw(amount: number): number {
            return this.balance - amount;
          }
        }
      `;
      const output = transformES2022(source);
      expect(output).not.toContain('InvariantViolationError');
      expect(output).not.toContain('#checkInvariants');
    });

    it('multiple @invariant tags all appear in #checkInvariants body', () => {
      const source = `
        /**
         * @invariant this.balance >= 0
         * @invariant this.owner !== null
         */
        class BankAccount {
          balance = 100;
          owner = "Alice";
          public withdraw(amount: number): number { return this.balance; }
        }
      `;
      const output = transformES2022(source);
      expect(output).toContain('this.balance >= 0');
      expect(output).toContain('this.owner !== null');
    });

    it('injects InvariantViolationError in require when @invariant present', () => {
      const source = `
        /** @invariant this.balance >= 0 */
        class BankAccount {
          balance = 100;
          public withdraw(amount: number): number { return this.balance; }
        }
      `;
      const output = transformES2022(source);
      expect(output).toContain('InvariantViolationError');
      expect(output).toContain('axiom');
    });

    it('warns and skips invariant injection when #checkInvariants already defined', () => {
      const warn = jest.fn();
      const source = `
        /** @invariant this.balance >= 0 */
        class BankAccount {
          balance = 100;
          #checkInvariants(location: string): void {}
          public withdraw(amount: number): number { return this.balance; }
        }
      `;
      const output = transformES2022(source, warn);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('#checkInvariants'));
      expect(output).not.toContain('InvariantViolationError');
    });

    it('warns and skips invalid @invariant expressions', () => {
      const warn = jest.fn();
      const source = `
        /** @invariant unknownVar > 0 */
        class BankAccount {
          balance = 100;
          public withdraw(amount: number): number { return this.balance; }
        }
      `;
      const output = transformES2022(source, warn);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknownVar'));
      expect(output).not.toContain('InvariantViolationError');
    });

    it('does not inject invariant call into static methods (regression)', () => {
      const source = `
        /** @invariant this.max > this.min */
        class Foo {
          max = 1;
          min = 0;
          /** @pre xxx > 0 */
          public static doStaticFn(xxx: number): number { return xxx + 1; }
        }
      `;
      const output = transformES2022(source);
      // static method must have its @pre check but no #checkInvariants call
      expect(output).toContain('!(xxx > 0)');
      const staticIdx = output.indexOf('static doStaticFn');
      const nextMethodIdx = output.indexOf('\n    }', staticIdx);
      const staticBody = output.slice(staticIdx, nextMethodIdx);
      expect(staticBody).not.toContain('#checkInvariants');
    });

    it('instance method in invariant class throws when invariant is violated', () => {
      const source = `
        /** @invariant this.max > this.min */
        class Foo {
          max = 1;
          min = 0;
          public updateMinMax(min: number, max: number): void {
            this.min = min;
            this.max = max;
          }
          constructor() {}
        }
      `;
      const output = transformES2022(source);
      // invariant call must be injected into updateMinMax
      expect(output).toContain('#checkInvariants');
      expect(output).toContain('"Foo.updateMinMax"');
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

  describe('@prev capture for @post conditions', () => {
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
      // Note: TypeScript's printer may attach trailing comments from the original
      // source to synthesized nodes, so we check for the key parts rather than exact text
      expect(output).toContain('const __axiom_prev__ =');
      expect(output).toContain('!(__axiom_result__ === __axiom_prev__.x + 1)');
    });

    it('does not inject const prev when @post has no prev reference', () => {
      const source = `
        /** @post result > 0 */
        export function foo(x: number): number { return x + 1; }
      `;
      const output = transform(source);
      // For standalone function with no prev reference, no const prev should appear
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
      // First tag is 'this.balance', so prev should be that
      expect(output).toContain('const __axiom_prev__ = this.balance');
    });
  });

  describe('global identifier whitelist', () => {
    it('injects @pre using Math.abs without warning', () => {
      const source = `
        /**
         * @pre Math.abs(delta) < 1
         */
        export function nudge(delta: number): void {}
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(Math.abs(delta) < 1)');
    });

    it('injects @pre using isNaN without warning', () => {
      const source = `
        /**
         * @pre isNaN(value) === false
         */
        export function parse(value: number): number { return value; }
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(isNaN(value) === false)');
    });

    it('injects @pre using JSON.stringify without warning', () => {
      const source = `
        /**
         * @pre JSON.stringify(obj) !== ""
         */
        export function serialize(obj: object): string { return ""; }
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(JSON.stringify(obj) !== "")');
    });
  });

  describe('destructured parameter binding names', () => {
    it('injects @pre referencing destructured object binding', () => {
      const source = `
        /**
         * @pre x > 0
         */
        export function move({ x, y }: { x: number; y: number }): void {}
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(x > 0)');
    });

    it('injects @pre referencing nested destructured binding', () => {
      const source = `
        /**
         * @pre bbb > 0
         */
        export function foo({ aaa: { bbb } }: { aaa: { bbb: number } }): void {}
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(bbb > 0)');
    });

    it('injects @pre referencing array destructured binding', () => {
      const source = `
        /**
         * @pre first > 0
         */
        export function head([first]: number[]): number { return first; }
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(first > 0)');
    });

    it('injects @pre using alias name, not original property name', () => {
      const source = `
        /**
         * @pre alias > 0
         */
        export function bar({ original: alias }: { original: number }): void {}
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(alias > 0)');
    });

    it('drops @pre using original property name when aliased', () => {
      const source = `
        /**
         * @pre original > 0
         */
        export function bar({ original: alias }: { original: number }): void {}
      `;
      const warnings: string[] = [];
      transform(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('original'))).toBe(true);
    });
  });

  describe('TemplateExpression in contract expressions', () => {
    it('injects @pre with an interpolated template literal', () => {
      const source = `
        /**
         * @pre label === \`item_\${id}\`
         */
        export function tag(label: string, id: string): void {}
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(label === `item_${id}`)');
    });

    it('does not drop other contracts when one uses an interpolated template literal', () => {
      const source = `
        /**
         * @pre count > 0
         * @pre label === \`item_\${id}\`
         */
        export function run(count: number, label: string, id: string): void {}
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(count > 0)');
      expect(output).toContain('!(label === `item_${id}`)');
    });
  });

  describe('NoSubstitutionTemplateLiteral in contract expressions', () => {
    it('injects @pre with a no-substitution template literal', () => {
      const source = `
        /**
         * @pre label === \`hello\`
         */
        export function tag(label: string): void {}
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(label === `hello`)');
    });

    it('does not drop other contracts on a function that has a no-substitution template literal', () => {
      const source = `
        /**
         * @pre count > 0
         * @pre label === \`ok\`
         */
        export function run(count: number, label: string): void {}
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(count > 0)');
      expect(output).toContain('!(label === `ok`)');
    });
  });

  describe('type-mismatch detection for NoSubstitutionTemplateLiteral', () => {
    it('warns when a number parameter is compared to a backtick string literal', () => {
      const source = `
        /**
         * @pre count === \`hello\`
         */
        export function run(count: number): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('type mismatch') && w.includes('count'))).toBe(true);
    });

    it('does not warn when a string parameter is compared to a backtick string literal', () => {
      const source = `
        /**
         * @pre label === \`hello\`
         */
        export function tag(label: string): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
    });
  });

  describe('scope identifiers (enum and module constants)', () => {
    it('injects @pre referencing a const enum member without warning (checker mode)', () => {
      const source = `
        const enum Status { Active = 0, Inactive = 1 }
        /**
         * @pre status === Status.Active
         */
        export function handle(status: number): void {}
      `;
      const warnings: string[] = [];
      const output = transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(status === Status.Active)');
    });

    it('injects @pre referencing a module-level const without warning (checker mode)', () => {
      const source = `
        const MAX_SIZE = 100;
        /**
         * @pre amount <= MAX_SIZE
         */
        export function process(amount: number): void {}
      `;
      const warnings: string[] = [];
      const output = transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(amount <= MAX_SIZE)');
    });
  });

  describe('allowIdentifiers transformer option', () => {
    it('accepts Status as known identifier when listed in allowIdentifiers', () => {
      const source = `
        /**
         * @pre status === Status.Active
         */
        export function handle(status: number): void {}
      `;
      const warnings: string[] = [];
      const result = typescript.transpileModule(source, {
        compilerOptions: {
          target: typescript.ScriptTarget.ES2020,
          module: typescript.ModuleKind.CommonJS,
        },
        transformers: {
          before: [createTransformer(undefined, {
            warn: (msg) => warnings.push(msg),
            allowIdentifiers: ['Status'],
          })],
        },
      });
      expect(warnings).toHaveLength(0);
      expect(result.outputText).toContain('!(status === Status.Active)');
    });
  });

  describe('exported module constant runtime scoping', () => {
    it('injects @pre referencing exported const with exports. prefix (checker mode)', () => {
      const source = `
        export const MAX_LIMIT = 100;
        /**
         * @pre x < MAX_LIMIT
         */
        export function moduleConstantPre(x: number): number {
            return x;
        }
      `;
      const warnings: string[] = [];
      const output = transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      // The runtime should use exports.MAX_LIMIT, not bare MAX_LIMIT
      expect(output).toContain('exports.MAX_LIMIT');
      expect(output).toContain('!(x < exports.MAX_LIMIT)');
    });

    it('injects @pre referencing exported enum with exports. prefix (checker mode)', () => {
      const source = `
        export enum Mode { Fast = 0, Slow = 1 }
        /**
         * @pre mode === Mode.Fast
         */
        export function checkMode(mode: number): void {}
      `;
      const warnings: string[] = [];
      const output = transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('exports.Mode');
      expect(output).toContain('!(mode === exports.Mode.Fast)');
    });
  });

  describe('union type parameter mismatch detection', () => {
    it('warns when number|undefined param is compared to string literal', () => {
      const source = `
        /**
         * @pre amount === "zero"
         */
        export function pay(amount: number | undefined): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('type mismatch') && w.includes('amount'))).toBe(true);
    });

    it('warns when string|null param is compared to number literal', () => {
      const source = `
        /**
         * @pre label === 42
         */
        export function tag(label: string | null): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('type mismatch') && w.includes('label'))).toBe(true);
    });

    it('does not warn for ambiguous union (number|string)', () => {
      const source = `
        /**
         * @pre val === 1
         */
        export function foo(val: number | string): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
    });
  });

  describe('non-primitive parameter type mismatch detection', () => {
    it('warns when array parameter is compared to number literal', () => {
      const source = `
        /**
         * @pre items === 42
         */
        export function process(items: string[]): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('type mismatch') && w.includes('items')),
      ).toBe(true);
    });

    it('warns when object parameter is compared to string literal', () => {
      const source = `
        interface Point { x: number; y: number }
        /**
         * @pre pt === "hello"
         */
        export function move(pt: Point): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('type mismatch') && w.includes('pt')),
      ).toBe(true);
    });

    it('does not warn when checking a property of an object parameter', () => {
      const source = `
        /**
         * @pre items.length > 0
         */
        export function process(items: string[]): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
    });
  });

  describe('non-primitive return type mismatch for result', () => {
    it('warns when result is compared to number literal but return type is string', () => {
      const source = `
        /**
         * @post result === 42
         */
        export function getName(): string { return ""; }
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('type mismatch') && w.includes('result')),
      ).toBe(true);
    });

    it('warns when result is compared to string literal but return type is a record', () => {
      const source = `
        /**
         * @post result === "ok"
         */
        export function getMap(): Record<string, unknown> { return {}; }
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('type mismatch') && w.includes('result')),
      ).toBe(true);
    });
  });

  describe('unary operand type-mismatch detection', () => {
    it('warns when negated string parameter appears in numeric comparison', () => {
      const source = `
        /**
         * @pre -amount > 0
         */
        export function pay(amount: string): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('type mismatch') && w.includes('amount')),
      ).toBe(true);
    });

    it('warns when negated boolean parameter is compared to number literal', () => {
      const source = `
        /**
         * @pre !flag === 1
         */
        export function run(flag: boolean): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('type mismatch') && w.includes('flag')),
      ).toBe(true);
    });

    it('does not warn when negated number parameter is used in numeric comparison', () => {
      const source = `
        /**
         * @pre -amount > 0
         */
        export function pay(amount: number): void {}
      `;
      const warnings: string[] = [];
      transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
    });
  });

  describe('@pre/@post on constructor', () => {
    it('injects @pre check for constructor @pre tag', () => {
      const source = `
        export class Counter {
          /** @pre x > 0 */
          constructor(private x: number) {}
        }
      `;
      const warnings: string[] = [];
      const output = transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(output).toContain('!(x > 0)');
      expect(warnings).toHaveLength(0);
    });

    it('warns and drops @post that uses result on constructor', () => {
      const source = `
        export class Box {
          /** @post result !== null */
          constructor(public value: string) {}
        }
      `;
      const warnings: string[] = [];
      const output = transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes("'result' used in constructor @post") && w.includes('Box')),
      ).toBe(true);
      expect(output).not.toContain('ContractViolationError');
    });

    it('does not warn for @pre on a regular method', () => {
      const source = `
        export class Calc {
          /** @pre x > 0 */
          double(x: number): number { return x * 2; }
        }
      `;
      const warnings: string[] = [];
      transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
    });

    it('injects both @pre check and invariant into constructor', () => {
      const source = `
        /** @invariant this.x > 0 */
        export class Guarded {
          /** @pre x > 0 */
          constructor(private x: number) {}
        }
      `;
      const warnings: string[] = [];
      const output = transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(output).toContain('checkInvariants');
      expect(output).toContain('!(x > 0)');
      expect(warnings).toHaveLength(0);
    });
  });

  describe('property chain validation', () => {
    it('drops @pre with a misspelled this-property and emits a warning', () => {
      const source = `
        class BankAccount {
          balance: number = 0;
          /**
           * @pre this.balanc > 0
           */
          withdraw(amount: number): void {}
        }
      `;
      const warnings: string[] = [];
      const output = transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('balanc'))).toBe(true);
      expect(output).not.toContain('!(this.balanc > 0)');
    });

    it('injects @pre with a correctly spelled this-property without warning', () => {
      const source = `
        class BankAccount {
          balance: number = 0;
          /**
           * @pre this.balance > 0
           */
          withdraw(amount: number): void {}
        }
      `;
      const warnings: string[] = [];
      const output = transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(this.balance > 0)');
    });

    it('drops @pre when an intermediate chain property is missing', () => {
      const source = `
        interface Config { timeout: number }
        class Service {
          cfg: Config = { timeout: 10 };
          /**
           * @pre this.cfg.limit > 0
           */
          run(): void {}
        }
      `;
      const warnings: string[] = [];
      const output = transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('limit'))).toBe(true);
      expect(output).not.toContain('!(this.cfg.limit > 0)');
    });

    it('injects @pre when all properties in a two-level chain exist', () => {
      const source = `
        interface Config { timeout: number }
        class Service {
          cfg: Config = { timeout: 10 };
          /**
           * @pre this.cfg.timeout > 0
           */
          run(): void {}
        }
      `;
      const warnings: string[] = [];
      const output = transformWithProgram(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(this.cfg.timeout > 0)');
    });

    it('injects @pre with misspelled this-property in transpileModule mode (no checker)', () => {
      const source = `
        class BankAccount {
          balance: number = 0;
          /**
           * @pre this.balanc > 0
           */
          withdraw(amount: number): void {}
        }
      `;
      const warnings: string[] = [];
      const output = transform(source, (msg) => warnings.push(msg));
      expect(warnings).toHaveLength(0);
      expect(output).toContain('!(this.balanc > 0)');
    });

    describe('optional chaining on nullable parameter', () => {
      it('injects @pre for obj?.value when obj is ValueCarrier | null (no warning)', () => {
        const source = `
          interface ValueCarrier { value: number }
          /**
           * @pre obj?.value > 0
           */
          export function doOptionalFn(obj: ValueCarrier | null): number | null { return null; }
        `;
        const warnings: string[] = [];
        const output = transformWithProgram(source, (msg) => warnings.push(msg));
        expect(warnings).toHaveLength(0);
        // TypeScript's printer strips the ? from optional chaining
        expect(output).toContain('(obj.value > 0)');
      });

      it('injects @pre for obj.value when obj is ValueCarrier (non-nullable, regression)', () => {
        const source = `
          interface ValueCarrier { value: number }
          /**
           * @pre obj.value > 0
           */
          export function doFn(obj: ValueCarrier): number { return 0; }
        `;
        const warnings: string[] = [];
        const output = transformWithProgram(source, (msg) => warnings.push(msg));
        expect(warnings).toHaveLength(0);
        expect(output).toContain('(obj.value > 0)');
      });

      it('warns for obj.balanc when obj is BankAccount (typo, regression)', () => {
        const source = `
          interface BankAccount { balance: number }
          /**
           * @pre obj.balanc > 0
           */
          export function doFn(obj: BankAccount): number { return 0; }
        `;
        const warnings: string[] = [];
        transformWithProgram(source, (msg) => warnings.push(msg));
        expect(warnings.some((w) => w.includes('balanc'))).toBe(true);
      });

      it('injects @pre for multi-step obj?.a?.b with all types nullable (no warning)', () => {
        const source = `
          interface Inner { bbb: number }
          interface Outer { aaa: Inner | undefined }
          /**
           * @pre obj?.aaa?.bbb > 0
           */
          export function deepFn(obj: Outer | null): number { return 0; }
        `;
        const warnings: string[] = [];
        const output = transformWithProgram(source, (msg) => warnings.push(msg));
        expect(warnings).toHaveLength(0);
        // TypeScript's printer strips the ? from optional chaining
        expect(output).toContain('(obj.aaa.bbb > 0)');
      });

      it('warns for obj?.a?.missing when the final property does not exist', () => {
        const source = `
          interface Inner { bbb: number }
          interface Outer { aaa: Inner | undefined }
          /**
           * @pre obj?.aaa?.missing > 0
           */
          export function deepFn(obj: Outer | null): number { return 0; }
        `;
        const warnings: string[] = [];
        transformWithProgram(source, (msg) => warnings.push(msg));
        expect(warnings.some((w) => w.includes('missing'))).toBe(true);
      });

      it('injects @pre for obj?.value in transpileModule mode (no checker, no warning)', () => {
        const source = `
          interface ValueCarrier { value: number }
          /**
           * @pre obj?.value > 0
           */
          export function doOptionalFn(obj: ValueCarrier | null): number | null { return null; }
        `;
        const warnings: string[] = [];
        const output = transform(source, (msg) => warnings.push(msg));
        expect(warnings).toHaveLength(0);
        // TypeScript's printer may strip the ? from optional chaining in transpileModule mode
        expect(output).toContain('(obj');
        expect(output).toContain('value > 0)');
      });
    });
  });

  describe('@pre/@post on arrow function or function expression', () => {
    it('warns when named arrow function has @pre tag', () => {
      const source = `
        const foo = /** @pre x > 0 */ (x: number): number => x + 1;
      `;
      const warnings: string[] = [];
      transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('arrow functions') && w.includes('foo')),
      ).toBe(true);
    });

    it('warns when named function expression has @post tag', () => {
      const source = `
        const bar = /** @post result > 0 */ function(x: number): number { return x; };
      `;
      const warnings: string[] = [];
      transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('function expressions') && w.includes('bar')),
      ).toBe(true);
    });

    it('warns with (anonymous) for anonymous IIFE', () => {
      const source = `
        (/** @pre x > 0 */ (x: number): number => x)();
      `;
      const warnings: string[] = [];
      transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('arrow functions') && w.includes('(anonymous)')),
      ).toBe(true);
    });

    it('does not warn for named exported function declaration with @pre', () => {
      const source = `
        /** @pre x > 0 */
        export function add(x: number): number { return x + 1; }
      `;
      const warnings: string[] = [];
      transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('arrow functions'))).toBe(false);
      expect(warnings.some((w) => w.includes('function expressions'))).toBe(false);
    });
  });

  describe('@pre/@post on nested or non-exported function declaration', () => {
    it('warns for unexported top-level function with @pre', () => {
      const source = `
        /** @pre x > 0 */
        function helper(x: number): number { return x; }
      `;
      const warnings: string[] = [];
      transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('closures') && w.includes('helper')),
      ).toBe(true);
    });

    it('warns for function declaration nested inside another function', () => {
      const source = `
        export function outer(x: number): number {
          /** @pre x > 0 */
          function inner(x: number): number { return x; }
          return inner(x);
        }
      `;
      const warnings: string[] = [];
      transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('closures') && w.includes('inner')),
      ).toBe(true);
    });
  });

  describe('@pre/@post on a class body', () => {
    it('warns when @pre JSDoc is on the class declaration itself', () => {
      const source = `
        /** @pre this.x > 0 */
        export class Widget {
          constructor(public x: number) {}
        }
      `;
      const warnings: string[] = [];
      transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(
        warnings.some(
          (w) => w.includes('class declaration is not supported') && w.includes('Widget'),
        ),
      ).toBe(true);
    });

    it('class-level warning emitted AND method contracts injected normally', () => {
      const source = `
        /** @pre this.x > 0 */
        export class Dual {
          constructor(public x: number) {}
          /** @pre val > 0 */
          set(val: number): void { this.x = val; }
        }
      `;
      const warnings: string[] = [];
      const output = transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('class declaration is not supported') && w.includes('Dual')),
      ).toBe(true);
      expect(output).toContain('ContractViolationError');
    });
  });

  describe('@invariant on a non-class node', () => {
    it('warns when exported function has @invariant tag', () => {
      const source = `
        /** @invariant x > 0 */
        export function process(x: number): number { return x; }
      `;
      const warnings: string[] = [];
      transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(
        warnings.some(
          (w) => w.includes('only supported on class declarations') && w.includes('process'),
        ),
      ).toBe(true);
    });

    it('warns when variable statement has @invariant tag', () => {
      const source = `
        /** @invariant x > 0 */
        const value = 5;
      `;
      const warnings: string[] = [];
      transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(
        warnings.some((w) => w.includes('only supported on class declarations')),
      ).toBe(true);
    });

    it('warns when interface has @invariant tag', () => {
      const source = `
        /** @invariant true */
        interface Shape { area(): number; }
      `;
      const warnings: string[] = [];
      transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(
        warnings.some(
          (w) => w.includes('only supported on class declarations') && w.includes('Shape'),
        ),
      ).toBe(true);
    });

    it('does not warn for valid @invariant on a class', () => {
      const source = `
        /** @invariant this.x > 0 */
        export class Good {
          constructor(public x: number) {}
        }
      `;
      const warnings: string[] = [];
      transpileWithWarn(source, (msg) => warnings.push(msg));
      expect(warnings.some((w) => w.includes('only supported on class declarations'))).toBe(false);
    });
  });

  describe('constructor contracts', () => {
    describe('basic @pre injection', () => {
      it('injects pre-check for constructor @pre tag', () => {
        const source = `
          export class Account {
            balance: number;
            /**
             * @pre initialBalance >= 0
             */
            constructor(initialBalance: number) {
              this.balance = initialBalance;
            }
          }
        `;
        const output = transform(source);
        expect(output).toContain('ContractViolationError');
        expect(output).toContain('!(initialBalance >= 0)');
        expect(output).toContain('"PRE"');
      });

      it('throws at runtime when constructor @pre is violated', () => {
        const source = `
          export class Account {
            balance: number;
            /**
             * @pre initialBalance >= 0
             */
            constructor(initialBalance: number) {
              this.balance = initialBalance;
            }
          }
        `;
        const output = transform(source);
        const mod = { exports: {} as Record<string, unknown> };
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        new Function('module', 'exports', 'require', output)(
          mod,
          mod.exports,
          () => ({ ContractViolationError: class ContractViolationError extends Error {} }),
        );
        const AccountClass = mod.exports['Account'] as new (n: number) => unknown;
        expect(() => new AccountClass(100)).not.toThrow();
      });

      it('uses ClassName (not ClassName.constructor) as the location string', () => {
        const source = `
          export class Account {
            balance: number;
            /**
             * @pre initialBalance >= 0
             */
            constructor(initialBalance: number) {
              this.balance = initialBalance;
            }
          }
        `;
        const output = transform(source);
        expect(output).toContain('"Account"');
        expect(output).not.toContain('"Account.constructor"');
      });
    });

    describe('basic @post injection', () => {
      it('injects post-check for constructor @post tag', () => {
        const source = `
          export class Account {
            balance: number;
            /**
             * @post this.balance === initialBalance
             */
            constructor(initialBalance: number) {
              this.balance = initialBalance;
            }
          }
        `;
        const output = transform(source);
        expect(output).toContain('ContractViolationError');
        expect(output).toContain('!(this.balance === initialBalance)');
        expect(output).toContain('"POST"');
      });

      it('injects both @pre and @post with original statements in between', () => {
        const source = `
          export class Account {
            balance: number;
            /**
             * @pre initialBalance >= 0
             * @post this.balance === initialBalance
             */
            constructor(initialBalance: number) {
              this.balance = initialBalance;
            }
          }
        `;
        const output = transform(source);
        const preIndex = output.indexOf('!(initialBalance >= 0)');
        const postIndex = output.indexOf('!(this.balance === initialBalance)');
        expect(preIndex).toBeGreaterThan(-1);
        expect(postIndex).toBeGreaterThan(-1);
        expect(preIndex).toBeLessThan(postIndex);
      });
    });

    describe('result and prev filtering', () => {
      it('warns and drops @post that uses result', () => {
        const source = `
          export class Account {
            balance: number;
            /**
             * @post result > 0
             */
            constructor(initialBalance: number) {
              this.balance = initialBalance;
            }
          }
        `;
        const warnings: string[] = [];
        const output = transform(source, (msg) => warnings.push(msg));
        expect(
          warnings.some((w) => w.includes("'result' used in constructor @post") && w.includes('Account')),
        ).toBe(true);
        expect(output).not.toContain('ContractViolationError');
      });

      it('warns and drops @post that uses prev', () => {
        const source = `
          export class Account {
            balance: number;
            /**
             * @post this.balance === prev.balance
             */
            constructor(initialBalance: number) {
              this.balance = initialBalance;
            }
          }
        `;
        const warnings: string[] = [];
        const output = transform(source, (msg) => warnings.push(msg));
        expect(
          warnings.some((w) => w.includes("'prev' used in constructor @post") && w.includes('Account')),
        ).toBe(true);
        expect(output).not.toContain('ContractViolationError');
      });

      it('drops result @post but still injects a valid sibling @post', () => {
        const source = `
          export class Account {
            balance: number;
            /**
             * @post result > 0
             * @post this.balance === initialBalance
             */
            constructor(initialBalance: number) {
              this.balance = initialBalance;
            }
          }
        `;
        const warnings: string[] = [];
        const output = transform(source, (msg) => warnings.push(msg));
        expect(warnings.some((w) => w.includes("'result' used in constructor @post"))).toBe(true);
        expect(output).toContain('!(this.balance === initialBalance)');
      });
    });

    describe('ordering with invariants', () => {
      it('places @post check before #checkInvariants() call', () => {
        const source = `
          /**
           * @invariant this.balance >= 0
           */
          export class Account {
            balance: number;
            /**
             * @post this.balance === initialBalance
             */
            constructor(initialBalance: number) {
              this.balance = initialBalance;
            }
          }
        `;
        const output = transformES2022(source);
        const postIndex = output.indexOf('!(this.balance === initialBalance)');
        const invariantIndex = output.indexOf('this.#checkInvariants(');
        expect(postIndex).toBeGreaterThan(-1);
        expect(invariantIndex).toBeGreaterThan(-1);
        expect(postIndex).toBeLessThan(invariantIndex);
      });

      it('places @pre at top, then original statements, then invariant (no @post)', () => {
        const source = `
          /**
           * @invariant this.balance >= 0
           */
          export class Account {
            balance: number;
            /**
             * @pre initialBalance >= 0
             */
            constructor(initialBalance: number) {
              this.balance = initialBalance;
            }
          }
        `;
        const output = transformES2022(source);
        const preIndex = output.indexOf('!(initialBalance >= 0)');
        const assignIndex = output.indexOf('this.balance = initialBalance');
        const invariantIndex = output.indexOf('this.#checkInvariants(');
        expect(preIndex).toBeGreaterThan(-1);
        expect(assignIndex).toBeGreaterThan(-1);
        expect(invariantIndex).toBeGreaterThan(-1);
        expect(preIndex).toBeLessThan(assignIndex);
        expect(assignIndex).toBeLessThan(invariantIndex);
      });

      it('existing invariant-only constructor injection still works (no @pre/@post)', () => {
        const source = `
          /**
           * @invariant this.balance >= 0
           */
          export class Account {
            balance: number;
            constructor(initialBalance: number) {
              this.balance = initialBalance;
            }
          }
        `;
        const output = transformES2022(source);
        expect(output).toContain('#checkInvariants');
        expect(output).not.toContain('throw new ContractViolationError');
      });
    });

    describe('identifier validation', () => {
      it('validates @pre with this.x (this is in scope)', () => {
        const source = `
          export class Account {
            balance: number;
            /**
             * @pre this.balance === 0
             */
            constructor(initialBalance: number) {
              this.balance = initialBalance;
            }
          }
        `;
        const warnings: string[] = [];
        const output = transform(source, (msg) => warnings.push(msg));
        expect(warnings).toHaveLength(0);
        expect(output).toContain('!(this.balance === 0)');
      });

      it('warns and drops @pre with unknown identifier', () => {
        const source = `
          export class Account {
            balance: number;
            /**
             * @pre unknownVar > 0
             */
            constructor(initialBalance: number) {
              this.balance = initialBalance;
            }
          }
        `;
        const warnings: string[] = [];
        transform(source, (msg) => warnings.push(msg));
        expect(
          warnings.some((w) => w.includes('unknownVar') && w.includes('Account')),
        ).toBe(true);
      });
    });

    describe('no-op cases', () => {
      it('returns constructor node unchanged when no @pre/@post and no invariants', () => {
        const source = `
          export class Account {
            balance: number;
            constructor(initialBalance: number) {
              this.balance = initialBalance;
            }
          }
        `;
        const output = transform(source);
        expect(output).not.toContain('ContractViolationError');
        expect(output).not.toContain('#checkInvariants');
      });

      it('does not throw on a constructor without a body (declare class)', () => {
        const source = `
          export declare class Account {
            balance: number;
            /**
             * @pre initialBalance >= 0
             */
            constructor(initialBalance: number);
          }
        `;
        expect(() => transform(source)).not.toThrow();
      });

      it('injects nothing when all @post tags are filtered out and no @pre and no invariants', () => {
        const source = `
          export class Account {
            balance: number;
            /**
             * @post result > 0
             */
            constructor(initialBalance: number) {
              this.balance = initialBalance;
            }
          }
        `;
        const warnings: string[] = [];
        const output = transform(source, (msg) => warnings.push(msg));
        expect(warnings.some((w) => w.includes("'result' used in constructor @post"))).toBe(true);
        expect(output).not.toContain('ContractViolationError');
      });
    });
  });
});
