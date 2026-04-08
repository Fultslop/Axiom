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
