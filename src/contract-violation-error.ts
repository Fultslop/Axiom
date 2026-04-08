export class ContractViolationError extends Error {
  public readonly type: 'PRE' | 'POST';

  public readonly expression: string;

  public readonly location: string;

  constructor(type: 'PRE' | 'POST', expression: string, location: string) {
    super(`[${type}] Contract violated at ${location}: ${expression}`);
    this.name = 'ContractViolationError';
    this.type = type;
    this.expression = expression;
    this.location = location;
  }
}
