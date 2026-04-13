# Liskov-Aware Contract Warnings — Design Doc

**Date:** 2026-04-13
**Issue:** #18
**Effort:** XL
**Depends on:** `2026-04-09-interface-contracts-design.md` (spec 004, additive merge)
**Status:** Draft

---

## 1. Problem

### 1.1 Background: the Liskov Substitution Principle

The Liskov Substitution Principle (LSP) states that if `S` is a subtype of `T`, then objects of type `T` may be replaced by objects of type `S` without altering the correctness of the program. In Design-by-Contract terms this means:

- **Preconditions may only be weakened in subtypes.** A caller written against the supertype's interface only knows about the supertype's preconditions. If a subtype adds stricter preconditions, that caller cannot satisfy them — and the contract is silently broken at the point of substitution.
- **Postconditions may only be strengthened in subtypes.** A caller relying on a supertype guarantee is not harmed by a subtype that promises more.
- **Invariants may only be strengthened in subtypes.** This is identical to the postcondition rule and is already handled correctly by additive merge.

### 1.2 What Axiom currently does

Spec 004 (interface contracts) introduced additive merge: all `@pre` and `@post` tags from an interface are concatenated with the class method's own tags and all guards are injected. This is correct for `@post` (AND = strengthening) and for `@invariant` (AND = strengthening), but it is incorrect for `@pre`:

- If the interface declares `@pre amount > 0` and the class declares `@pre amount < 10000`, additive merge injects **both** guards: callers must satisfy **both** conditions simultaneously. This is stricter than the interface alone — a caller that sends `amount = 20000` satisfies the interface contract but is rejected by the class.
- From a substitutability standpoint, the class is imposing a restriction that callers written against the interface have no obligation to honour.

More importantly, additive merge currently applies **silently** when a subtype adds its own `@pre` on top of the inherited one. The only signal emitted is the generic merge warning introduced in spec 004. That warning does not characterise the nature of the problem (possible LSP violation) and does not direct the user toward remediation.

### 1.3 Concrete example — violation

```typescript
interface Withdrawable {
  /** @pre amount > 0 */
  withdraw(amount: number): void;
}

class PremiumAccount implements Withdrawable {
  /**
   * @pre amount > 100   // VIOLATION: stricter than interface precondition
   */
  withdraw(amount: number): void { /* ... */ }
}
```

A caller that holds a `Withdrawable` reference and calls `withdraw(50)` satisfies the interface contract, but the concrete `PremiumAccount` rejects it.

### 1.4 Concrete example — valid subtype strengthening

```typescript
class Animal {
  /** @post result.length > 0 */
  describe(): string { /* ... */ }
}

class Dog extends Animal {
  /** @post result.length > 10 */  // Fine: stronger postcondition is valid LSP
  describe(): string { /* ... */ }
}
```

Adding `@post` constraints in a subtype is valid LSP — callers only depend on the weaker guarantee, so a stronger one is always safe.

### 1.5 The detection challenge

Statically proving that one predicate implies another (i.e. that `amount > 100` implies `amount > 0`, so the subtype precondition is a strict subset of the interface precondition — a violation) requires reasoning about arbitrary TypeScript expressions. This is the satisfiability/implication problem, which in general requires an SMT solver (Z3, CVC5, etc.). That is not feasible as a zero-dependency compile-time transformer plugin.

The tractable alternative is **heuristic detection**: flag cases where the structural pattern is suspicious (subtype adds `@pre` when a parent already has `@pre`) without attempting to prove whether the added constraint is actually weaker or stronger. This trades completeness for practicality.

---

## 2. Goals

1. Emit a compile-time warning whenever a subtype method adds `@pre` constraints beyond those already present in the parent type (interface or base class), because this pattern is almost always an LSP violation.
2. Provide an explicit opt-out annotation (`@preWeakens`) for the rare legitimate case where a developer knowingly adds a `@pre` that genuinely widens the accepted input space and wants to suppress the warning.
3. Make the warning message actionable — include the subtype name, the method name, and the parent type name so the user immediately knows where to look.
4. Keep the existing additive merge behaviour (for runtime enforcement) unchanged by this spec — this spec introduces warnings only, not a change to the injected code.
5. Be honest in warning text and documentation that this is a heuristic, not a proof.

---

## 3. Non-Goals

1. **No SMT-solver integration.** We will not integrate Z3 or any external solver. The complexity, binary size, startup time, and platform portability requirements of an SMT solver are incompatible with a ts-patch transformer plugin.
2. **No structural expression comparison.** We will not attempt to parse expressions and compare thresholds (e.g. detect that `amount > 100` is strictly stronger than `amount > 0` because `100 > 0`). This approach is brittle, covers only a small subset of patterns, and produces false confidence.
3. **No change to runtime behaviour.** The injected guards continue to use additive merge. This spec adds a warning path only.
4. **No Liskov-aware OR-merge for preconditions.** The future-notes plan (`future-liskov-aware-contracts.md`) describes generating `if (!(A || B))` guards for weakened preconditions. That is a separate, larger spec and is explicitly out of scope here.
5. **No multi-interface conflict resolution.** When a class implements two interfaces that both define `@pre` for the same method, detecting whether those two interface preconditions conflict with each other is a separate spec.
6. **No proof of correctness.** The heuristic will produce false positives (warnings for patterns that are not actually LSP violations) and false negatives (missed violations that do not match the structural pattern). This is inherent and acknowledged.

---

## 4. Approach

### 4.1 Heuristic detection strategy

The rule is simple and deliberately conservative:

> **If a subtype method carries one or more `@pre` tags AND the inherited type (interface or base class) also carries one or more `@pre` tags for the same method, emit an LSP warning.**

No expression comparison is performed. The presence of added `@pre` tags on the subtype is the only signal. This rule:

- Has zero false negatives for the most common pattern (subtype adds a new `@pre` constraint alongside an inherited one).
- Has false positives for the legitimate case where a subtype `@pre` genuinely weakens a constraint (e.g. the interface says `amount > 0 && amount < 100` and the class relaxes it to `amount > 0`). The `@preWeakens` annotation suppresses these.

### 4.2 Warning conditions

A warning is emitted under the following conditions, checked in `class-rewriter.ts` during the merge step:

| Condition | Warning emitted? |
|---|---|
| Interface has `@pre`; class method has no `@pre` | No (standard injection, no conflict) |
| Interface has no `@pre`; class method has `@pre` | No (class-only precondition, no parent to violate) |
| Interface has `@pre`; class method has `@pre`; no `@preWeakens` | **Yes — LSP violation warning** |
| Interface has `@pre`; class method has `@pre`; `@preWeakens` present | No (user opt-out) |
| Base class has `@pre`; subclass method has `@pre`; no `@preWeakens` | **Yes — LSP violation warning** |
| Base class has `@pre`; subclass method has `@pre`; `@preWeakens` present | No (user opt-out) |
| Subtype adds `@post` beyond inherited `@post` | No (strengthening postconditions is valid LSP) |

### 4.3 Opt-out annotation: `@preWeakens`

When a developer intentionally weakens a precondition (valid LSP) and wants to document it, they annotate the class method with `@preWeakens`:

```typescript
interface Lockable {
  /**
   * @pre this.isLocked && userId !== null
   */
  unlock(userId: string): void;
}

class PublicDoor implements Lockable {
  /**
   * @pre this.isLocked          // weakens: removes the userId !== null constraint
   * @preWeakens Lockable.unlock  // suppresses LSP warning; documents the intent
   */
  unlock(userId: string): void { /* ... */ }
}
```

`@preWeakens` takes an optional argument identifying the parent type and method (`InterfaceName.methodName`). The argument is for documentation purposes only — the transformer does not validate it.

The presence of `@preWeakens` on a method suppresses the LSP warning for that method entirely. It does not change the injected guards; additive merge still applies.

If `@preWeakens` is present but there is no inherited `@pre` to conflict with, a mild advisory is emitted:

```
[axiom] @preWeakens on PublicDoor.unlock has no effect: no inherited @pre found for this method
```

### 4.4 Postcondition strengthening

Adding `@post` constraints in a subtype is always valid LSP. No warning is emitted. This is already the correct behaviour of additive merge and requires no change.

---

## 5. Architecture

### 5.1 Detection site: `src/class-rewriter.ts`

The merge step in `rewriteMember` already receives both the interface contracts (`InterfaceMethodContracts`) and the class method's own contract tags. The LSP check is inserted at this merge point.

New helper function in `class-rewriter.ts`:

```typescript
function checkLiskovPreConditions(
  className: string,
  methodName: string,
  inheritedPreTags: ContractTag[],
  classPreTags: ContractTag[],
  classMethodNode: typescript.MethodDeclaration,
  parentTypeName: string,
  warn: (msg: string) => void,
): void
```

Logic:
1. If `inheritedPreTags.length === 0` or `classPreTags.length === 0`, return immediately (no conflict possible).
2. Check whether the class method's JSDoc contains a `@preWeakens` tag. If yes, optionally emit the "no-effect" advisory and return.
3. Emit the LSP warning.

This function is called once per interface (or base class) per method, using the resolved interface contracts before the merge arrays are concatenated.

### 5.2 Base class support

The existing `interface-resolver.ts` only handles `implements` clauses. LSP violations can also arise from `extends`. A separate resolution path is needed for base class `@pre` inheritance.

A new exported function is added to `interface-resolver.ts`:

```typescript
export function resolveBaseClassContracts(
  classNode: typescript.ClassDeclaration,
  checker: typescript.TypeChecker,
  cache: Map<string, typescript.SourceFile>,
  warn: (msg: string) => void,
  mode: ParamMismatchMode,
): InterfaceContracts
```

This function mirrors `resolveInterfaceContracts` but walks `ExtendsKeyword` heritage clauses instead of `ImplementsKeyword`. It resolves the base class declaration (which may be in a separate file), extracts `@pre`/`@post` tags from the corresponding method declarations (not signatures), and returns them in the same `InterfaceContracts` shape.

The same `reparseCached` and `extractMethodContracts` helpers are reused.

Base class contracts are passed through the same LSP check path as interface contracts, with `parentTypeName` set to the base class name.

### 5.3 `@preWeakens` tag extraction

`@preWeakens` is extracted in `jsdoc-parser.ts` via the existing tag extraction infrastructure. A new exported function:

```typescript
export function extractPreWeakensTag(
  node: typescript.Node,
): string | undefined
```

Returns the tag argument string if `@preWeakens` is present, or `undefined` otherwise. The tag argument is not validated — it exists solely to document intent.

### 5.4 Modified: `src/transformer.ts`

No new options are needed for this spec. The `warn` callback already exists and is passed through the call chain. No new plugin configuration keys are introduced.

### 5.5 Import graph additions

```
class-rewriter.ts
  ├── interface-resolver.ts  (existing)
  │     └── resolveBaseClassContracts  ← new export
  └── jsdoc-parser.ts
        └── extractPreWeakensTag       ← new export
```

The `checkLiskovPreConditions` helper lives in `class-rewriter.ts` — no new files are required.

---

## 6. Warning Messages

### 6.1 Interface precondition violation

```
[axiom] Possible LSP violation in PremiumAccount.withdraw:
  adds @pre constraints beyond those in Withdrawable.withdraw
  — preconditions should only be weakened in subtypes, not strengthened
  — use @preWeakens to suppress if this is intentional
```

### 6.2 Base class precondition violation

```
[axiom] Possible LSP violation in Dog.move:
  adds @pre constraints beyond those in Animal.move
  — preconditions should only be weakened in subtypes, not strengthened
  — use @preWeakens to suppress if this is intentional
```

### 6.3 `@preWeakens` with no inherited `@pre`

```
[axiom] @preWeakens on PublicDoor.unlock has no effect:
  no inherited @pre found for this method in any interface or base class
```

### 6.4 Message guidelines

- Always prefix with `[axiom]`.
- Always include the fully-qualified subtype and method name (`ClassName.methodName`).
- Always name the parent type (`Withdrawable.withdraw`, `Animal.move`).
- Always include the remediation hint (`use @preWeakens`).
- Never assert that a violation has been proven — use "Possible LSP violation".

---

## 7. Known Limitations of the Heuristic

This section is intentionally frank. The heuristic described in this spec is a best-effort detection, not a proof.

### 7.1 False positives (warns when there is no actual violation)

**Scenario:** A subtype `@pre` genuinely widens the accepted domain. For example, the interface requires `amount > 0 && currency !== null` (two guards), and the class only requires `amount > 0` (relaxes the `currency` constraint). Structurally both sides have `@pre` tags, so the warning fires — but the subtype is actually correct LSP.

**Mitigation:** `@preWeakens` suppresses the warning. The developer must read the warning and decide.

**Scenario:** A base class `@pre` and subclass `@pre` are on completely different aspects of the method (e.g. base checks `this.isReady`, subclass checks `input !== null`). The combined guard is not obviously an LSP violation, but the warning fires because both sides have `@pre` tags.

**Mitigation:** Same — `@preWeakens` suppresses.

### 7.2 False negatives (violations that are not detected)

**Scenario:** The interface has no `@pre` but the class has `@pre`. Technically, any precondition added by the class that the interface did not specify is an LSP violation (the interface implicitly accepts all inputs). However, this pattern is also the standard use case for class-only contracts, so warning on it would produce an unacceptable false-positive rate. This case is **not warned on** in this spec.

**Scenario:** Both parent and subtype share a `@pre` tag with the same expression, but the class's implementation imposes an additional undocumented constraint (no `@pre` tag, just code). The transformer cannot see undocumented runtime constraints.

**Scenario:** The parent type is defined in a third-party library with no JSDoc `@pre` tags at all — the transformer has no parent contracts to compare against.

### 7.3 TypeChecker unavailable

When the transformer runs in `transpileModule` mode (no `Program`), cross-file resolution of both interface and base class contracts is unavailable. In this mode:

- No LSP checks can be performed.
- The existing "resolution skipped" warning from spec 004 covers this case.
- No additional warning is emitted for the absent LSP check.

### 7.4 Abstract classes and intermediate inheritance

If the immediate base class does not define `@pre` but a grandparent does, this spec does not walk the full inheritance chain. Only the direct parent (one level up via `extends`) is checked. Deep inheritance chains require recursive ancestor resolution, which is deferred.

### 7.5 Method overloads

TypeScript allows multiple overload signatures. The transformer currently processes the implementation signature only. Overloads that carry `@pre` tags on individual signatures are not resolved. This is consistent with the existing limitation in spec 004.

---

## 8. Testing Plan

### 8.1 Unit tests (`src/lsp-checker.test.ts` or co-located in `class-rewriter.test.ts`)

| Test | Expected result |
|---|---|
| Class adds `@pre` with no interface `@pre` | No warning |
| Interface has `@pre`, class has no `@pre` | No warning |
| Interface has `@pre`, class adds `@pre`, no `@preWeakens` | Warning emitted with correct text |
| Interface has `@pre`, class adds `@pre`, `@preWeakens` present | No warning |
| `@preWeakens` with no inherited `@pre` | Advisory "no effect" warning |
| Base class has `@pre`, subclass adds `@pre`, no `@preWeakens` | Warning emitted with correct text |
| Base class has `@pre`, subclass adds `@pre`, `@preWeakens` present | No warning |
| Subtype adds `@post` beyond inherited `@post` | No warning |
| Class implements two interfaces; both have `@pre`; class also has `@pre` | Warning emitted once per interface (two warnings) |
| Interface contract in a separate `.ts` file | Warning still emitted (cross-file resolution) |
| `transpileModule` mode (no TypeChecker) | No LSP warning; existing resolution-skipped warning only |

### 8.2 Integration / acceptance tests

- A class implementing an interface where both sides have `@pre` produces a warning during `npm run build`.
- A class with `@preWeakens` does not produce a warning.
- The runtime injected guard is unchanged from pre-spec behaviour (additive merge still fires both guards).
- Existing spec 004 acceptance criteria are not broken.
- Coverage threshold (80%) is maintained.

### 8.3 Warning text assertions

Tests asserting on warning messages must match the exact prefixes defined in §6 to prevent message drift. Use `expect(warn).toHaveBeenCalledWith(expect.stringContaining('[axiom] Possible LSP violation in'))`.

---

## 9. Out of Scope

The following items are explicitly excluded from this spec and deferred to future work:

- **Liskov-aware OR-merge for preconditions** — generating `if (!(A || B))` compound guards instead of two separate `if (!A)` / `if (!B)` guards. See `docs/superpowers/plans/future-liskov-aware-contracts.md`.
- **Multi-interface `@pre` conflict detection** — when a class implements two interfaces that both have `@pre` for the same method and those preconditions may conflict. Natural extension point for OR-merge.
- **Full inheritance chain traversal** — walking grandparent and higher ancestors. Only the direct parent (one hop via `extends`) is checked in this spec.
- **SMT-solver or structural expression comparison** — proving implication between predicate expressions. Not in scope per §3.
- **Constructor contracts** — `@pre`/`@post` on constructors. See the constructor contracts spec.
- **Async methods** — deferred per the existing limitation in spec 004.
- **`@post` weakening detection** — detecting when a subtype drops `@post` constraints from the parent. Theoretically an LSP violation (weakened postcondition), but the current merge strategy already injects the parent `@post` regardless of what the class does, so the runtime enforcement is unaffected. A warning could be added in a future spec.
- **`@invariant` weakening detection** — same reasoning as `@post` weakening.
- **IDE integration or language-server diagnostics** — this is a compile-time transformer warning only.
