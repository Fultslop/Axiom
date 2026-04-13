# Open Issues — Comprehensive Tracker

**Date:** 2026-04-13

This document is the authoritative list of all known open issues, deferred limitations, and planned feature gaps in the Axiom transformer. It supersedes the priority table in [limitations-priority.md](2026-04-10-limitations-priority.md), which covers only the original validation gaps (all now resolved).

---

## Resolved (for reference)

All items from the original limitations-priority.md have shipped.

| # | Issue | Effort | Spec |
|---|---|---|---|
| #1 | Destructured parameters | S | [identifier-scope](2026-04-10-identifier-scope-design.md) |
| #2 | Non-primitive parameter types | M | [type-checking-gaps](2026-04-10-type-checking-gaps-design.md) |
| #3 | Union-typed parameters | M | [type-checking-gaps](2026-04-10-type-checking-gaps-design.md) |
| #4 | Enum / external constants | M | [identifier-scope](2026-04-10-identifier-scope-design.md) |
| #5 | Global objects whitelist | XS | [identifier-scope](2026-04-10-identifier-scope-design.md) |
| #6 | Template literals (bug fix + full support) | S+M | [template-literals](2026-04-10-template-literals-design.md) |
| #7 | Non-primitive return types | M | [type-checking-gaps](2026-04-10-type-checking-gaps-design.md) |
| #8 | `result` without return type *(intentional behaviour — warning by design)* | — | — |
| #9 | Multi-level property chains | L | [property-chain-validation](2026-04-10-property-chain-validation-design.md) |
| #10 | Unary operands | M | [type-checking-gaps](2026-04-10-type-checking-gaps-design.md) |

---

## Open Issues

### Validation / contract expression gaps

| # | Issue | Effort | Spec |
|---|---|---|---|
| #11 | Compound conditions / `&&`\|`\|\|` type narrowing | XL | [compound-conditions](2026-04-13-compound-conditions-design.md) |
| #12 | Optional chaining `?.` in contract expressions | M | [optional-chaining](2026-04-13-optional-chaining-design.md) |

**#11 — Compound conditions / type narrowing**
Type mismatch detection examines each binary sub-expression in isolation. Type narrowing established by a sibling clause is not taken into account. The primary remaining case after union-type resolution shipped is `typeof` guard narrowing for ambiguous unions (`typeof x === "string" && x === 42` where `x: string | number`). Requires data-flow analysis of `&&`/`||` trees.

```typescript
/** @pre typeof x === "string" && x === 42 */   // no type-mismatch warning on second clause
export function foo(x: string | number): void { … }
```

**#12 — Optional chaining in contract expressions**
`obj?.value` is a `PropertyAccessChain` node. The property chain validator calls `checker.getPropertyOfType` on the raw declared type of `obj` (e.g. `ValueCarrier | null`), which may return `undefined` for `value` because `null` has no such property — producing a false-positive unknown-property warning. Fix: strip `null`/`undefined` constituents from the root type before walking the chain when the access uses `?.`.

```typescript
/** @pre obj?.value > 0 */
export function doOptionalFn(obj: ValueCarrier | null): number | null { … }
```

---

### Misuse detection (silent failures)

| # | Issue | Effort | Spec |
|---|---|---|---|
| #13 | No warning when tags appear on unsupported targets | S | [misuse-detection](2026-04-13-misuse-detection-design.md) |

**#13 — Misuse detection**
The following misuse patterns are currently silently ignored — no contract is injected and no warning is emitted:

- `@pre`/`@post` on a **constructor** — tags are extracted during invariant processing but never applied to the constructor body
- `@pre`/`@post` on an **arrow function or function expression** — the transformer only visits `FunctionDeclaration` and `MethodDeclaration`; tags on arrow/function-expression nodes are never seen
- `@pre`/`@post` on a **nested / closure function** — same root cause as above; only top-level exported functions and public class methods are visited
- `@pre`/`@post` on a **class declaration body** (not a method) — tags silently ignored
- `@invariant` on a **non-class** (function, interface, variable) — class-rewriter only activates on `ClassDeclaration`; the tag is never processed

Each case should emit a targeted `[axiom] Warning` explaining why the tag was dropped and what to do instead.

---

### Feature gaps (not yet in scope)

| # | Issue | Effort | Spec |
|---|---|---|---|
| #14 | Arrow functions and function expressions | L | [arrow-functions](2026-04-13-arrow-functions-design.md) |
| #20 | Closure / nested function contracts | L | [closures](2026-04-13-closures-design.md) |
| #15 | Async functions and generators | L | [async-functions](2026-04-13-async-functions-design.md) |
| #16 | Constructor contracts | M | [constructor-contracts](2026-04-13-constructor-contracts-design.md) |
| #17 | Class-to-class contract inheritance | L | [class-inheritance](2026-04-13-class-inheritance-design.md) |
| #18 | Liskov-aware contracts (pre weakening / post strengthening) | XL | [liskov-contracts](2026-04-13-liskov-contracts-design.md) |
| #19 | Hard compile contracts into release builds (per module / per file) | M | [release-contracts](2026-04-13-release-contracts-design.md) |

**#20 — Closure / nested function contracts**
`@pre`/`@post` tags on functions defined inside another function (closures, inner helpers) are not supported — #13 will warn about them, but they cannot be instrumented. Supporting them requires: (a) extending the transformer's AST visitor to descend into function bodies and find nested `FunctionDeclaration`, `ArrowFunction`, and `FunctionExpression` nodes; (b) handling captured variables from the outer scope as known identifiers; (c) location naming for anonymous nested functions; (d) deciding the target audience (inner functions are often private implementation details, not API surfaces).

**#14 — Arrow functions / function expressions**
`@pre`/`@post` tags on arrow functions and anonymous function expressions are never transformed. Requires extending the transformer's AST visitor to target these node kinds, plus handling the lack of a `name` property for location strings.

**#15 — Async functions and generators**
A stub exists in `spec/001`. For async functions, the post-condition check must be deferred to the resolved promise. Generators require per-`yield` semantics which are an even larger design problem.

**#16 — Constructor contracts**
Constructors are already visited by the class rewriter for invariant injection. Adding `@pre`/`@post` support is contained: extract tags from the constructor's JSDoc, inject pre-checks at the top of the body, and inject post-checks before each `return` (or at the implicit end of the body). Interaction with the invariant check at constructor exit must be ordered correctly.

**#17 — Class-to-class contract inheritance**
Interface contracts propagate to implementing classes. Base-class → subclass propagation does not. A class that `extends` a base class does not inherit `@pre`/`@post`/`@invariant` tags from the parent. Requires traversing the heritage clause and resolving the parent class type via the TypeChecker.

**#18 — Liskov-aware contracts**
Subtype contracts must satisfy the Liskov Substitution Principle: preconditions may only be weakened, postconditions may only be strengthened. Detecting violations requires comparing the parent and child contract expressions, which is a fundamentally different problem. See the future design note linked above.

**#19 — Hard compile contracts into release builds**
A transformer option (e.g. `keepContracts: true`, or `keepContracts: 'pre' | 'post' | 'invariant' | 'all'`) that keeps contract checks in the release build output for selected modules or files. Useful for library code where callers may not run a dev build.

---

## Effort Scale

| Size | Meaning |
|---|---|
| XS | Single constant or guard addition; < 10 lines changed |
| S | New helper or small set of targeted changes; 10–50 lines |
| M | New logic spanning 1–2 files; TypeChecker integration may be required; 50–150 lines |
| L | New validation pass or feature; threading changes across 3+ files; 150–300 lines |
| XL | Data-flow / architecture work; multiple design decisions required |
