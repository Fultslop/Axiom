import { ContractViolationError } from './index';

describe('public API', () => {
  it('exports ContractViolationError', () => {
    expect(ContractViolationError).toBeDefined();
    const err = new ContractViolationError('PRE', 'xxx > 0', 'foo');
    expect(err).toBeInstanceOf(Error);
  });
});
