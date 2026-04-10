import typescript from 'typescript';
import {
  buildPreCheck, buildBodyCapture, buildPostCheck, buildResultReturn,
  parseContractExpression, AXIOM_RESULT_VAR, AXIOM_PREV_VAR,
} from '@src/ast-builder';

function printNode(node: typescript.Node): string {
  const printer = typescript.createPrinter({ newLine: typescript.NewLineKind.LineFeed });
  const dummyFile = typescript.createSourceFile(
    'print.ts', '', typescript.ScriptTarget.ES2020, false, typescript.ScriptKind.TS
  );
  return printer.printNode(typescript.EmitHint.Unspecified, node, dummyFile);
}

function parseStatement(source: string): typescript.Statement {
  const sourceFile = typescript.createSourceFile(
    'test.ts', source, typescript.ScriptTarget.ES2020, true
  );
  const firstStatement = sourceFile.statements[0];
  if (!firstStatement) {
    throw new Error('No statement found');
  }
  return firstStatement;
}

describe('buildPreCheck', () => {
  it('wraps expression in negated if and throws ContractViolationError', () => {
    const node = buildPreCheck('amount > 0', 'Account.withdraw');
    const output = printNode(node);
    expect(output).toContain('!(amount > 0)');
    expect(output).toContain('ContractViolationError');
    expect(output).toContain('"PRE"');
    expect(output).toContain('"amount > 0"');
    expect(output).toContain('"Account.withdraw"');
  });
});

describe('buildPostCheck', () => {
  it('wraps expression in negated if and throws ContractViolationError with substituted identifiers', () => {
    const node = buildPostCheck('result >= 0', 'Account.deposit');
    const output = printNode(node);
    expect(output).toContain(`!(${AXIOM_RESULT_VAR} >= 0)`);
    expect(output).toContain('"POST"');
    expect(output).toContain('"result >= 0"');
    expect(output).toContain('"Account.deposit"');
  });

  it('substitutes prev identifier in post check', () => {
    const node = buildPostCheck('result === prev.x + 1', 'Account.deposit');
    const output = printNode(node);
    expect(output).toContain(`!(${AXIOM_RESULT_VAR} === ${AXIOM_PREV_VAR}.x + 1)`);
    expect(output).toContain('"result === prev.x + 1"');
  });
});

describe('buildBodyCapture', () => {
  it('wraps original statements in an IIFE assigned to const __axiom_result__', () => {
    const originalBody = parseStatement('{ x = 1; return x; }') as typescript.Block;
    const node = buildBodyCapture(originalBody.statements);
    const output = printNode(node);
    expect(output).toContain(`const ${AXIOM_RESULT_VAR}`);
    expect(output).toContain('=>');
    expect(output).toContain('x = 1');
  });
});

describe('buildResultReturn', () => {
  it('produces return __axiom_result__ statement', () => {
    const node = buildResultReturn();
    const output = printNode(node);
    expect(output).toContain(`return ${AXIOM_RESULT_VAR}`);
  });
});

describe('reifyExpression — extended literal/keyword coverage', () => {
  it('handles string literal in expression', () => {
    const node = buildPreCheck('"hello" === xxx', 'Test.method');
    const output = printNode(node);
    expect(output).toContain('"hello"');
  });

  it('handles null keyword in expression', () => {
    const node = buildPreCheck('xxx !== null', 'Test.method');
    const output = printNode(node);
    expect(output).toContain('null');
  });

  it('handles true keyword in expression', () => {
    const node = buildPreCheck('xxx === true', 'Test.method');
    const output = printNode(node);
    expect(output).toContain('true');
  });

  it('handles false keyword in expression', () => {
    const node = buildPreCheck('xxx === false', 'Test.method');
    const output = printNode(node);
    expect(output).toContain('false');
  });

  it('handles property access in expression', () => {
    const node = buildPreCheck('obj.balance > 0', 'Account.withdraw');
    const output = printNode(node);
    expect(output).toContain('obj.balance');
  });

  it('handles typeof in expression', () => {
    const node = buildPreCheck('typeof xxx === "string"', 'Test.method');
    const output = printNode(node);
    expect(output).toContain('typeof');
  });

  it('handles parenthesized expression', () => {
    const node = buildPreCheck('(xxx > 0)', 'Test.method');
    const output = printNode(node);
    expect(output).toContain('xxx > 0');
  });

  it('handles prefix unary expression', () => {
    const node = buildPreCheck('!xxx', 'Test.method');
    const output = printNode(node);
    expect(output).toContain('!xxx');
  });
});

describe('reifyStatement — extended statement coverage', () => {
  it('handles variable declaration in body capture', () => {
    const block = parseStatement('{ const yyy = 5; return yyy; }') as typescript.Block;
    const node = buildBodyCapture(block.statements);
    const output = printNode(node);
    expect(output).toContain('const yyy');
    expect(output).toContain('return yyy');
  });

  it('handles if statement in body capture', () => {
    const block = parseStatement('{ if (xxx > 0) { return xxx; } return 0; }') as typescript.Block;
    const node = buildBodyCapture(block.statements);
    const output = printNode(node);
    expect(output).toContain('if');
    expect(output).toContain('xxx > 0');
  });

  it('handles if statement with else in body capture', () => {
    const block = parseStatement(
      '{ if (xxx > 0) { return xxx; } else { return 0; } }',
    ) as typescript.Block;
    const node = buildBodyCapture(block.statements);
    const output = printNode(node);
    expect(output).toContain('else');
  });

  it('handles return statement without expression in body capture', () => {
    const block = parseStatement('{ if (xxx > 0) { return; } return 0; }') as typescript.Block;
    const node = buildBodyCapture(block.statements);
    const output = printNode(node);
    expect(output).toContain('return;');
  });

  it('handles for-of loop in body capture', () => {
    const block = parseStatement('{ let sum = 0; for (const x of arr) { sum += x; } return sum; }') as typescript.Block;
    const node = buildBodyCapture(block.statements);
    const output = printNode(node);
    expect(output).toContain('for');
    expect(output).toContain('of');
    expect(output).toContain('sum += x');
  });

  it('handles for loop in body capture', () => {
    const block = parseStatement('{ let sum = 0; for (let i = 0; i < 3; i++) { sum += i; } return sum; }') as typescript.Block;
    const node = buildBodyCapture(block.statements);
    const output = printNode(node);
    expect(output).toContain('for');
    expect(output).toContain('i < 3');
    expect(output).toContain('sum += i');
  });

  it('handles while loop in body capture', () => {
    const block = parseStatement('{ let n = 0; while (n < 5) { n++; } return n; }') as typescript.Block;
    const node = buildBodyCapture(block.statements);
    const output = printNode(node);
    expect(output).toContain('while');
    expect(output).toContain('n < 5');
  });

  it('handles switch statement in body capture', () => {
    const block = parseStatement(
      '{ switch (val) { case 1: return "one"; case 2: return "two"; default: return "other"; } }',
    ) as typescript.Block;
    const node = buildBodyCapture(block.statements);
    const output = printNode(node);
    expect(output).toContain('switch');
    expect(output).toContain('case 1');
    expect(output).toContain('case 2');
    expect(output).toContain('default');
  });

  it('handles break and continue in body capture', () => {
    const block = parseStatement('{ for (const x of arr) { if (x < 0) { continue; } if (x > 10) { break; } } return 0; }') as typescript.Block;
    const node = buildBodyCapture(block.statements);
    const output = printNode(node);
    expect(output).toContain('continue');
    expect(output).toContain('break');
  });
});

describe('parseContractExpression', () => {
  it('returns a BinaryExpression node for a comparison', () => {
    const node = parseContractExpression('amount > 0');
    expect(typescript.isBinaryExpression(node)).toBe(true);
  });

  it('returns a PrefixUnaryExpression for a negation', () => {
    const node = parseContractExpression('!flag');
    expect(typescript.isPrefixUnaryExpression(node)).toBe(true);
  });

  it('throws for an empty string', () => {
    expect(() => parseContractExpression('')).toThrow();
  });
});

describe('buildBodyCapture with this keyword', () => {
  it('handles this.property in body capture', () => {
    const src = '{ this.balance -= amount; return this.balance; }';
    const block = parseStatement(src) as typescript.Block;
    const node = buildBodyCapture(block.statements);
    const output = printNode(node);
    expect(output).toContain('this.balance');
    expect(output).toContain(`const ${AXIOM_RESULT_VAR}`);
  });
});
