import { ContractViolationError } from 'fsprepost';

// ContractViolationError is imported here only to satisfy the type-checker
// when running this file directly. The transformer will inject its own import.
void ContractViolationError;

export class Account {
  public balance: number = 100;

  /**
   * @pre amount > 0
   * @pre amount <= this.balance
   * @post result === this.balance
   */
  public withdraw(amount: number): number {
    this.balance -= amount;
    return this.balance;
  }
}
