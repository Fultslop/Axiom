import { transform, transformES2022, transformWithProgram, evalTransformedWith } from './helpers';

describe('keepContracts option', () => {
  const sourcePreAndPost = `
    /**
     * @pre x > 0
     * @post result > 0
     */
    export function double(x: number): number { return x * 2; }
  `;

  it('keepContracts: false (default) — output identical to omitting the option', () => {
    const withDefault = transform(sourcePreAndPost);
    const withFalse = transform(sourcePreAndPost, { keepContracts: false });
    expect(withFalse).toBe(withDefault);
  });

  it('keepContracts: true — both pre and post checks are emitted', () => {
    const result = transform(sourcePreAndPost, { keepContracts: true });
    expect(result).toContain('x > 0');
    expect(result).toContain('result > 0');
  });

  it('keepContracts: "all" — same output as true', () => {
    const withTrue = transform(sourcePreAndPost, { keepContracts: true });
    const withAll = transform(sourcePreAndPost, { keepContracts: 'all' });
    expect(withTrue).toBe(withAll);
  });

  it('keepContracts: "pre" — only pre check emitted, no post scaffolding', () => {
    const result = transform(sourcePreAndPost, { keepContracts: 'pre' });
    expect(result).toContain('ContractViolationError("PRE", "x > 0"');
    expect(result).not.toContain('ContractViolationError("POST"');
    expect(result).not.toContain('__axiom_result__');
  });

  it('keepContracts: "post" — only post check emitted, no pre assertion', () => {
    const result = transform(sourcePreAndPost, { keepContracts: 'post' });
    expect(result).not.toContain('ContractViolationError("PRE"');
    expect(result).toContain('ContractViolationError("POST", "result > 0"');
    expect(result).toContain('__axiom_result__');
  });

  it('keepContracts: "all" on a function with no contract tags — no output change', () => {
    const source = `export function noop(): void {}`;
    const baseline = transform(source);
    const result = transform(source, { keepContracts: 'all' });
    expect(result).toBe(baseline);
  });
});

describe('location string for arrow function', () => {
  it('uses the variable name in the ContractError message', () => {
    const source = `
      export const validate = /** @pre x > 0 */ (x: number): boolean => x > 0;
    `;
    const compiled = transform(source);
    expect(compiled).toContain('ContractViolationError');
    expect(compiled).toContain('"validate"');
    expect(compiled).not.toContain('"anonymous"');
  });
});

describe('keepContracts with class invariants', () => {
  it('keepContracts: "invariant" — invariant call emitted, pre absent', () => {
    const source = `
      /** @invariant this.value > 0 */
      class Counter {
        value = 1;
        /** @pre amount > 0 */
        public increment(amount: number): void { this.value += amount; }
      }
    `;
    const warnings: string[] = [];
    const result = transformES2022(source, (msg) => warnings.push(msg));
    // baseline: both pre and invariant present
    expect(result).toContain('amount > 0');
    expect(result).toContain('checkInvariants');
    // now with 'invariant' only
    const filtered = transformES2022(source, { keepContracts: 'invariant' });
    expect(filtered).not.toContain('ContractViolationError("PRE"');
    expect(filtered).toContain('checkInvariants');
  });

  it('keepContracts: "pre" — pre emitted, invariant call absent', () => {
    const source = `
      /** @invariant this.value > 0 */
      class Counter {
        value = 1;
        /** @pre amount > 0 */
        public increment(amount: number): void { this.value += amount; }
      }
    `;
    const result = transformES2022(source, { keepContracts: 'pre' });
    expect(result).toContain('amount > 0');
    expect(result).not.toContain('checkInvariants');
  });

  it('keepContracts: "post" — post emitted, invariant call absent', () => {
    const source = `
      /** @invariant this.value > 0 */
      class Counter {
        value = 1;
        /** @post this.value > 0 */
        public increment(amount: number): void { this.value += amount; }
      }
    `;
    const result = transformES2022(source, { keepContracts: 'post' });
    expect(result).toContain('this.value > 0');
    expect(result).not.toContain('checkInvariants');
  });

  it('keepContracts: false (default) — both pre and invariant emitted', () => {
    const source = `
      /** @invariant this.value > 0 */
      class Counter {
        value = 1;
        /** @pre amount > 0 */
        public increment(amount: number): void { this.value += amount; }
      }
    `;
    const withDefault = transformES2022(source);
    const withFalse = transformES2022(source, { keepContracts: false });
    expect(withDefault).toBe(withFalse);
    expect(withDefault).toContain('amount > 0');
    expect(withDefault).toContain('checkInvariants');
  });
});

describe('keepContracts — require injection', () => {
  it('emits require import when keepContracts: "all" and contracts are present', () => {
    const source = `
      /** @pre x > 0 */
      export function inc(x: number): number { return x + 1; }
    `;
    const result = transform(source, { keepContracts: 'all' });
    expect(result).toContain('require("@fultslop/axiom")');
  });

  it('does not emit require import when keepContracts filters all contracts out', () => {
    // Function has only @pre; keepContracts: 'post' means nothing is emitted.
    const source = `
      /** @pre x > 0 */
      export function inc(x: number): number { return x + 1; }
    `;
    const result = transform(source, { keepContracts: 'post' });
    expect(result).not.toContain('require("@fultslop/axiom")');
  });
});

describe('file-level @axiom keepContracts directive', () => {
  it('directive with no qualifier enables "all", overriding global false', () => {
    const source = `// @axiom keepContracts
/**
 * @pre x > 0
 * @post result > 0
 */
export function double(x: number): number { return x * 2; }
`;
    const result = transform(source, { keepContracts: false });
    expect(result).toContain('ContractViolationError("PRE", "x > 0"');
    expect(result).toContain('ContractViolationError("POST", "result > 0"');
  });

  it('directive "pre" enables only pre, overriding global false', () => {
    const source = `// @axiom keepContracts pre
/**
 * @pre x > 0
 * @post result > 0
 */
export function double(x: number): number { return x * 2; }
`;
    const result = transform(source, { keepContracts: false });
    expect(result).toContain('ContractViolationError("PRE", "x > 0"');
    expect(result).not.toContain('ContractViolationError("POST"');
    expect(result).not.toContain('__axiom_result__');
  });

  it('directive "post" enables only post, overriding global false', () => {
    const source = `// @axiom keepContracts post
/**
 * @pre x > 0
 * @post result > 0
 */
export function double(x: number): number { return x * 2; }
`;
    const result = transform(source, { keepContracts: false });
    expect(result).not.toContain('ContractViolationError("PRE"');
    expect(result).toContain('ContractViolationError("POST", "result > 0"');
    expect(result).toContain('__axiom_result__');
  });

  it('file without directive and global false — no checks emitted (existing behaviour)', () => {
    const source = `
/** @pre x > 0 */
export function inc(x: number): number { return x + 1; }
`;
    const baseline = transform(source);
    const result = transform(source, { keepContracts: false });
    expect(result).toBe(baseline);
  });

  it('directive on a non-first line is ignored', () => {
    const source = `export const dummy = 1;
// @axiom keepContracts
/** @pre x > 0 */
export function inc(x: number): number { return x + 1; }
`;
    // Directive is not on first line — it is ignored, global 'post' applies.
    // A wrongly-detected directive would activate 'all' and emit the pre check.
    const result = transform(source, { keepContracts: 'post' });
    expect(result).not.toContain('ContractViolationError("PRE"');
    // But the directive comment itself is preserved in output.
    expect(result).toContain('// @axiom keepContracts');
  });

  it('unknown qualifier falls back to global option', () => {
    const source = `// @axiom keepContracts foobar
/** @pre x > 0 */
export function inc(x: number): number { return x + 1; }
`;
    // Unknown qualifier → undefined → fall back to global 'post' → pre absent.
    const result = transform(source, { keepContracts: 'post' });
    expect(result).not.toContain('ContractViolationError("PRE"');
  });
});

describe('buildLocationName for arrow and function expressions', () => {
  it('returns variable name for arrow function assigned to exported const', () => {
    const source = `
      export const validate = /** @pre x > 0 */ (x: number): boolean => x > 0;
    `;
    // Full injection is wired in Task 4. Here we just confirm no throw on valid input
    // and that the helpers compile correctly.
    expect(() => transform(source)).not.toThrow();
  });
});

describe('arrow function with expression body (@pre)', () => {
  it('injects @pre guard into expression-body arrow', () => {
    const source = `
      export const double = /** @pre x > 0 */ (x: number): number => x * 2;
    `;
    const compiled = transform(source);
    expect(compiled).toContain('ContractViolationError');
    expect(compiled).toContain('x > 0');
  });
});

describe('arrow function with block body (@pre)', () => {
  it('injects @pre guard into block-body arrow', () => {
    const source = `
      export const clamp = /** @pre min <= max */
        (num: number, min: number, max: number): number => {
          return Math.min(Math.max(num, min), max);
        };
    `;
    const compiled = transform(source);
    expect(compiled).toContain('ContractViolationError');
    expect(compiled).toContain('min <= max');
  });
});

describe('function expression (@pre)', () => {
  it('injects @pre guard into exported function expression', () => {
    const source = `
      export const trim = /** @pre input.length > 0 */ function(input: string): string {
        return input.trim();
      };
    `;
    const compiled = transform(source);
    expect(compiled).toContain('ContractViolationError');
    expect(compiled).toContain('input.length > 0');
  });
});

describe('arrow function @post with result', () => {
  it('injects @post result check (expression body)', () => {
    const source = `
      export const abs = /** @post result >= 0 */ (x: number): number => Math.abs(x);
    `;
    const compiled = transform(source);
    expect(compiled).toContain('ContractViolationError');
    expect(compiled).toContain('result >= 0');
  });

  it('warns and drops @post result when no return type annotation', () => {
    const source = `
      export const broken = /** @post result > 0 */ (x: number) => x;
    `;
    const warnings: string[] = [];
    transform(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes('result') && w.includes('@post dropped')),
    ).toBe(true);
  });
});

describe('named function expression', () => {
  it('injects @pre and uses variable name (not function name) in location', () => {
    const source = `
      export const factorial =
        /** @pre num >= 0 */ function fact(num: number): number {
          return num <= 1 ? 1 : num * fact(num - 1);
        };
    `;
    const compiled = transform(source);
    expect(compiled).toContain('ContractViolationError');
    expect(compiled).toContain('num >= 0');
    expect(compiled).toContain('"factorial"');
    expect(compiled).not.toContain('"fact"');
  });
});

describe('non-exported arrow function — no injection', () => {
  it('leaves non-exported arrow unchanged and emits no warning', () => {
    const source = `
      const internal = /** @pre x > 0 */ (x: number): number => x;
    `;
    const warnings: string[] = [];
    const compiled = transform(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
    expect(compiled).not.toContain('require(');
  });
});

describe('arrow with no tags — no injection', () => {
  it('does not inject require when no @pre/@post present', () => {
    const source = `
      export const noop = (x: number): number => x;
    `;
    const compiled = transform(source);
    expect(compiled).not.toContain('require(');
  });
});

describe('multiple contracts on one arrow', () => {
  it('injects both @pre and @post', () => {
    const source = `
      export const divide =
        /** @pre denominator !== 0 @post result !== Infinity */
        (numerator: number, denominator: number): number => numerator / denominator;
    `;
    const compiled = transform(source);
    expect(compiled).toContain('denominator !== 0');
    expect(compiled).toContain('result !== Infinity');
  });
});

describe('unknown identifier in @pre on arrow — warning, tag dropped', () => {
  it('warns and drops the @pre tag', () => {
    const source = `
      export const foo = /** @pre ghost > 0 */ (x: number): number => x;
    `;
    const warnings: string[] = [];
    transform(source, (msg) => warnings.push(msg));
    expect(warnings.some((w) => w.includes('ghost'))).toBe(true);
  });
});

describe('VariableStatement with multiple declarations', () => {
  it('only rewrites the annotated declaration', () => {
    const source = `
      export const alpha = 1,
        validate = /** @pre x > 0 */ (x: number): boolean => x > 0;
    `;
    const compiled = transform(source);
    expect(compiled).toContain('alpha');
    expect(compiled).toContain('ContractViolationError');
    expect(compiled).toContain('x > 0');
  });
});

describe('async function post-condition body capture', () => {
  it('checks resolved value for @post result !== null on async function', async () => {
    const source = `
      interface User { id: number }
      /**
       * @post result !== null
       */
      export async function findUser(id: number): Promise<User | null> {
        return Promise.resolve(null);
      }
    `;
    const warnings: string[] = [];
    const js = transformWithProgram(source, (msg) => warnings.push(msg));
    // The transformed function must be async and await the IIFE
    expect(js).toContain('await');
    expect(js).toContain('async ()');
    // Invoking it should throw because null !== null is false (i.e. result IS null)
    const fn = evalTransformedWith(js, 'findUser') as (id: number) => Promise<unknown>;
    await expect(fn(1)).rejects.toThrow();
  });

  it('does not wrap synchronous function body in await', () => {
    const source = `
      /**
       * @post result > 0
       */
      export function count(): number { return 1; }
    `;
    const warnings: string[] = [];
    const js = transformWithProgram(source, (msg) => warnings.push(msg));
    expect(js).not.toContain('await (async');
  });

  it('@pre fires synchronously before async body', async () => {
    const source = `
      /**
       * @pre id > 0
       */
      export async function findUser(id: number): Promise<void> {
        return Promise.resolve();
      }
    `;
    const warnings: string[] = [];
    const js = transformWithProgram(source, (msg) => warnings.push(msg));
    const fn = evalTransformedWith(js, 'findUser') as (id: number) => Promise<void>;
    await expect(fn(0)).rejects.toThrow();
    await expect(fn(1)).resolves.toBeUndefined();
  });
});

describe('async void return type — @post result drop', () => {
  it('warns and drops @post result on async Promise<void> function', () => {
    const source = `
      /**
       * @post result !== undefined
       */
      export async function doWork(): Promise<void> {}
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes("return type is 'void'") && w.includes('@post')),
    ).toBe(true);
  });

  it('warns and drops @post result on async Promise<never> function', () => {
    const source = `
      /**
       * @post result !== null
       */
      export async function fail(): Promise<never> { throw new Error(); }
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes("return type is 'never'") && w.includes('@post')),
    ).toBe(true);
  });

  it('keeps @post result on async Promise<number>', () => {
    const source = `
      /**
       * @post result > 0
       */
      export async function count(): Promise<number> { return Promise.resolve(1); }
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) =>
        w.includes("return type is 'void'") || w.includes("return type is 'never'")),
    ).toBe(false);
  });
});

describe('async result type mismatch detection', () => {
  it('warns for @post result === "ok" when async return is Promise<number>', () => {
    const source = `
      /**
       * @post result === "ok"
       */
      export async function getCount(): Promise<number> { return Promise.resolve(1); }
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(
      warnings.some((w) => w.includes('type mismatch') && w.includes('result')),
    ).toBe(true);
  });

  it('does not warn for @post result > 0 when async return is Promise<number>', () => {
    const source = `
      /**
       * @post result > 0
       */
      export async function getCount(): Promise<number> { return Promise.resolve(1); }
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
  });

  it('does not warn for @post result !== null when async return is Promise<string>', () => {
    const source = `
      /**
       * @post result !== null
       */
      export async function getName(): Promise<string> { return Promise.resolve(''); }
    `;
    const warnings: string[] = [];
    transformWithProgram(source, (msg) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
  });
});
