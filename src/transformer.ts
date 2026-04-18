import typescript from 'typescript';
import { buildReparsedIndex } from './reparsed-index';
import {
  tryRewriteFunction, isPublicTarget, normaliseArrowBody,
} from './function-rewriter';
import { type KeepContracts, shouldEmitPre, shouldEmitPost } from './keep-contracts';
import { tryRewriteClass } from './class-rewriter';
import { buildRequireStatement } from './require-injection';
import type { ParamMismatchMode } from './interface-resolver';
import type { TransformerContext } from './transformer-context';
import {
  extractContractTags,
  extractContractTagsFromNode,
  extractInvariantExpressions,
} from './jsdoc-parser';
import { isExportedVariableInitialiser, nodeSourceLocation } from './node-helpers';
import { isNestedSupportedForm, isIIFEPattern, isIIFESupportedForm } from './tag-pipeline';

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
    node.parent &&
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
      const loc = nodeSourceLocation(node);
      const suffix = loc !== '' ? ` (${loc})` : '';
      warn(
        '[axiom] Warning: @invariant is only supported on class declarations'
        + ` — tag has no effect (in ${nodeName}${suffix})`,
      );
    }
  }
}

function emitUnsupportedFunctionWarning(
  node: typescript.Node,
  name: string,
  warn: (msg: string) => void,
): void {
  const loc = nodeSourceLocation(node);
  const suffix = loc !== '' ? ` (${loc})` : '';
  warn(
    '[axiom] Warning: @pre/@post on arrow functions, function expressions, and closures'
    + ` is not supported — contracts were not injected (in ${name}${suffix})`,
  );
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
  decl: typescript.VariableDeclaration,
  ctx: TransformerContext,
): typescript.VariableDeclaration {
  const { factory } = ctx;
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
  const rewritten = tryRewriteFunction(funcNode, ctx, [], undefined, init);
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
  node: typescript.VariableStatement,
  ctx: TransformerContext,
): typescript.VariableStatement {
  const { factory, keepContracts } = ctx;
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
    rewriteVariableDeclaration(decl, ctx),
  );
  const changed = newDeclarations.some(
    (decl, idx) => decl !== node.declarationList.declarations[idx],
  );
  if (!changed) {
    if (hasValidationDroppedContracts(node, keepContracts, ctx.reparsedIndex.functions)) {
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

// eslint-disable-next-line complexity
function visitNode(
  node: typescript.Node,
  tsContext: typescript.TransformationContext,
  ctx: TransformerContext,
): typescript.Node {
  const { factory, warn, keepContracts } = ctx;

  if (typescript.isClassDeclaration(node)) {
    return tryRewriteClass(node, ctx);
  }

  emitMisuseWarnings(node, warn);

  if (typescript.isFunctionDeclaration(node)) {
    if (isPublicTarget(node)) {
      const rewritten = tryRewriteFunction(node, ctx);
      const nodeToEmit = nodeToEmitForFunction(
        factory, node, rewritten, keepContracts, ctx.reparsedIndex.functions,
      );
      return typescript.visitEachChild(
        nodeToEmit,
        (child) => visitNode(child, tsContext, ctx),
        tsContext,
      );
    }
    if (extractContractTagsFromNode(node).length > 0 && !isNestedSupportedForm(node)) {
      emitUnsupportedFunctionWarning(node, node.name?.text ?? '(anonymous)', warn);
    }
    return typescript.visitEachChild(
      node,
      (child) => visitNode(child, tsContext, ctx),
      tsContext,
    );
  }

  if (
    (typescript.isArrowFunction(node) || typescript.isFunctionExpression(node)) &&
    node.parent?.kind !== typescript.SyntaxKind.VariableDeclaration
  ) {
    if (extractContractTagsFromNode(node).length > 0 && !isNestedSupportedForm(node)) {
      emitUnsupportedFunctionWarning(node, resolveDisplayName(node), warn);
    }
  }

  // IIFEs (e.g. `/** @pre */ ((x) => {})(1)`) -- getJSDocTags does not reliably
  // attach to CallExpression nodes. Detect them structurally and emit the warning
  // only when they are not supported nested forms (i.e. not returned arrows).
  // Skip synthetic nodes (pos === -1): the @post result-capture IIFE is a
  // synthetic CallExpression created by ast-builder and must not trigger this warning.
  if (node.pos !== -1 && isIIFEPattern(node) && !isIIFESupportedForm(node)) {
    emitUnsupportedFunctionWarning(node, '(anonymous IIFE)', warn);
  }

  if (typescript.isVariableStatement(node) && isExportedStatement(node)) {
    return visitVariableStatement(node, ctx);
  }

  return typescript.visitEachChild(
    node,
    (child) => visitNode(child, tsContext, ctx),
    tsContext,
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
  tsContext: typescript.TransformationContext,
  baseCtx: TransformerContext,
): typescript.SourceFile {
  const fileDirective = readFileDirective(sourceFile);
  const ctx: TransformerContext = {
    ...baseCtx,
    keepContracts: fileDirective ?? baseCtx.keepContracts,
    reparsedIndex: buildReparsedIndex(sourceFile),
    transformed: { value: false },
  };

  const visited = typescript.visitEachChild(
    sourceFile,
    (node) => visitNode(node, tsContext, ctx),
    tsContext,
  );
  if (!ctx.transformed.value) {
    return visited;
  }
  const importDecl = buildRequireStatement(ctx.factory, tsContext.getCompilerOptions().module);
  return ctx.factory.updateSourceFile(visited, [importDecl, ...Array.from(visited.statements)]);
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

  return (tsContext: typescript.TransformationContext) => {
    const baseCtx: TransformerContext = {
      factory: tsContext.factory,
      warn,
      checker,
      allowIdentifiers,
      keepContracts,
      paramMismatch,
      reparsedIndex: { functions: new Map(), classes: new Map() }, // replaced per file
      reparsedCache,
      transformed: { value: false },                               // replaced per file
    };
    return (sourceFile: typescript.SourceFile): typescript.SourceFile =>
      transformSourceFile(sourceFile, tsContext, baseCtx);
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

