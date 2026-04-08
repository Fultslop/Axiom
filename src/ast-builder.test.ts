import typescript from 'typescript';
import { buildPreCheck, buildBodyCapture, buildPostCheck, buildResultReturn } from './ast-builder';

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
  it('wraps expression in negated if and throws ContractViolationError', () => {
    const node = buildPostCheck('result >= 0', 'Account.deposit');
    const output = printNode(node);
    expect(output).toContain('!(result >= 0)');
    expect(output).toContain('"POST"');
    expect(output).toContain('"result >= 0"');
    expect(output).toContain('"Account.deposit"');
  });
});

describe('buildBodyCapture', () => {
  it('wraps original statements in an IIFE assigned to const result', () => {
    const originalBody = parseStatement('{ x = 1; return x; }') as typescript.Block;
    const node = buildBodyCapture(originalBody.statements);
    const output = printNode(node);
    expect(output).toContain('const result');
    expect(output).toContain('=>');
    expect(output).toContain('x = 1');
  });
});

describe('buildResultReturn', () => {
  it('produces return result statement', () => {
    const node = buildResultReturn();
    const output = printNode(node);
    expect(output).toContain('return result');
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
});

describe('buildBodyCapture with this keyword', () => {
  it('handles this.property in body capture', () => {
    const src = '{ this.balance -= amount; return this.balance; }';
    const block = parseStatement(src) as typescript.Block;
    const node = buildBodyCapture(block.statements);
    const output = printNode(node);
    expect(output).toContain('this.balance');
    expect(output).toContain('const result');
  });
});
