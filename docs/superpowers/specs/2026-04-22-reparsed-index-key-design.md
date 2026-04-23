# Stable Reparsed-Index Key — Design Doc

**Date:** 2026-04-22
**Covers:** Spec 004 finding #7 — `node.pos` as reparsed-index key is unreliable across source-file variants (High)

---

## 1. Problem

`reparsed-index.ts` maps `node.pos → reparsed node`. `node.pos` is the leading-trivia start position of the node in the original source file. Two issues:

1. **Architecture fragility:** If the transformer ever modifies the source text before re-parsing (currently it doesn't, but the code doesn't prevent it), positions shift and the index returns stale or missing entries silently.

2. **Potential collision:** Two nodes at the same byte offset in different source-file variants (e.g. after a prior transformation pass) would map to the same key, with the `Map` silently overwriting the earlier entry.

---

## 2. Goals

- The reparsed-index key uniquely identifies a node and does not rely on leading-trivia position.
- The invariant that re-parsing must use the original (unmodified) source text is documented.
- No change to the public interface of the index — callers continue to look up by node.
- A node-kind discriminator is included in the key to prevent cross-kind collisions at the same position.

---

## 3. Approach

### 3.1 Composite key: `getStart()` + `SyntaxKind`

Replace `node.pos` with a composite key of `node.getStart()` (skips leading trivia) and `node.kind`:

```typescript
function nodeKey(node: typescript.Node): string {
  return `${node.getStart()}:${node.kind}`;
}
```

`getStart()` is more stable than `pos` because it points to the first real token rather than leading whitespace. The `kind` discriminator prevents collisions between different node types that start at the same position (e.g. a `ClassDeclaration` and its first `Identifier` both start at the same character offset after stripping trivia — but they have different `kind` values).

### 3.2 Index implementation

Replace the `Map<number, Node>` with `Map<string, Node>` keyed by `nodeKey(node)`. Update the insertion and lookup sites accordingly.

### 3.3 Document the invariant

Add a comment at the top of `reparsed-index.ts`:

```typescript
// Invariant: the source file passed to buildIndex must be the original,
// unmodified source text. Re-parsing modified text shifts positions and
// invalidates all keys.
```

### 3.4 Assertion in development builds (optional)

If the module receives a source file whose `text` differs from the original, emit a `warn` message. This can be guarded by `process.env.NODE_ENV !== 'production'` or behind a debug flag to avoid production overhead.

---

## 4. Changes Summary

| File | Change |
|---|---|
| `src/reparsed-index.ts` | Change key type from `number` to `string`; replace `node.pos` with `nodeKey(node)` using `getStart() + ':' + kind`; add invariant comment |

---

## 5. Testing Plan

- Two nodes at the same `pos` but different `kind` → both indexed correctly, no collision
- Node lookup after re-parsing original source → correct node returned
- Composite key does not regress existing functionality: class rewriting, function rewriting, and interface contract resolution all use the index and must continue to pass
- Confirm `getStart()` and `pos` return the same value for nodes with no leading trivia (unit test to document the relationship)

---

## 6. Out of Scope

- Detecting source-text modification before re-parsing — the document-invariant comment is sufficient for now.
- Using a WeakMap or identity-based key — the reparsed nodes are new AST objects and cannot be keyed by the original node's identity.
- Positional stability across multiple transformation passes — the current transformer is single-pass; multi-pass support is a future concern.
