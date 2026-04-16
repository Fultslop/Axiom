import { transform, transformES2022 } from './helpers';

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
