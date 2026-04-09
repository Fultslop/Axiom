import typescript from 'typescript';
import { buildReparsedIndex, type ReparsedIndex } from './reparsed-index';
import { tryRewriteFunction, isPublicTarget } from './function-rewriter';
import { tryRewriteClass } from './class-rewriter';
import { buildRequireStatement } from './require-injection';

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
  checker?: typescript.TypeChecker,
): typescript.Node {
  if (typescript.isClassDeclaration(node)) {
    return tryRewriteClass(factory, node, reparsedIndex, transformed, warn, checker);
  }

  if (
    typescript.isFunctionDeclaration(node) &&
    isPublicTarget(node as typescript.FunctionLikeDeclaration)
  ) {
    return tryRewriteFunction(
      factory,
      node as typescript.FunctionLikeDeclaration,
      reparsedIndex.functions,
      transformed,
      warn,
      checker,
    );
  }

  return typescript.visitEachChild(
    node,
    (child) => visitNode(factory, child, context, reparsedIndex, transformed, warn, checker),
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
  options?: { warn?: (msg: string) => void },
): typescript.TransformerFactory<typescript.SourceFile> {
  const warn = options?.warn ?? ((msg: string): void => {
    process.stderr.write(`${msg}\n`);
  });
  const checker = _program?.getTypeChecker?.();
  return (context: typescript.TransformationContext) => {
    // Use the compiler's own factory so synthesized nodes are compatible
    // with the AST nodes created by the host TypeScript instance.
    const { factory } = context;

    return (sourceFile: typescript.SourceFile): typescript.SourceFile => {
      const reparsedIndex = buildReparsedIndex(sourceFile);
      const transformed = { value: false };
      const visited = typescript.visitEachChild(
        sourceFile,
        (node) => visitNode(factory, node, context, reparsedIndex, transformed, warn, checker),
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
