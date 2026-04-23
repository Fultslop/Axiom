# Warn on `@pre`/`@post` on Non-Exported Function Declarations — Design Doc

**Date:** 2026-04-22
**Covers:** Spec 004 finding #13 — `@pre`/`@post` on non-exported functions silently drops (Low)

---

## 1. Problem

The transformer emits `emitUnsupportedFunctionWarning` for arrow functions and function expressions with `@pre`/`@post` tags. But plain non-exported `function` declarations (e.g. `function helper() {}` without `export`) are silently skipped — no contract injected, no warning. This is the same class of silent-drop bug as finding #1 but triggered by user error rather than transformer bug.

Note: the `2026-04-13-misuse-detection-design.md` spec described this fix in section 3.2, but the implementation missed this specific case. This spec closes the gap.

---

## 2. Goals

- A warning is emitted when a `@pre` or `@post` tag appears on a non-exported `FunctionDeclaration`.
- The warning message names the function, the tag(s), and explains why contracts are not injected.
- No warning is emitted for exported functions (those are handled normally).
- No change to the transformer output for unsupported targets — the node is still returned unmodified.

---

## 3. Approach

### 3.1 Detection location

**Location:** `src/transformer.ts`, `visitNode` function.

The `isFunctionDeclaration` branch already handles the public-target path. After `isPublicTarget` returns `false`, before falling through to `visitEachChild`, add:

```typescript
if (typescript.isFunctionDeclaration(node) && !isPublicTarget(node, ctx)) {
  const tags = extractContractTagsFromNode(node);
  if (tags.length > 0) {
    const name = node.name?.text ?? '(anonymous)';
    ctx.warn(
      `[axiom] Warning: @pre/@post on non-exported function '${name}' has no effect — ` +
      `contracts are only injected on exported functions and public class methods.`
    );
  }
  return typescript.visitEachChild(node, visitNode, context);
}
```

`extractContractTagsFromNode` is already imported/available from `jsdoc-parser.ts`.

### 3.2 Scope

This spec only covers top-level non-exported function declarations. Nested function declarations (functions inside other functions) are already covered by the existing misuse-detection spec if it was fully implemented. Verify and add a test for the nested case too.

---

## 4. Changes Summary

| File | Change |
|---|---|
| `src/transformer.ts` | In `visitNode`, add contract-tag check for non-public `FunctionDeclaration` nodes; emit warning if tags found |

---

## 5. Testing Plan

- Non-exported top-level function with `@pre x > 0` → warning emitted containing the function name
- Non-exported top-level function with `@post result !== null` → warning emitted
- Non-exported top-level function with no contract tags → no warning
- Exported function with `@pre x > 0` → no unsupported-target warning; contract injected normally
- Non-exported function inside another function body with `@pre` → warning emitted (nested case)
- `export default function` with `@pre` → no warning; contract injected normally

---

## 6. Out of Scope

- Adding support for non-exported function contracts — detection and warning only.
- Detecting `@prev` on non-exported functions — `@prev` without `@post` has no effect anyway; the `@post` warning covers the functional gap.
- Suppression mechanisms (`// axiom-ignore` or similar).
