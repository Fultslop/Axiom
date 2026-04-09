import typescript from 'typescript';

export interface ReparsedIndex {
  functions: Map<number, typescript.FunctionLikeDeclaration>;
  classes: Map<number, typescript.ClassDeclaration>;
}

/**
 * Re-parse the source file with setParentNodes:true so JSDoc nodes are
 * attached. Returns maps from source position to reparsed node.
 */
export function buildReparsedIndex(sourceFile: typescript.SourceFile): ReparsedIndex {
  const reparsed = typescript.createSourceFile(
    sourceFile.fileName,
    sourceFile.text,
    sourceFile.languageVersion,
    /* setParentNodes */ true,
  );

  const functions = new Map<number, typescript.FunctionLikeDeclaration>();
  const classes = new Map<number, typescript.ClassDeclaration>();

  function visit(node: typescript.Node): void {
    if (typescript.isFunctionLike(node)) {
      functions.set(node.pos, node as typescript.FunctionLikeDeclaration);
    }
    if (typescript.isClassDeclaration(node)) {
      classes.set(node.pos, node);
    }
    typescript.forEachChild(node, visit);
  }

  visit(reparsed);
  return { functions, classes };
}
