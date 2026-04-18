import typescript from 'typescript';
import { parseContractExpression } from './ast-builder';

export const KIND_PRE = 'pre' as const;
export const KIND_POST = 'post' as const;
export const PREV_ID = 'prev' as const;

const RESULT_ID = 'result' as const;

export function expressionUsesResult(expression: string): boolean {
  try {
    const parsed = parseContractExpression(expression);
    let found = false;
    function walk(node: typescript.Node): void {
      if (!found) {
        if (typescript.isIdentifier(node) && node.text === RESULT_ID) {
          found = true;
        } else {
          typescript.forEachChild(node, walk);
        }
      }
    }
    walk(parsed);
    return found;
  } catch {
    return false;
  }
}

export function expressionUsesPrev(expression: string): boolean {
  try {
    const parsed = parseContractExpression(expression);
    let found = false;
    function walk(node: typescript.Node): void {
      if (!found) {
        if (typescript.isIdentifier(node) && node.text === PREV_ID) {
          found = true;
        } else {
          typescript.forEachChild(node, walk);
        }
      }
    }
    walk(parsed);
    return found;
  } catch {
    return false;
  }
}
