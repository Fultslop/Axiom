import typescript from 'typescript';
import {
  extractContractTagsFromNode, extractInvariantExpressions,
  extractPrevExpression,
} from './jsdoc-parser';
import type { ContractTag } from './jsdoc-parser';

export type ParamMismatchMode = 'rename' | 'ignore';

const KIND_PRE = 'pre' as const;
const KIND_POST = 'post' as const;
const MODE_RENAME = 'rename' as const;
const MODE_IGNORE = 'ignore' as const;
const ACTION_RENAMED = 'expression renamed' as const;
const ACTION_SKIPPED = 'contract skipped' as const;

export interface InterfaceMethodContracts {
  preTags: ContractTag[];
  postTags: ContractTag[];
  sourceInterface: string;
  prevExpression?: string;
}

export interface InterfaceContracts {
  methods: Map<string, InterfaceMethodContracts>;
  invariants: string[];
}

function reparseCached(
  sourceFile: typescript.SourceFile,
  cache: Map<string, typescript.SourceFile>,
): typescript.SourceFile {
  const cached = cache.get(sourceFile.fileName);
  if (cached !== undefined) {
    return cached;
  }
  const reparsed = typescript.createSourceFile(
    sourceFile.fileName,
    sourceFile.text,
    sourceFile.languageVersion,
    true,
  );
  cache.set(sourceFile.fileName, reparsed);
  return reparsed;
}

function buildRenameMap(
  ifaceParams: string[],
  classParams: string[],
): Map<string, string> {
  const renameMap = new Map<string, string>();
  ifaceParams.forEach((ifaceParam, idx) => {
    const classParam = classParams[idx];
    if (
      ifaceParam.length > 0 &&
      classParam !== undefined &&
      ifaceParam !== classParam
    ) {
      renameMap.set(ifaceParam, classParam);
    }
  });
  return renameMap;
}

function renameIdentifiersInExpression(
  expression: string,
  renameMap: Map<string, string>,
): string {
  let result = expression;
  for (const [oldName, newName] of renameMap.entries()) {
    const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'g');
    result = result.replace(regex, newName);
  }
  return result;
}

function findInterfaceByPos(
  sourceFile: typescript.SourceFile,
  pos: number,
): typescript.InterfaceDeclaration | undefined {
  let found: typescript.InterfaceDeclaration | undefined;
  function visit(node: typescript.Node): void {
    if (found === undefined && typescript.isInterfaceDeclaration(node)) {
      if (node.pos === pos) {
        found = node;
      }
    }
    if (found === undefined) {
      typescript.forEachChild(node, visit);
    }
  }
  visit(sourceFile);
  return found;
}

function getClassMethodParams(
  member: typescript.MethodDeclaration,
): string[] {
  return Array.from(member.parameters).map((param) =>
    typescript.isIdentifier(param.name) ? param.name.text : '',
  );
}

function getInterfaceMethodParams(
  sig: typescript.MethodSignature,
): string[] {
  return Array.from(sig.parameters).map((param) =>
    typescript.isIdentifier(param.name) ? param.name.text : '',
  );
}

function applyRenameToTags(
  tags: ContractTag[],
  renameMap: Map<string, string>,
): ContractTag[] {
  return tags.map((tag) => ({
    ...tag,
    expression: renameIdentifiersInExpression(tag.expression, renameMap),
  }));
}

function findMethodSignature(
  interfaceNode: typescript.InterfaceDeclaration,
  methodName: string,
): typescript.MethodSignature | undefined {
  return Array.from(interfaceNode.members).find(
    (member): member is typescript.MethodSignature =>
      typescript.isMethodSignature(member) &&
      typescript.isIdentifier(member.name) &&
      member.name.text === methodName,
  );
}

function handleParamMismatch(
  ifaceName: string,
  location: string,
  ifaceParams: string[],
  classParams: string[],
  mode: ParamMismatchMode,
  warn: (msg: string) => void,
): { renameMap: Map<string, string>; shouldSkip: boolean } {
  const renameMap = buildRenameMap(ifaceParams, classParams);
  if (renameMap.size === 0) {
    return { renameMap, shouldSkip: false };
  }
  const pairs = Array.from(renameMap.entries())
    .map(([from, to]) => `'${from}' → '${to}'`)
    .join(', ');
  const action = mode === MODE_RENAME ? ACTION_RENAMED : ACTION_SKIPPED;
  warn(
    `[axiom] Parameter name mismatch in ${location}:`
    + `\n  interface ${ifaceName}: ${pairs} — ${action}`,
  );
  if (mode === MODE_IGNORE) {
    return { renameMap, shouldSkip: true };
  }
  return { renameMap, shouldSkip: false };
}

function buildContractsResult(
  preTags: ContractTag[],
  postTags: ContractTag[],
  prevExpr: string | undefined,
  renameMap: Map<string, string>,
  hasMismatch: boolean,
  mode: ParamMismatchMode,
  ifaceName: string,
): InterfaceMethodContracts {
  const baseContracts = { preTags, postTags, sourceInterface: ifaceName };
  if (hasMismatch && mode === MODE_RENAME) {
    const renamedTags = {
      preTags: applyRenameToTags(preTags, renameMap),
      postTags: applyRenameToTags(postTags, renameMap),
      sourceInterface: ifaceName,
    };
    return prevExpr !== undefined
      ? { ...renamedTags, prevExpression: prevExpr }
      : renamedTags;
  }
  return prevExpr !== undefined
    ? { ...baseContracts, prevExpression: prevExpr }
    : baseContracts;
}

function extractMethodContracts(
  interfaceNode: typescript.InterfaceDeclaration,
  methodName: string,
  classParams: string[],
  mode: ParamMismatchMode,
  ifaceName: string,
  location: string,
  warn: (msg: string) => void,
): InterfaceMethodContracts | undefined {
  const sig = findMethodSignature(interfaceNode, methodName);
  if (sig === undefined) {
    return undefined;
  }

  const ifaceParams = getInterfaceMethodParams(sig);
  if (ifaceParams.length !== classParams.length) {
    warn(
      `[axiom] Parameter count mismatch in ${location}:`
      + `\n  interface ${ifaceName} has ${ifaceParams.length} parameters,`
      + ` class has ${classParams.length} — interface contracts skipped`,
    );
    return { preTags: [], postTags: [], sourceInterface: ifaceName };
  }

  const { renameMap, shouldSkip } = handleParamMismatch(
    ifaceName, location, ifaceParams, classParams, mode, warn,
  );
  if (shouldSkip) {
    return { preTags: [], postTags: [], sourceInterface: ifaceName };
  }

  const hasMismatch = renameMap.size > 0;
  const allTags = extractContractTagsFromNode(sig);
  const preTags = allTags.filter((tag) => tag.kind === KIND_PRE);
  const postTags = allTags.filter((tag) => tag.kind === KIND_POST);

  let prevExpr = extractPrevExpression(sig);
  if (hasMismatch && mode === MODE_RENAME && prevExpr !== undefined) {
    prevExpr = renameIdentifiersInExpression(prevExpr, renameMap);
  }

  return buildContractsResult(
    preTags, postTags, prevExpr, renameMap, hasMismatch, mode, ifaceName,
  );
}

function mergeMethodContracts(
  existing: InterfaceMethodContracts | undefined,
  incoming: InterfaceMethodContracts,
): InterfaceMethodContracts {
  if (existing === undefined) {
    return { ...incoming };
  }
  const base = {
    preTags: [...existing.preTags, ...incoming.preTags],
    postTags: [...existing.postTags, ...incoming.postTags],
    sourceInterface: existing.sourceInterface,
  };
  const prevExpr = existing.prevExpression ?? incoming.prevExpression;
  return prevExpr !== undefined
    ? { ...base, prevExpression: prevExpr }
    : base;
}

function processInterfaceDeclaration(
  decl: typescript.InterfaceDeclaration,
  classNode: typescript.ClassDeclaration,
  cache: Map<string, typescript.SourceFile>,
  warn: (msg: string) => void,
  mode: ParamMismatchMode,
  className: string,
  result: InterfaceContracts,
): void {
  const ifaceName = decl.name.text;
  const reparsed = reparseCached(decl.getSourceFile(), cache);
  const reparsedIface = findInterfaceByPos(reparsed, decl.pos);
  if (reparsedIface !== undefined) {
    const ifaceInvariants = extractInvariantExpressions(reparsedIface);
    result.invariants.push(...ifaceInvariants);

    classNode.members.forEach((member) => {
      const isMethod = typescript.isMethodDeclaration(member);
      const hasIdentifierName = isMethod && typescript.isIdentifier(member.name);
      if (isMethod && hasIdentifierName) {
        const methodName = member.name.text;
        const classParams = getClassMethodParams(member);
        const location = `${className}.${methodName}`;
        const methodContracts = extractMethodContracts(
          reparsedIface, methodName, classParams, mode, ifaceName, location, warn,
        );
        if (methodContracts !== undefined) {
          result.methods.set(
            methodName,
            mergeMethodContracts(result.methods.get(methodName), methodContracts),
          );
        }
      }
    });
  }
}

function processImplementedInterface(
  typeExpr: typescript.Expression,
  classNode: typescript.ClassDeclaration,
  checker: typescript.TypeChecker,
  cache: Map<string, typescript.SourceFile>,
  warn: (msg: string) => void,
  mode: ParamMismatchMode,
  className: string,
  result: InterfaceContracts,
): void {
  const ifaceType = checker.getTypeAtLocation(typeExpr);
  const declarations = ifaceType.symbol?.declarations;
  if (declarations !== undefined) {
    declarations.forEach((decl) => {
      if (typescript.isInterfaceDeclaration(decl)) {
        processInterfaceDeclaration(
          decl, classNode, cache, warn, mode, className, result,
        );
      }
    });
  }
}

export function resolveInterfaceContracts(
  classNode: typescript.ClassDeclaration,
  checker: typescript.TypeChecker,
  cache: Map<string, typescript.SourceFile>,
  warn: (msg: string) => void,
  mode: ParamMismatchMode,
): InterfaceContracts {
  const result: InterfaceContracts = {
    methods: new Map<string, InterfaceMethodContracts>(),
    invariants: [],
  };
  const className = classNode.name?.text ?? 'UnknownClass';

  const heritageClauses = classNode.heritageClauses ?? [];
  heritageClauses.forEach((clause) => {
    if (clause.token === typescript.SyntaxKind.ImplementsKeyword) {
      clause.types.forEach((typeRef) => {
        processImplementedInterface(
          typeRef.expression, classNode, checker, cache,
          warn, mode, className, result,
        );
      });
    }
  });

  return result;
}
