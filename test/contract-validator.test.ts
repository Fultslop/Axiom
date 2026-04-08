import typescript from 'typescript';
import { validateExpression } from '@src/contract-validator';

function parseExpr(source: string): typescript.Expression {
  const sourceFile = typescript.createSourceFile(
    'test.ts', source, typescript.ScriptTarget.ES2020, true,
  );
  const stmt = sourceFile.statements[0];
  if (!stmt || !typescript.isExpressionStatement(stmt)) {
    throw new Error(`Could not parse expression: ${source}`);
  }
  return stmt.expression;
}

describe('validateExpression — clean expressions', () => {
  it('returns [] for a simple comparison', () => {
    expect(validateExpression(parseExpr('amount > 0'), 'amount > 0', 'foo')).toEqual([]);
  });

  it('returns [] for equality check', () => {
    expect(validateExpression(parseExpr('result === 0'), 'result === 0', 'foo')).toEqual([]);
  });

  it('returns [] for complex boolean expression', () => {
    expect(validateExpression(
      parseExpr('amount > 0 && amount <= 1000'),
      'amount > 0 && amount <= 1000',
      'foo',
    )).toEqual([]);
  });
});

describe('validateExpression — assignment operator detection', () => {
  it('returns an error for simple assignment =', () => {
    const errors = validateExpression(parseExpr('x = v'), 'x = v', 'Account.foo');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.kind).toBe('assignment-in-expression');
    expect(errors[0]!.expression).toBe('x = v');
    expect(errors[0]!.location).toBe('Account.foo');
    expect(errors[0]!.message).toContain('===');
  });

  it('returns an error for +=', () => {
    const errors = validateExpression(parseExpr('x += 1'), 'x += 1', 'foo');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.kind).toBe('assignment-in-expression');
  });

  it('returns an error for -=', () => {
    const errors = validateExpression(parseExpr('x -= 1'), 'x -= 1', 'foo');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.kind).toBe('assignment-in-expression');
  });

  it('returns an error for *=', () => {
    expect(validateExpression(parseExpr('x *= 2'), 'x *= 2', 'foo')).toHaveLength(1);
  });

  it('returns an error for /=', () => {
    expect(validateExpression(parseExpr('x /= 2'), 'x /= 2', 'foo')).toHaveLength(1);
  });

  it('returns an error for nested assignment (x = 1) > 0', () => {
    const errors = validateExpression(parseExpr('(x = 1) > 0'), '(x = 1) > 0', 'foo');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.kind).toBe('assignment-in-expression');
  });

  it('returns multiple errors when expression has two assignments', () => {
    const errors = validateExpression(parseExpr('(x = 1) > (y = 2)'), '(x = 1) > (y = 2)', 'foo');
    expect(errors).toHaveLength(2);
  });

  it('includes location in each error', () => {
    const errors = validateExpression(parseExpr('x = v'), 'x = v', 'MyClass.myMethod');
    expect(errors[0]!.location).toBe('MyClass.myMethod');
  });
});

describe('validateExpression — unknown identifier detection', () => {
  const known = new Set(['amount', 'result', 'this']);

  it('returns [] when all identifiers are known', () => {
    expect(validateExpression(
      parseExpr('amount > 0'), 'amount > 0', 'foo', known,
    )).toEqual([]);
  });

  it('returns [] when knownIdentifiers is omitted (backward compat)', () => {
    expect(validateExpression(parseExpr('vvv === 5'), 'vvv === 5', 'foo')).toEqual([]);
  });

  it('returns an error when identifier is not in scope', () => {
    const errors = validateExpression(parseExpr('vvv === 5'), 'vvv === 5', 'foo', known);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.kind).toBe('unknown-identifier');
    expect(errors[0]!.expression).toBe('vvv === 5');
    expect(errors[0]!.location).toBe('foo');
    expect(errors[0]!.message).toContain('vvv');
  });

  it('checks only the base of property access, not the member name', () => {
    // "this" is known, "balance" is a member name — no error
    expect(validateExpression(
      parseExpr('this.balance > 0'), 'this.balance > 0', 'foo', known,
    )).toEqual([]);
  });

  it('returns error when base of property access is unknown', () => {
    const errors = validateExpression(
      parseExpr('obj.prop > 0'), 'obj.prop > 0', 'foo', known,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.kind).toBe('unknown-identifier');
    expect(errors[0]!.message).toContain('obj');
  });

  it('allows undefined as a globally known value', () => {
    expect(validateExpression(
      parseExpr('amount !== undefined'), 'amount !== undefined', 'foo', known,
    )).toEqual([]);
  });

  it('allows NaN as a globally known value', () => {
    expect(validateExpression(
      parseExpr('amount !== NaN'), 'amount !== NaN', 'foo', known,
    )).toEqual([]);
  });

  it('returns one error per unknown identifier (not one per occurrence)', () => {
    // "vvv" appears twice; should produce two errors (one per occurrence)
    const errors = validateExpression(
      parseExpr('vvv > 0 && vvv < 10'), 'vvv > 0 && vvv < 10', 'foo', known,
    );
    expect(errors).toHaveLength(2);
  });

  it('does not flag known identifier used in call expression', () => {
    // amount.toString() — "amount" is known
    expect(validateExpression(
      parseExpr('amount.toString() !== undefined'),
      'amount.toString() !== undefined',
      'foo',
      known,
    )).toEqual([]);
  });
});
