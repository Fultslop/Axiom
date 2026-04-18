/**
 * Acceptance suite for @fultslop/axiom v0.9.0-alpha
 *
 * 30 tests covering arrow functions (A), function declarations / async (B),
 * and class invariants (C).
 */
import { transform, transformWithProgram, evalTransformedWith, transformES2022 } from './helpers';
import { ContractViolationError } from '../src/contract-violation-error';
import { InvariantViolationError } from '../src/invariant-violation-error';
import { ContractError } from '../src/contract-error';

// ---------------------------------------------------------------------------
// A — exported arrow functions
// ---------------------------------------------------------------------------

describe('A — exported arrow functions', () => {
  it('A1 — @pre guard injected for typed arrow function', () => {
    const source = `
      /** @pre x > 0 */
      export const double = (x: number): number => x * 2;
    `;
    const output = transform(source);
    expect(output).toContain('ContractViolationError');
    expect(output).toContain('x > 0');
  });

  it('A2 — @post guard injected for arrow function with typed result', () => {
    const source = `
      /** @post result > 0 */
      export const double = (x: number): number => x * 2;
    `;
    const output = transform(source);
    expect(output).toContain('ContractViolationError');
    expect(output).toContain('result > 0');
  });

  it('A3 — @pre fires ContractViolationError at runtime', () => {
    const source = `
      /** @pre x > 0 */
      export const mustBePositive = (x: number): number => x * 2;
    `;
    const output = transform(source);
    const fn = evalTransformedWith(output, 'mustBePositive') as (x: number) => number;
    expect(() => fn(0)).toThrow(ContractViolationError);
    expect(() => fn(1)).not.toThrow();
  });

  it('A4 — @post fires ContractViolationError at runtime', () => {
    const source = `
      /** @post result > 10 */
      export const alwaysSmall = (x: number): number => x;
    `;
    const output = transform(source);
    const fn = evalTransformedWith(output, 'alwaysSmall') as (x: number) => number;
    expect(() => fn(1)).toThrow(ContractViolationError);
    expect(() => fn(11)).not.toThrow();
  });

  it('A5 — arrow with both @pre and @post emits both guards', () => {
    const source = `
      /**
       * @pre x > 0
       * @post result > 0
       */
      export const square = (x: number): number => x * x;
    `;
    const output = transform(source);
    expect(output).toContain('"PRE"');
    expect(output).toContain('"POST"');
    expect(output).toContain('x > 0');
    expect(output).toContain('result > 0');
  });

  it('A6 — void-return arrow with @pre → pre guard still injected', () => {
    const source = `
      /** @pre msg.length > 0 */
      export const logMsg = (msg: string): void => { void msg; };
    `;
    const output = transform(source);
    expect(output).toContain('ContractViolationError');
    expect(output).toContain('msg.length > 0');
  });

  it('A7 — arrow function with no contract tags → no guard code emitted', () => {
    const source = `
      export const add = (a: number, b: number): number => a + b;
    `;
    const output = transform(source);
    expect(output).not.toContain('ContractViolationError');
    expect(output).not.toContain('__axiom_result__');
  });

  it('A8 — @pre dropped (unknown identifier) → JSDoc stripped, warning emitted', () => {
    const warns: string[] = [];
    const source = `
      /** @pre unknownVar > 0 */
      export const arrowWithUnknownId = (x: number): number => x;
    `;
    const output = transformWithProgram(source, (msg) => warns.push(msg));
    expect(warns.length).toBeGreaterThan(0);
    expect(output).not.toContain('unknownVar');
  });

  it('A9 — @post with result and no declared return type → warn and drop', () => {
    const warns: string[] = [];
    const source = `
      /** @post result > 0 */
      export const noReturnType = (x: number) => x;
    `;
    const output = transform(source, (msg) => warns.push(msg));
    expect(warns.some((w) => w.includes('no return type'))).toBe(true);
    expect(output).not.toContain('__axiom_result__');
  });

  it('A10 — @post dropped (void return with result) → JSDoc stripped, warning emitted', () => {
    const warns: string[] = [];
    const source = `
      /** @post result === undefined */
      export const arrowVoidWithPost = (msg: string): void => { void msg; };
    `;
    const output = transformWithProgram(source, (msg) => warns.push(msg));
    expect(warns.length).toBeGreaterThan(0);
    expect(output).not.toContain('result === undefined');
  });
});

// ---------------------------------------------------------------------------
// B — function declarations and async functions
// ---------------------------------------------------------------------------

describe('B — function declarations and async functions', () => {
  it('B1 — function declaration @pre guard injected', () => {
    const source = `
      /** @pre x > 0 */
      export function triple(x: number): number { return x * 3; }
    `;
    const output = transform(source);
    expect(output).toContain('ContractViolationError');
    expect(output).toContain('x > 0');
  });

  it('B2 — function declaration @post with result → guard injected', () => {
    const source = `
      /** @post result >= 0 */
      export function absolute(x: number): number { return x < 0 ? -x : x; }
    `;
    const output = transform(source);
    expect(output).toContain('"POST"');
    expect(output).toContain('result >= 0');
  });

  it('B3 — async function @post dropped (Promise<void> with result) → JSDoc stripped', () => {
    const warns: string[] = [];
    const source = `
      /** @post result === undefined */
      export async function asyncVoidWithPost(msg: string): Promise<void> { void msg; }
    `;
    const output = transformWithProgram(source, (msg) => warns.push(msg));
    expect(warns.length).toBeGreaterThan(0);
    expect(output).not.toContain('result === undefined');
  });

  it('B4 — async function @pre guard injected', () => {
    const source = `
      /** @pre x > 0 */
      export async function fetchDouble(x: number): Promise<number> { return x * 2; }
    `;
    const output = transform(source);
    expect(output).toContain('ContractViolationError');
    expect(output).toContain('x > 0');
  });

  it('B5 — async function @post on Promise<number> → result check emitted', () => {
    const source = `
      /** @post result > 0 */
      export async function asyncPositive(x: number): Promise<number> { return x; }
    `;
    const output = transform(source);
    expect(output).toContain('"POST"');
    expect(output).toContain('result > 0');
  });

  it('B6 — function declaration @pre fires ContractViolationError at runtime', () => {
    const source = `
      /** @pre n > 0 */
      export function factorial(n: number): number { return n; }
    `;
    const output = transform(source);
    const fn = evalTransformedWith(output, 'factorial') as (n: number) => number;
    expect(() => fn(-1)).toThrow(ContractViolationError);
    expect(() => fn(5)).not.toThrow();
  });

  it('B7 — function declaration @post fires ContractViolationError at runtime', () => {
    const source = `
      /** @post result === 42 */
      export function wrongAnswer(x: number): number { return x; }
    `;
    const output = transform(source);
    const fn = evalTransformedWith(output, 'wrongAnswer') as (n: number) => number;
    expect(() => fn(1)).toThrow(ContractViolationError);
    expect(() => fn(42)).not.toThrow();
  });

  it('B8 — async function with early throw and @post → guard properly injected', () => {
    const source = `
      /** @post result > 0 */
      export async function guarded(x: number): Promise<number> {
        if (x < 0) throw new Error('negative');
        return x + 1;
      }
    `;
    const output = transform(source);
    expect(output).toContain('"POST"');
    expect(output).toContain('result > 0');
    expect(output).toContain('__axiom_result__');
  });

  it('B9 — void-return function declaration → @pre still injected', () => {
    const source = `
      /** @pre x > 0 */
      export function sideEffect(x: number): void { void x; }
    `;
    const output = transform(source);
    expect(output).toContain('ContractViolationError');
    expect(output).toContain('x > 0');
  });

  it('B10 — non-exported function → not modified', () => {
    const source = `
      /** @pre x > 0 */
      function internal(x: number): number { return x; }
      export function wrap(x: number): number { return internal(x); }
    `;
    const output = transform(source);
    expect(output).not.toContain('ContractViolationError');
  });

  it('B11 — async function with multiple @pre clauses → all emitted', () => {
    const source = `
      /**
       * @pre a > 0
       * @pre b > 0
       */
      export async function asyncSum(a: number, b: number): Promise<number> { return a + b; }
    `;
    const output = transform(source);
    expect(output).toContain('a > 0');
    expect(output).toContain('b > 0');
  });

  it('B12 — function with no contract tags → output contains no guard code', () => {
    const source = `
      export function noop(x: number): number { return x; }
    `;
    const output = transform(source);
    expect(output).not.toContain('ContractViolationError');
    expect(output).not.toContain('__axiom_result__');
  });
});

// ---------------------------------------------------------------------------
// C — class invariants and method contracts
// ---------------------------------------------------------------------------

function evalClassWithContracts(
  js: string,
): Record<string, new (...args: unknown[]) => unknown> {
  const exports: Record<string, unknown> = {};
  const mod = { exports };
  const stripped = js.replace(/.*require\("@fultslop\/axiom"\).*\n?/g, '');
  // eslint-disable-next-line no-new-func
  new Function(
    'exports', 'module', 'ContractViolationError', 'InvariantViolationError',
    stripped,
  )(exports, mod, ContractViolationError, InvariantViolationError);
  return mod.exports as Record<string, new (...args: unknown[]) => unknown>;
}

describe('C — class invariants and method contracts', () => {
  const COUNTER_SOURCE = `
    /** @invariant this.value >= 0 */
    export class Counter {
      value = 10;
      /** @pre n > 0 */
      increment(n: number): void { this.value += n; }
      /** @pre n > 0 */
      decrement(n: number): void { this.value -= n; }
    }
  `;

  it('C1 — @invariant guard emitted in compiled output', () => {
    const output = transformES2022(COUNTER_SOURCE);
    expect(output).toContain('checkInvariants');
  });

  it('C2 — class @pre guard emitted in compiled output', () => {
    const output = transformES2022(COUNTER_SOURCE);
    expect(output).toContain('"PRE"');
    expect(output).toContain('n > 0');
  });

  it('C3 — class @pre fires ContractViolationError at runtime', () => {
    const output = transformES2022(COUNTER_SOURCE);
    const mod = evalClassWithContracts(output);
    const Cls = mod['Counter'] as new () => { value: number; increment(n: number): void };
    const counter = new Cls();
    expect(() => counter.increment(-1)).toThrow(ContractViolationError);
  });

  it('C4 — class valid method call does not throw', () => {
    const output = transformES2022(COUNTER_SOURCE);
    const mod = evalClassWithContracts(output);
    const Cls = mod['Counter'] as new () => { value: number; increment(n: number): void };
    const counter = new Cls();
    expect(() => counter.increment(5)).not.toThrow();
  });

  it('C5 — @invariant fires InvariantViolationError when violated', () => {
    const output = transformES2022(COUNTER_SOURCE);
    const mod = evalClassWithContracts(output);
    const Cls = mod['Counter'] as new () => { value: number; decrement(n: number): void };
    const counter = new Cls();
    expect(() => counter.decrement(100)).toThrow(InvariantViolationError);
  });

  it('C6 — InvariantViolationError is an instance of ContractError', () => {
    const output = transformES2022(COUNTER_SOURCE);
    const mod = evalClassWithContracts(output);
    const Cls = mod['Counter'] as new () => { value: number; decrement(n: number): void };
    const counter = new Cls();
    let caught: unknown;
    try { counter.decrement(100); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(ContractError);
  });

  it('C7 — class @post guard emitted in compiled output', () => {
    const source = `
      export class Calc {
        /** @post result > 0 */
        square(x: number): number { return x * x; }
      }
    `;
    const output = transformES2022(source);
    expect(output).toContain('"POST"');
    expect(output).toContain('result > 0');
  });

  it('C8 — class method @post fires ContractViolationError at runtime', () => {
    const source = `
      export class Calc {
        /** @post result > 10 */
        double(x: number): number { return x * 2; }
      }
    `;
    const output = transformES2022(source);
    const mod = evalClassWithContracts(output);
    const Cls = mod['Calc'] as new () => { double(x: number): number };
    const calc = new Cls();
    expect(() => calc.double(1)).toThrow(ContractViolationError);
    expect(() => calc.double(10)).not.toThrow();
  });
});
