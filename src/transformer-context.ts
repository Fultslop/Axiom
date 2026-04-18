import type typescript from 'typescript';
import type { KeepContracts } from './keep-contracts';
import type { ParamMismatchMode } from './interface-resolver';
import type { ReparsedIndex } from './reparsed-index';

export type TransformerContext = {
  factory: typescript.NodeFactory;
  warn: (msg: string) => void;
  checker: typescript.TypeChecker | undefined;
  allowIdentifiers: string[];
  keepContracts: KeepContracts;
  paramMismatch: ParamMismatchMode;
  reparsedIndex: ReparsedIndex;
  reparsedCache: Map<string, typescript.SourceFile>;
  transformed: { value: boolean };
};
