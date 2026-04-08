import typescript from 'typescript';
import { extractContractTags } from './jsdoc-parser';

function parseFunctionNode(source: string): typescript.FunctionLikeDeclaration {
  const sourceFile = typescript.createSourceFile(
    'test.ts',
    source,
    typescript.ScriptTarget.ES2020,
    true,
  );
  let found: typescript.FunctionLikeDeclaration | undefined;
  function visit(node: typescript.Node): void {
    if (typescript.isFunctionLike(node)) {
      found = node as typescript.FunctionLikeDeclaration;
    }
    typescript.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (!found) {
    throw new Error('No function found in source');
  }
  return found;
}

describe('extractContractTags', () => {
  it('returns empty array when no JSDoc tags', () => {
    const node = parseFunctionNode('function foo(xxx: number): number { return xxx; }');
    expect(extractContractTags(node)).toEqual([]);
  });

  it('extracts a single @pre tag', () => {
    const source = `
      /** @pre amount > 0 */
      function withdraw(amount: number): number { return amount; }
    `;
    const node = parseFunctionNode(source);
    const tags = extractContractTags(node);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toEqual({ kind: 'pre', expression: 'amount > 0' });
  });

  it('extracts a single @post tag', () => {
    const source = `
      /** @post result >= 0 */
      function deposit(amount: number): number { return amount; }
    `;
    const node = parseFunctionNode(source);
    const tags = extractContractTags(node);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toEqual({ kind: 'post', expression: 'result >= 0' });
  });

  it('extracts multiple @pre and @post tags', () => {
    const source = `
      /**
       * @pre amount > 0
       * @pre amount <= this.balance
       * @post result === this.balance
       */
      function withdraw(amount: number): number { return amount; }
    `;
    const node = parseFunctionNode(source);
    const tags = extractContractTags(node);
    expect(tags).toHaveLength(3);
    expect(tags[0]).toEqual({ kind: 'pre', expression: 'amount > 0' });
    expect(tags[1]).toEqual({ kind: 'pre', expression: 'amount <= this.balance' });
    expect(tags[2]).toEqual({ kind: 'post', expression: 'result === this.balance' });
  });

  it('ignores unrelated JSDoc tags', () => {
    const source = `
      /**
       * @param amount The amount
       * @returns The result
       * @pre amount > 0
       */
      function withdraw(amount: number): number { return amount; }
    `;
    const node = parseFunctionNode(source);
    const tags = extractContractTags(node);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toEqual({ kind: 'pre', expression: 'amount > 0' });
  });

  it('skips tags with empty expressions', () => {
    const source = `
      /**
       * @pre
       * @post result > 0
       */
      function foo(xxx: number): number { return xxx; }
    `;
    const node = parseFunctionNode(source);
    const tags = extractContractTags(node);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toEqual({ kind: 'post', expression: 'result > 0' });
  });
});
