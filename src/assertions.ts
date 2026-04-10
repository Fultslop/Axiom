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
  return { ...obj };
}

export function deepSnapshot<T>(obj: T): T {
  // eslint-disable-next-line no-restricted-syntax
  if (typeof globalThis.structuredClone !== 'undefined') {
    return globalThis.structuredClone(obj);
  }
  return JSON.parse(JSON.stringify(obj)) as T;
}
