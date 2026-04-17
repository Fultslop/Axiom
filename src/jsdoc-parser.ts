import typescript from 'typescript';

export interface ContractTag {
  kind: 'pre' | 'post';
  expression: string;
}

const PRE_TAG = 'pre' as const;
const POST_TAG = 'post' as const;
const INVARIANT_TAG = 'invariant' as const;
const PREV_TAG = 'prev' as const;
const TYPE_STRING = 'string' as const;
const DEEP_MODE = 'deep' as const;

function isStringComment(
  comment: typescript.JSDocTag['comment'],
): comment is string {
  // eslint-disable-next-line valid-typeof
  return typeof comment === TYPE_STRING;
}

function resolveTagComment(comment: typescript.JSDocTag['comment']): string {
  if (isStringComment(comment)) {
    return comment.trim();
  }
  if (Array.isArray(comment)) {
    const commentArray = comment as Array<{
      text?: string;
    }>;
    const parts = commentArray.map((part) => {
      if (part.text !== undefined) {
        return part.text;
      }
      return '';
    });
    return parts.join('').trim();
  }
  return '';
}

function toContractKind(tagName: string): 'pre' | 'post' | undefined {
  if (tagName === PRE_TAG) {
    return PRE_TAG;
  }
  if (tagName === POST_TAG) {
    return POST_TAG;
  }
  return undefined;
}

export function extractInvariantExpressions(node: typescript.Node): string[] {
  const jsDocTags = typescript.getJSDocTags(node);
  const result: string[] = [];
  for (const tag of jsDocTags) {
    if (tag.tagName.text.toLowerCase() === INVARIANT_TAG) {
      const expression = resolveTagComment(tag.comment);
      if (expression.length > 0) {
        result.push(expression);
      }
    }
  }
  return result;
}

export function extractContractTagsFromNode(node: typescript.Node): ContractTag[] {
  const jsDocTags = typescript.getJSDocTags(node);
  const result: ContractTag[] = [];

  for (const tag of jsDocTags) {
    const kind = toContractKind(tag.tagName.text.toLowerCase());
    if (kind !== undefined) {
      const expression = resolveTagComment(tag.comment);
      if (expression.length > 0) {
        result.push({ kind, expression });
      }
    }
  }

  return result;
}

function extractContractTagsForFunctionLike(
  node: typescript.FunctionLikeDeclaration,
): ContractTag[] {
  const direct = extractContractTagsFromNode(node);
  if (direct.length > 0) {
    return direct;
  }
  // For ArrowFunction / FunctionExpression the JSDoc comment is attached to
  // the enclosing VariableStatement, not to the function node itself.
  if (
    (typescript.isArrowFunction(node) || typescript.isFunctionExpression(node)) &&
    typescript.isVariableDeclaration(node.parent) &&
    typescript.isVariableDeclarationList(node.parent.parent) &&
    typescript.isVariableStatement(node.parent.parent.parent)
  ) {
    return extractContractTagsFromNode(node.parent.parent.parent);
  }
  return [];
}

export function extractContractTags(
  node: typescript.FunctionLikeDeclaration,
): ContractTag[] {
  return extractContractTagsForFunctionLike(node);
}

export function extractPrevExpression(node: typescript.Node): string | undefined {
  const jsDocTags = typescript.getJSDocTags(node);
  for (const tag of jsDocTags) {
    if (tag.tagName.text.toLowerCase() === PREV_TAG) {
      const comment = resolveTagComment(tag.comment);
      if (comment.length === 0) {
        return undefined;
      }
      if (comment === DEEP_MODE) {
        return 'deepSnapshot(this)';
      }
      return comment;
    }
  }
  return undefined;
}
