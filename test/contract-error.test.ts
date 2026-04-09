import { ContractError } from '@src/contract-error';
import { ContractViolationError } from '@src/contract-violation-error';
import { InvariantViolationError } from '@src/invariant-violation-error';

describe('ContractError hierarchy', () => {
  it('ContractViolationError is an instance of ContractError', () => {
    const err = new ContractViolationError('PRE', 'x > 0', 'foo');
    expect(err).toBeInstanceOf(ContractError);
  });

  it('InvariantViolationError is an instance of ContractError', () => {
    const err = new InvariantViolationError('this.balance >= 0', 'BankAccount.withdraw');
    expect(err).toBeInstanceOf(ContractError);
  });

  it('ContractError catch covers both error types', () => {
    const errors: ContractError[] = [
      new ContractViolationError('PRE', 'x > 0', 'foo'),
      new InvariantViolationError('this.balance >= 0', 'BankAccount.withdraw'),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(ContractError);
    }
  });
});

describe('InvariantViolationError', () => {
  it('sets expression and location', () => {
    const err = new InvariantViolationError('this.balance >= 0', 'BankAccount.withdraw');
    expect(err.expression).toBe('this.balance >= 0');
    expect(err.location).toBe('BankAccount.withdraw');
  });

  it('formats message correctly', () => {
    const err = new InvariantViolationError('this.balance >= 0', 'BankAccount.withdraw');
    expect(err.message).toBe(
      '[INVARIANT] Invariant violated at BankAccount.withdraw: this.balance >= 0',
    );
  });

  it('has name InvariantViolationError', () => {
    const err = new InvariantViolationError('this.x > 0', 'Foo.bar');
    expect(err.name).toBe('InvariantViolationError');
  });

  it('is an instance of Error', () => {
    const err = new InvariantViolationError('this.x > 0', 'Foo.bar');
    expect(err).toBeInstanceOf(Error);
  });
});
