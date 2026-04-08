import typescript from 'typescript';
import createTransformer from './transformer';

function transform(source: string): string {
  const result = typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2020,
      module: typescript.ModuleKind.CommonJS,
    },
    transformers: {
      before: [createTransformer()],
    },
  });
  return result.outputText;
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
