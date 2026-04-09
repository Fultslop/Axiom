import { ContractError } from './contract-error';

export class InvariantViolationError extends ContractError {
  public readonly expression: string;

  public readonly location: string;

  constructor(expression: string, location: string) {
    super(`[INVARIANT] Invariant violated at ${location}: ${expression}`);
    this.name = 'InvariantViolationError';
    this.expression = expression;
    this.location = location;
  }
}
