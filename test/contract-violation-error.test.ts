import { ContractViolationError } from '@src/contract-violation-error';

describe('ContractViolationError', () => {
  it('sets type, expression, and location', () => {
    const err = new ContractViolationError('PRE', 'amount > 0', 'Account.withdraw');
    expect(err.type).toBe('PRE');
    expect(err.expression).toBe('amount > 0');
    expect(err.location).toBe('Account.withdraw');
  });

  it('formats message with all fields', () => {
    const err = new ContractViolationError('POST', 'result >= 0', 'Account.deposit');
    expect(err.message).toBe('[POST] Contract violated at Account.deposit: result >= 0');
  });

  it('has name ContractViolationError', () => {
    const err = new ContractViolationError('PRE', 'x > 0', 'foo');
    expect(err.name).toBe('ContractViolationError');
  });

  it('is an instance of Error', () => {
    const err = new ContractViolationError('PRE', 'x > 0', 'foo');
    expect(err).toBeInstanceOf(Error);
  });
});
