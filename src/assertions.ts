import { ContractViolationError } from './contract-violation-error';

export function pre(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new ContractViolationError('PRE', message, 'manual');
  }
}

export function post(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new ContractViolationError('POST', message, 'manual');
  }
}
