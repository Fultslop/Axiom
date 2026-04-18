export type KeepContracts = false | 'pre' | 'post' | 'invariant' | 'all';

const KEEP_PRE       = 'pre'       as const;
const KEEP_POST      = 'post'      as const;
const KEEP_INVARIANT = 'invariant' as const;
const KEEP_ALL       = 'all'       as const;

export const shouldEmitPre = (keep: KeepContracts): boolean =>
  keep === false || keep === KEEP_PRE || keep === KEEP_ALL;

export const shouldEmitPost = (keep: KeepContracts): boolean =>
  keep === false || keep === KEEP_POST || keep === KEEP_ALL;

export const shouldEmitInvariant = (keep: KeepContracts): boolean =>
  keep === false || keep === KEEP_INVARIANT || keep === KEEP_ALL;
