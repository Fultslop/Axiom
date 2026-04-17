import typescript from 'typescript';
import { buildReparsedIndex, type ReparsedIndex } from './reparsed-index';
import {
  tryRewriteFunction, isPublicTarget, normaliseArrowBody, type KeepContracts,
} from './function-rewriter';
import { tryRewriteClass } from './class-rewriter';
import { buildRequireStatement } from './require-injection';
import type { ParamMismatchMode } from './interface-resolver';
import {
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
      return typescript.visitEachChild(
        rewritten,
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
    keepContracts?: boolean | 'pre' | 'post' | 'invariant' | 'all';
  },
): typescript.TransformerFactory<typescript.SourceFile> {
  const warn = options?.warn ?? ((msg: string): void => {
    process.stderr.write(`${msg}\n`);
  });
  const rawMode = options?.interfaceParamMismatch;
  const paramMismatch: ParamMismatchMode = rawMode === MODE_IGNORE ? 'ignore' : 'rename';
  const checker = _program?.getTypeChecker?.();
  const allowIdentifiers = options?.allowIdentifiers ?? [];
  const keepContracts = resolveKeepContracts(options?.keepContracts);
  const reparsedCache = new Map<string, typescript.SourceFile>();

  return (context: typescript.TransformationContext) => {
    // Use the compiler's own factory so synthesized nodes are compatible
    // with the AST nodes created by the host TypeScript instance.
    const { factory } = context;

    return (sourceFile: typescript.SourceFile): typescript.SourceFile => {
      const fileDirective = readFileDirective(sourceFile);
      const effectiveKeepContracts: KeepContracts = fileDirective !== undefined
        ? fileDirective
        : keepContracts;
      const reparsedIndex = buildReparsedIndex(sourceFile);
      const transformed = { value: false };
      const visited = typescript.visitEachChild(
        sourceFile,
        (node) => visitNode(
          factory, node, context, reparsedIndex, transformed, warn,
          checker, reparsedCache, paramMismatch, allowIdentifiers,
          effectiveKeepContracts,
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

