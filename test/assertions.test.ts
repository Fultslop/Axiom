import { pre, post } from '@src/assertions';
import { ContractViolationError } from '@src/contract-violation-error';

describe('pre', () => {
  it('does not throw when condition is true', () => {
    expect(() => pre(true, 'amount > 0')).not.toThrow();
  });

  it('throws ContractViolationError when condition is false', () => {
    expect(() => pre(false, 'amount > 0')).toThrow(ContractViolationError);
  });

  it('thrown error has type PRE', () => {
    try {
      pre(false, 'amount > 0');
    } catch (err) {
      expect(err instanceof ContractViolationError && err.type).toBe('PRE');
    }
  });

  it('thrown error carries the message as expression', () => {
    try {
      pre(false, 'amount > 0');
    } catch (err) {
      expect(err instanceof ContractViolationError && err.expression).toBe('amount > 0');
    }
  });

  it('error message contains the expression', () => {
    expect(() => pre(false, 'amount > 0')).toThrow('amount > 0');
  });
});

describe('post', () => {
  it('does not throw when condition is true', () => {
    expect(() => post(true, 'result >= 0')).not.toThrow();
  });

  it('throws ContractViolationError when condition is false', () => {
    expect(() => post(false, 'result >= 0')).toThrow(ContractViolationError);
  });

  it('thrown error has type POST', () => {
    try {
      post(false, 'result >= 0');
    } catch (err) {
      expect(err instanceof ContractViolationError && err.type).toBe('POST');
    }
  });

  it('thrown error carries the message as expression', () => {
    try {
      post(false, 'result >= 0');
    } catch (err) {
      expect(err instanceof ContractViolationError && err.expression).toBe('result >= 0');
    }
  });

  it('error message contains the expression', () => {
    expect(() => post(false, 'result >= 0')).toThrow('result >= 0');
  });
});
