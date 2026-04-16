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
