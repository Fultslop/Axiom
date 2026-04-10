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

export function snapshot<T extends object>(obj: T): T {
  return { ...obj } as T;
}

export function deepSnapshot<T>(obj: T): T {
  return typeof structuredClone !== 'undefined'
    ? structuredClone(obj)
    : JSON.parse(JSON.stringify(obj)) as T;
}
