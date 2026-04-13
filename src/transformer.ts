import typescript from 'typescript';
import { buildReparsedIndex, type ReparsedIndex } from './reparsed-index';
import { tryRewriteFunction, isPublicTarget } from './function-rewriter';
import { tryRewriteClass } from './class-rewriter';
import { buildRequireStatement } from './require-injection';
import type { ParamMismatchMode } from './interface-resolver';
import {
  extractContractTagsFromNode,
  extractInvariantExpressions,
} from './jsdoc-parser';

const MODE_IGNORE = 'ignore' as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveDisplayName(node: typescript.Node): string {
  if (
    typescript.isVariableDeclaration(node.parent) &&
    typescript.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  return '(anonymous)';
}

function extractNodeName(node: typescript.Node): string {
  if (
    typescript.isFunctionDeclaration(node) ||
    typescript.isInterfaceDeclaration(node) ||
    typescript.isClassDeclaration(node)
  ) {
    return (node as { name?: typescript.Identifier }).name?.text ?? '(anonymous)';
  }
  if (typescript.isVariableStatement(node)) {
    const firstDecl = node.declarationList.declarations[0];
    if (firstDecl && typescript.isIdentifier(firstDecl.name)) {
      return firstDecl.name.text;
    }
  }
  return '(anonymous)';
}

function emitMisuseWarnings(node: typescript.Node, warn: (msg: string) => void): void {
  if (!typescript.isClassDeclaration(node)) {
    const invariantExprs = extractInvariantExpressions(node);
    if (invariantExprs.length > 0) {
      const nodeName = extractNodeName(node);
      warn(
        '[axiom] Warning: @invariant is only supported on class declarations'
        + ` — tag has no effect (in ${nodeName})`,
      );
    }
  }
}

function emitUnsupportedClosureWarning(
  node: typescript.FunctionDeclaration,
  warn: (msg: string) => void,
): void {
  const contractTags = extractContractTagsFromNode(node);
  if (contractTags.length > 0) {
    const funcName = node.name?.text ?? '(anonymous)';
    warn(
      '[axiom] Warning: @pre/@post on arrow functions, function expressions, and closures'
      + ` is not supported — contracts were not injected (in ${funcName})`,
    );
  }
}

function emitUnsupportedExpressionWarning(
  node: typescript.ArrowFunction | typescript.FunctionExpression,
  warn: (msg: string) => void,
): void {
  const contractTags = extractContractTagsFromNode(node);
  if (contractTags.length > 0) {
    const displayName = resolveDisplayName(node);
    warn(
      '[axiom] Warning: @pre/@post on arrow functions, function expressions, and closures'
      + ` is not supported — contracts were not injected (in ${displayName})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Node visitor
// ---------------------------------------------------------------------------

function visitNode(
  factory: typescript.NodeFactory,
  node: typescript.Node,
  context: typescript.TransformationContext,
  reparsedIndex: ReparsedIndex,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker: typescript.TypeChecker | undefined,
  reparsedCache: Map<string, typescript.SourceFile>,
  paramMismatch: ParamMismatchMode,
  allowIdentifiers: string[],
): typescript.Node {
  if (typescript.isClassDeclaration(node)) {
    return tryRewriteClass(
      factory, node, reparsedIndex, transformed, warn,
      checker, reparsedCache, paramMismatch, allowIdentifiers,
    );
  }

  emitMisuseWarnings(node, warn);

  if (
    typescript.isFunctionDeclaration(node) &&
    isPublicTarget(node as typescript.FunctionLikeDeclaration)
  ) {
    const rewritten = tryRewriteFunction(
      factory,
      node as typescript.FunctionLikeDeclaration,
      reparsedIndex.functions,
      transformed,
      warn,
      checker,
      [],
      undefined,
      allowIdentifiers,
    );
    return typescript.visitEachChild(
      rewritten,
      (child) => visitNode(
        factory, child, context, reparsedIndex, transformed, warn,
        checker, reparsedCache, paramMismatch, allowIdentifiers,
      ),
      context,
    );
  }

  if (
    typescript.isFunctionDeclaration(node) &&
    !isPublicTarget(node as typescript.FunctionLikeDeclaration)
  ) {
    emitUnsupportedClosureWarning(node, warn);
  }

  if (typescript.isArrowFunction(node) || typescript.isFunctionExpression(node)) {
    emitUnsupportedExpressionWarning(node, warn);
  }

  return typescript.visitEachChild(
    node,
    (child) => visitNode(
      factory, child, context, reparsedIndex, transformed, warn,
      checker, reparsedCache, paramMismatch, allowIdentifiers,
    ),
    context,
  );
}

// ---------------------------------------------------------------------------
// Transformer entry point
// ---------------------------------------------------------------------------

// ts-patch plugin entry point. program is optional so the transformer can
// also be used in transpileModule() for unit testing.
export default function createTransformer(
  _program?: typescript.Program,
  options?: {
    warn?: (msg: string) => void;
    interfaceParamMismatch?: 'rename' | 'ignore';
    allowIdentifiers?: string[];
  },
): typescript.TransformerFactory<typescript.SourceFile> {
  const warn = options?.warn ?? ((msg: string): void => {
    process.stderr.write(`${msg}\n`);
  });
  const rawMode = options?.interfaceParamMismatch;
  const paramMismatch: ParamMismatchMode = rawMode === MODE_IGNORE ? 'ignore' : 'rename';
  const checker = _program?.getTypeChecker?.();
  const allowIdentifiers = options?.allowIdentifiers ?? [];
  const reparsedCache = new Map<string, typescript.SourceFile>();

  return (context: typescript.TransformationContext) => {
    // Use the compiler's own factory so synthesized nodes are compatible
    // with the AST nodes created by the host TypeScript instance.
    const { factory } = context;

    return (sourceFile: typescript.SourceFile): typescript.SourceFile => {
      const reparsedIndex = buildReparsedIndex(sourceFile);
      const transformed = { value: false };
      const visited = typescript.visitEachChild(
        sourceFile,
        (node) => visitNode(
          factory, node, context, reparsedIndex, transformed, warn,
          checker, reparsedCache, paramMismatch, allowIdentifiers,
        ),
        context,
      );

      if (!transformed.value) {
        return visited;
      }

      const importDecl = buildRequireStatement(factory);
      return factory.updateSourceFile(visited, [importDecl, ...Array.from(visited.statements)]);
    };
  };
}

// Named export required by ts-jest's astTransformers pipeline.
export { createTransformer as factory };
