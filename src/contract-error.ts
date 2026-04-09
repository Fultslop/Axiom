export abstract class ContractError extends Error {
  public abstract readonly expression: string;

  public abstract readonly location: string;
}
