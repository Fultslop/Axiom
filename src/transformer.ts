import typescript from 'typescript';
import { buildReparsedIndex, type ReparsedIndex } from './reparsed-index';
import {
  tryRewriteFunction, isPublicTarget, normaliseArrowBody, type KeepContracts,
  shouldEmitPre, shouldEmitPost,
} from './function-rewriter';
import { tryRewriteClass } from './class-rewriter';
import { buildRequireStatement } from './require-injection';
import type { ParamMismatchMode } from './interface-resolver';
import {
  extractContractTags,
  extractContractTagsFromNode,
  extractInvariantExpressions,
} from './jsdoc-parser';
import { isExportedVariableInitialiser } from './node-helpers';

const MODE_IGNORE = 'ignore' as const;
const DIRECTIVE_PREFIX = '// @axiom keepContracts' as const;
const DIRECTIVE_ALL = 'all' as const;
const DIRECTIVE_PRE = 'pre' as const;
const DIRECTIVE_POST = 'post' as const;
const DIRECTIVE_INVARIANT = 'invariant' as const;

// ---------------------------------------------------------------------------
// File-level directive
// ---------------------------------------------------------------------------

function readFileDirective(
  sourceFile: typescript.SourceFile,
): KeepContracts | undefined {
  const fullText = sourceFile.getFullText();
  const lines = fullText.split('\n');
  const firstLine = lines[0] ?? '';
  const trimmed = firstLine.trim();
  if (!trimmed.startsWith(DIRECTIVE_PREFIX)) {
    return undefined;
  }
  const qualifier = trimmed.slice(DIRECTIVE_PREFIX.length).trim();
  if (qualifier === '' || qualifier === DIRECTIVE_ALL) {
    return DIRECTIVE_ALL;
  }
  if (qualifier === DIRECTIVE_PRE) {
    return DIRECTIVE_PRE;
  }
  if (qualifier === DIRECTIVE_POST) {
    return DIRECTIVE_POST;
  }
  if (qualifier === DIRECTIVE_INVARIANT) {
    return DIRECTIVE_INVARIANT;
  }
  return undefined;
}

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

const CONTRACT_KIND_PRE = 'pre' as const;
const CONTRACT_KIND_POST = 'post' as const;

function resolveTagsForDropCheck(
  node: typescript.Node,
  reparsedFunctions: Map<number, typescript.FunctionLikeDeclaration>,
): ReturnType<typeof extractContractTagsFromNode> {
  // Original AST nodes from the compiler pipeline are created without
  // setParentNodes, so getJSDocTags() returns nothing on them. Look up the
  // reparsed counterpart (which is created with setParentNodes:true) instead.
  if (typescript.isFunctionLike(node)) {
    const reparsed = reparsedFunctions.get(node.pos)
      ?? (node as typescript.FunctionLikeDeclaration);
    return extractContractTags(reparsed);
  }
  if (typescript.isVariableStatement(node)) {
    const init = node.declarationList.declarations[0]?.initializer;
    if (
      init !== undefined &&
      (typescript.isArrowFunction(init) || typescript.isFunctionExpression(init))
    ) {
      const reparsed = reparsedFunctions.get(init.pos) ?? init;
      return extractContractTags(reparsed);
    }
  }
  return [];
}

function hasValidationDroppedContracts(
  node: typescript.Node,
  keepContracts: KeepContracts,
  reparsedFunctions: Map<number, typescript.FunctionLikeDeclaration>,
): boolean {
  const tags = resolveTagsForDropCheck(node, reparsedFunctions);
  const hasPre = shouldEmitPre(keepContracts)
    && tags.some((tag) => tag.kind === CONTRACT_KIND_PRE);
  const hasPost = shouldEmitPost(keepContracts)
    && tags.some((tag) => tag.kind === CONTRACT_KIND_POST);
  return hasPre || hasPost;
}

function nodeToEmitForFunction(
  factory: typescript.NodeFactory,
  node: typescript.FunctionDeclaration,
  rewritten: typescript.FunctionLikeDeclaration,
  keepContracts: KeepContracts,
  reparsedFunctions: Map<number, typescript.FunctionLikeDeclaration>,
): typescript.FunctionLikeDeclaration {
  const contractsDropped = hasValidationDroppedContracts(node, keepContracts, reparsedFunctions);
  if (rewritten !== node || !contractsDropped) {
    return rewritten;
  }
  // Return a synthetic node (pos=-1) so the printer cannot look up
  // the original JSDoc from source text.
  return factory.createFunctionDeclaration(
    typescript.getModifiers(node),
    node.asteriskToken,
    node.name,
    node.typeParameters,
    node.parameters,
    node.type,
    node.body,
  );
}

function isExportedStatement(node: typescript.Node): boolean {
  const mods = typescript.canHaveModifiers(node)
    ? typescript.getModifiers(node) ?? []
    : [];
  return mods.some((mod) => mod.kind === typescript.SyntaxKind.ExportKeyword);
}

// ---------------------------------------------------------------------------
// Variable declaration helpers
// ---------------------------------------------------------------------------

function rewriteVariableDeclaration(
  factory: typescript.NodeFactory,
  decl: typescript.VariableDeclaration,
  reparsedIndex: ReparsedIndex,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker: typescript.TypeChecker | undefined,
  allowIdentifiers: string[],
  keepContracts: KeepContracts,
): typescript.VariableDeclaration {
  const init = decl.initializer;
  if (init === undefined) {
    return decl;
  }
  if (
    !typescript.isArrowFunction(init) &&
    !typescript.isFunctionExpression(init)
  ) {
    return decl;
  }
  if (!isExportedVariableInitialiser(init)) {
    return decl;
  }
  let funcNode: typescript.FunctionLikeDeclaration | undefined;
  if (typescript.isArrowFunction(init)) {
    funcNode = normaliseArrowBody(factory, init);
  } else {
    funcNode = init;
  }
  const rewritten = tryRewriteFunction(
    factory,
    funcNode,
    reparsedIndex.functions,
    transformed,
    warn,
    checker,
    [],
    undefined,
    allowIdentifiers,
    keepContracts,
    init,
  );
  if (rewritten === funcNode) {
    return decl;
  }
  return factory.updateVariableDeclaration(
    decl,
    decl.name,
    decl.exclamationToken,
    decl.type,
    rewritten as typescript.Expression,
  );
}

function visitVariableStatement(
  factory: typescript.NodeFactory,
  node: typescript.VariableStatement,
  reparsedIndex: ReparsedIndex,
  transformed: { value: boolean },
  warn: (msg: string) => void,
  checker: typescript.TypeChecker | undefined,
  allowIdentifiers: string[],
  keepContracts: KeepContracts,
): typescript.VariableStatement {
  const modifiers = typescript.canHaveModifiers(node)
    ? typescript.getModifiers(node) ?? []
    : [];
  const isExported = modifiers.some(
    (mod) => mod.kind === typescript.SyntaxKind.ExportKeyword,
  );
  if (!isExported) {
    return node;
  }
  const newDeclarations = node.declarationList.declarations.map((decl) =>
    rewriteVariableDeclaration(
      factory, decl, reparsedIndex, transformed, warn, checker, allowIdentifiers,
      keepContracts,
    ),
  );
  const changed = newDeclarations.some(
    (decl, idx) => decl !== node.declarationList.declarations[idx],
  );
  if (!changed) {
    if (hasValidationDroppedContracts(node, keepContracts, reparsedIndex.functions)) {
      // Return a synthetic VariableStatement (pos=-1) so the printer cannot
      // look up the original JSDoc from source text.
      return factory.createVariableStatement(
        modifiers,
        factory.createVariableDeclarationList(
          node.declarationList.declarations,
          node.declarationList.flags,
        ),
      );
    }
    return node;
  }
  const newDeclList = factory.updateVariableDeclarationList(
    node.declarationList,
    newDeclarations,
  );
  return factory.updateVariableStatement(node, modifiers, newDeclList);
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
  keepContracts: KeepContracts,
): typescript.Node {
  if (typescript.isClassDeclaration(node)) {
    return tryRewriteClass(
      factory, node, reparsedIndex, transformed, warn,
      checker, reparsedCache, paramMismatch, allowIdentifiers, keepContracts,
    );
  }

  emitMisuseWarnings(node, warn);

  if (typescript.isFunctionDeclaration(node)) {
    if (isPublicTarget(node)) {
      const rewritten = tryRewriteFunction(
        factory,
        node,
        reparsedIndex.functions,
        transformed,
        warn,
        checker,
        [],
        undefined,
        allowIdentifiers,
        keepContracts,
      );
      const nodeToEmit = nodeToEmitForFunction(
        factory, node, rewritten, keepContracts, reparsedIndex.functions,
      );
      return typescript.visitEachChild(
        nodeToEmit,
        (child) => visitNode(
          factory, child, context, reparsedIndex, transformed, warn,
          checker, reparsedCache, paramMismatch, allowIdentifiers, keepContracts,
        ),
        context,
      );
    }
    emitUnsupportedClosureWarning(node, warn);
  }

  if (
    (typescript.isArrowFunction(node) || typescript.isFunctionExpression(node)) &&
    node.parent?.kind !== typescript.SyntaxKind.VariableDeclaration
  ) {
    emitUnsupportedExpressionWarning(node, warn);
  }

  if (typescript.isVariableStatement(node) && isExportedStatement(node)) {
    return visitVariableStatement(
      factory,
      node,
      reparsedIndex,
      transformed,
      warn,
      checker,
      allowIdentifiers,
      keepContracts,
    );
  }

  return typescript.visitEachChild(
    node,
    (child) => visitNode(
      factory, child, context, reparsedIndex, transformed, warn,
      checker, reparsedCache, paramMismatch, allowIdentifiers, keepContracts,
    ),
    context,
  );
}

function resolveKeepContracts(
  raw: boolean | 'pre' | 'post' | 'invariant' | 'all' | undefined,
): KeepContracts {
  if (raw === true) {
    return 'all';
  }
  return raw || false;
}

// ---------------------------------------------------------------------------
// Per-file transformation
// ---------------------------------------------------------------------------

function transformSourceFile(
  sourceFile: typescript.SourceFile,
  context: typescript.TransformationContext,
  nodeFactory: typescript.NodeFactory,
  baseKeepContracts: KeepContracts,
  reparsedCache: Map<string, typescript.SourceFile>,
  warn: (msg: string) => void,
  checker: typescript.TypeChecker | undefined,
  paramMismatch: ParamMismatchMode,
  allowIdentifiers: string[],
): typescript.SourceFile {
  const fileDirective = readFileDirective(sourceFile);
  const effectiveKeepContracts: KeepContracts = fileDirective !== undefined
    ? fileDirective
    : baseKeepContracts;
  const reparsedIndex = buildReparsedIndex(sourceFile);
  const transformed = { value: false };
  const visited = typescript.visitEachChild(
    sourceFile,
    (node) => visitNode(
      nodeFactory, node, context, reparsedIndex, transformed, warn,
      checker, reparsedCache, paramMismatch, allowIdentifiers,
      effectiveKeepContracts,
    ),
    context,
  );
  if (!transformed.value) {
    return visited;
  }
  const importDecl = buildRequireStatement(nodeFactory, context.getCompilerOptions().module);
  return nodeFactory.updateSourceFile(visited, [importDecl, ...Array.from(visited.statements)]);
}

// ---------------------------------------------------------------------------
// Transformer entry point
// ---------------------------------------------------------------------------

export type TransformerOptions = {
  warn?: (msg: string) => void;
  interfaceParamMismatch?: 'rename' | 'ignore';
  allowIdentifiers?: string[];
  keepContracts?: boolean | 'pre' | 'post' | 'invariant' | 'all';
};

type ResolvedOptions = {
  warn: (msg: string) => void;
  paramMismatch: ParamMismatchMode;
  allowIdentifiers: string[];
  keepContracts: KeepContracts;
};

function resolveTransformerOptions(
  options: TransformerOptions | undefined,
): ResolvedOptions {
  const warn = options?.warn ?? ((msg: string): void => {
    process.stderr.write(`${msg}\n`);
  });
  const rawMode = options?.interfaceParamMismatch;
  const paramMismatch: ParamMismatchMode = rawMode === MODE_IGNORE ? 'ignore' : 'rename';
  const allowIdentifiers = options?.allowIdentifiers ?? [];
  const keepContracts = resolveKeepContracts(options?.keepContracts);
  return { warn, paramMismatch, allowIdentifiers, keepContracts };
}

// ts-patch plugin entry point. program is optional so the transformer can
// also be used in transpileModule() for unit testing.
export default function createTransformer(
  _program?: typescript.Program,
  options?: TransformerOptions,
): typescript.TransformerFactory<typescript.SourceFile> {
  const { warn, paramMismatch, allowIdentifiers, keepContracts } =
    resolveTransformerOptions(options);
  const checker = _program?.getTypeChecker?.();
  const reparsedCache = new Map<string, typescript.SourceFile>();

  return (context: typescript.TransformationContext) => {
    // Use the compiler's own factory so synthesized nodes are compatible
    // with the AST nodes created by the host TypeScript instance.
    const { factory: nodeFactory } = context;
    return (sourceFile: typescript.SourceFile): typescript.SourceFile =>
      transformSourceFile(
        sourceFile, context, nodeFactory, keepContracts, reparsedCache,
        warn, checker, paramMismatch, allowIdentifiers,
      );
  };
}

// ts-jest v29+ requires these named exports on AST transformers.
export const name = 'axiom-transformer';
export const version = 1;
export const factory = (
  _ts: typeof typescript,
  opts?: Parameters<typeof createTransformer>[1],
  program?: typescript.Program,
): typescript.TransformerFactory<typescript.SourceFile> => createTransformer(program, opts);

