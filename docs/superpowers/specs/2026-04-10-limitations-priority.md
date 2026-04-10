# Limitations: Priority and Implementation Effort

**Date:** 2026-04-10

This document ranks the known contract-validation limitations by implementation priority and effort. Each entry links to its design spec.

Limitation #8 (`result` used without a return type annotation) is intentional behaviour — the `@post` is dropped with a warning by design — and is excluded from this list.

---

## Priority Table

| Priority | Limitation | Effort | Spec |
|---|---|---|---|
| 1 | #5 — Global objects not in whitelist | XS | [identifier-scope](2026-04-10-identifier-scope-design.md) |
| 2 | #1 — Destructured parameters | S | [identifier-scope](2026-04-10-identifier-scope-design.md) |
| 3 | #6 — Template literals (bug fix only) | S | [template-literals](2026-04-10-template-literals-design.md) |
| 4 | #4 — Enum and external constant references | M | [identifier-scope](2026-04-10-identifier-scope-design.md) |
| 5 | #2 / #3 / #7 / #10 — Type checking gaps | M | [type-checking-gaps](2026-04-10-type-checking-gaps-design.md) |
| 6 | #6 — Template literals (full reifier support) | M | [template-literals](2026-04-10-template-literals-design.md) |
| 7 | #9 — Multi-level property chains | L | [property-chain-validation](2026-04-10-property-chain-validation-design.md) |
| 8 | #11 — Compound conditions / type narrowing | XL | (deferred — no spec yet) |

---

## Effort Scale

| Size | Meaning |
|---|---|
| XS | Single constant or guard addition; < 10 lines changed |
| S | New helper function or a small set of targeted changes; 10–50 lines |
| M | New logic spanning 1–2 files; TypeChecker integration required; 50–150 lines |
| L | New validation pass, threading changes across 3+ files; 150–300 lines |
| XL | Data-flow / type-narrowing analysis; architecture review required |

---

## Rationale

### Priority 1 — #5 Global whitelist (XS)
Immediate, zero-risk win. `Math.abs`, `Array.isArray`, `JSON.stringify` are used in real contracts today; every occurrence currently warns and drops the contract. One constant extension in `contract-validator.ts`.

### Priority 2 — #1 Destructured parameters (S)
Destructuring is idiomatic in modern TypeScript. When a function uses it, *every* contract on that function is currently unusable without resorting to manual `pre()`/`post()` assertions. The fix is a contained recursive helper in `node-helpers.ts` and a small addition to `type-helpers.ts`.

### Priority 3 — #6 Template literals, bug fix (S)
The current behaviour — one template literal silently drops *all* contracts on the function — is a correctness bug and a poor user experience. The fix is a single validation check added to `contract-validator.ts` that turns the silent failure into a targeted warning. Low risk; ships before the full reifier support.

### Priority 4 — #4 Enum and external constants (M)
Enums and imported constants are extremely common in TypeScript codebases. The TypeChecker approach (`getSymbolsInScope`) is clean but requires careful scoping of the symbol query and threading through `function-rewriter.ts`. The `allowIdentifiers` fallback covers the transpileModule case independently.

### Priority 5 — #2 / #3 / #7 / #10 Type checking gaps (M)
Four limitations share a common root: the type resolution pipeline only handles raw primitive flags. Fixing them together (new `resolveSimpleType` helper + unary unwrapping) is more efficient than addressing each in isolation. Requires a TypeChecker but the TypeChecker is already available on the full-program path.

### Priority 6 — #6 Template literals, full support (M)
Adding `NoSubstitutionTemplateLiteral` and `TemplateExpression` to the reifier is well-contained but less urgent than the bug fix above. Ships after the bug fix; removes the `'unsupported-syntax'` error kind and the limitation from the README.

### Priority 7 — #9 Multi-level property chains (L)
Meaningful safety improvement — typos in `this.propertyName` chains are caught at compile time instead of failing at runtime. Higher effort because it requires threading `checker` and `contextNode` through the validation call stack and correctly resolving the instance type for `this`. Low urgency since the feature currently works (contracts inject); the gap is in validation depth only.

### Priority 8 — #11 Compound conditions / type narrowing (XL)
Data-flow analysis of `&&`/`||` conditions is a fundamentally different class of problem. Deferred until union-type checking (#3, covered in priority 5) ships and there is a clear pattern of users hitting this limitation. No spec yet.

---

## Suggested sequencing

Priorities 1–3 are independent of each other and of the rest; they can land in a single small release. Priority 4 and 5 can follow as a single TypeChecker-focused release. Priority 6 is a clean-up pass. Priority 7 is a standalone enhancement. Priority 8 is deferred indefinitely.
