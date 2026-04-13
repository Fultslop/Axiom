# Class-to-Class Contract Inheritance — Design Doc

**Date:** 2026-04-13
**Issue:** #17
**Scope:** `@pre`, `@post`, and `@invariant` on base classes; inherited by all direct subclasses via `extends`

---

## 1. Problem

Interface contracts propagate to implementing classes today (via `resolveInterfaceContracts` in `src/interface-resolver.ts`). However, contracts on a **base class** do not propagate to **subclasses** via `extends`. A subclass that overrides a method carries no enforcement of the base class contract, even though Liskov's substitution principle demands it.

```typescript
class Animal {
  /**
   * @pre amount > 0
   * @post this.energy === prev.energy + amount
   */
  feed(amount: number): void { … }
}

class Dog extends Animal {
  // No contracts — @pre and @post from Animal.feed are silently dropped
  feed(amount: number): void { … }
}
```

---

## 2. Goals

- Contracts declared on a base class method are automatically applied to any direct subclass that overrides that method.
- Base class `@invariant` tags are inherited by subclasses.
- The existing additive-merge logic (interface contracts first, then class contracts) is extended to a three-way merge: interface contracts → base class contracts → subclass contracts.
- Parameter name mismatches between base class and subclass methods are handled using the same rename/ignore logic already used for interface parameter mismatches.
- Requires a TypeChecker (`Program` mode). A warning is emitted in `transpileModule` mode, consistent with the interface contracts behaviour.

---

## 3. Non-Goals

- **Multi-level (transitive) inheritance**: only the direct parent class (`extends X`) is resolved. Grandparent contracts are out of scope for this spec.
- **Constructor contracts**: base class constructor contracts are not inherited.
- **Liskov-aware merging**: `@pre` weakening / `@post` strengthening are not enforced; additive merge only.
- **Abstract methods**: treated identically to concrete methods — contracts on the abstract declaration are inherited.
- **`async` methods**: not addressed in this spec (same deferral as in the interface contracts spec).
- **Diamond inheritance** or multiple `extends` chains: TypeScript only supports single-class inheritance; not a concern.

---

## 4. Syntax

No new tags or configuration options are introduced. The same JSDoc tags are used on base classes as on any other class or interface:

```typescript
class Animal {
  /**
   * @pre amount > 0
   * @post this.energy === prev.energy + amount
   * @prev { energy: this.energy }
   */
  feed(amount: number): void { … }
}

class Dog extends Animal {
  // Base class contracts are injected automatically.
  // Dog.feed receives @pre amount > 0 and @post this.energy === prev.energy + amount
  // with no annotation required.
  feed(amount: number): void { … }
}
```

When the subclass also declares contracts on the same method, an additive merge is performed and a warning is emitted:

```typescript
class Dog extends Animal {
  /**
   * @pre amount < 1000   // Dog also has a contract
   */
  feed(amount: number): void { … }
  // Final @pre list: [amount > 0 (Animal), amount < 1000 (Dog)]
  // Merge warning emitted
}
```

---

## 5. Semantics

### 5.1 Which methods are affected

A subclass method is affected if:
- The class has an `extends` clause.
- The base class declares a matching method (by name) with at least one `@pre`, `@post`, or `@prev` tag.
- The subclass method is a public instance method (`isPublicTarget` is true).

Methods that are not overridden in the subclass are not affected (the base class implementation already carries the contract).

### 5.2 Which invariants are inherited

`@invariant` tags declared on the base class are inherited by the subclass and merged with the subclass's own invariants (and any interface invariants) using the same additive strategy.

### 5.3 Merge order

All contract sources are merged additively in the following fixed order:

1. Interface contracts (from `implements` clauses)
2. Base class contracts (from `extends` clause — this spec)
3. Subclass own contracts (from the subclass method JSDoc)

This ordering applies to both `@pre`/`@post` tags and to `@invariant` expressions.

### 5.4 Three-way merge table

| Interface has tags | Base class has tags | Subclass has tags | Result |
|---|---|---|---|
| no | no | yes | subclass tags only |
| no | yes | no | base class tags only |
| yes | no | no | interface tags only |
| yes | yes | no | **warn** + interface first, then base |
| yes | no | yes | **warn** + interface first, then subclass |
| no | yes | yes | **warn** + base first, then subclass |
| yes | yes | yes | **warn** + interface first, then base, then subclass |

A single warning is emitted per method per merge event, listing all contributing sources.

### 5.5 Runtime execution order

```
ENTRY:  @pre checks  (interface pre → base pre → subclass pre)
BODY:   IIFE capture  (when @post or @invariant present)
EXIT:   @post checks (interface post → base post → subclass post)
        → #checkInvariants
        → return result
```

---

## 6. Approach

### 6.1 Locating the base class at transformation time

When `rewriteClass` processes a `ClassDeclaration`, it already iterates `heritageClauses`. Currently only `ImplementsKeyword` clauses are handled. The new path handles `ExtendsKeyword` clauses.

For each `ExtendsKeyword` clause there is exactly one type reference (TypeScript enforces single inheritance). The base class is resolved using:

```typescript
// typeRef is the ExpressionWithTypeArguments node from the heritage clause
const baseType = checker.getTypeAtLocation(typeRef.expression);
const baseSymbol = baseType.symbol;                       // checker.getSymbolAtLocation also works
const declarations = baseSymbol?.declarations;
```

Iterate `declarations` and find any `ClassDeclaration`. (There will typically be exactly one; if multiple declarations are found — e.g. declaration merging — all are visited and contracts are unioned.)

### 6.2 Extracting contracts from the base class declaration

The base class node found in step 6.1 may be in a different source file. Re-parse on demand using the same `reparseCached` helper already in `src/interface-resolver.ts`:

```typescript
const reparsedBase = reparseCached(baseDecl.getSourceFile(), cache);
const reparsedBaseClass = findClassByPos(reparsedBase, baseDecl.pos);
```

A new helper `findClassByPos` is added alongside the existing `findInterfaceByPos`, with the same AST-walk pattern, checking `typescript.isClassDeclaration(node) && node.pos === pos`.

For each class method in the **subclass** that has a matching method in the reparsed base class, extract contracts from the base class method using `extractContractTagsFromNode` and `extractPrevExpression`.

For base class `@invariant` tags, use `extractInvariantExpressions(reparsedBaseClass)`.

### 6.3 Parameter name handling

The same `handleParamMismatch` / `buildRenameMap` / `applyRenameToTags` helpers from `src/interface-resolver.ts` are reused without modification. The base class method parameter names play the role of "interface parameter names"; the subclass method parameter names play the role of "class parameter names".

The same `ParamMismatchMode` option (`'rename'` | `'ignore'`) governs base class parameter mismatch handling.

### 6.4 Integration into the existing merge pipeline

`resolveInterfaceContracts` currently returns an `InterfaceContracts` value that holds method contracts and invariants. The new base-class resolution produces the same `InterfaceContracts` shape.

The two results are merged before being passed into `rewriteMembers`:

```
interfaceContracts  ← resolveInterfaceContracts(classNode, checker, cache, warn, mode)
baseContracts       ← resolveBaseClassContracts(classNode, checker, cache, warn, mode)
mergedContracts     ← mergeContractSets(interfaceContracts, baseContracts, warn, className)
```

`mergeContractSets` is a new internal helper that calls `mergeMethodContracts` for each method key and concatenates invariants, emitting a merge warning when both sides contribute.

The merged result is then passed to `rewriteMembers` exactly as `interfaceContracts` is today — no further changes to the call chain are needed.

---

## 7. Architecture

### 7.1 Modified: `src/interface-resolver.ts`

New exports added:

```typescript
export interface BaseClassContracts {
  methods: Map<string, InterfaceMethodContracts>;
  invariants: string[];
}

export function resolveBaseClassContracts(
  classNode: typescript.ClassDeclaration,
  checker: typescript.TypeChecker,
  cache: Map<string, typescript.SourceFile>,
  warn: (msg: string) => void,
  mode: ParamMismatchMode,
): BaseClassContracts
```

`BaseClassContracts` is structurally identical to `InterfaceContracts`; they are kept as separate named types for clarity. Both implement the same interface pattern used internally.

New internal helpers in `src/interface-resolver.ts`:

- `findClassByPos(sourceFile, pos)` — same structure as `findInterfaceByPos`, guards with `typescript.isClassDeclaration`.
- `findBaseClassMethodParams(classDecl, methodName)` — extracts parameter names from a method in a `ClassDeclaration` node by method name.
- `extractBaseMethodContracts(baseClassNode, methodName, subclassParams, mode, baseName, location, warn)` — mirrors the existing `extractMethodContracts` for interface method signatures, operating on `MethodDeclaration` nodes instead of `MethodSignature` nodes.
- `processBaseClassDeclaration(decl, classNode, cache, warn, mode, className, result)` — mirrors `processInterfaceDeclaration`.

`resolveBaseClassContracts` implementation sketch:

```typescript
export function resolveBaseClassContracts(
  classNode: typescript.ClassDeclaration,
  checker: typescript.TypeChecker,
  cache: Map<string, typescript.SourceFile>,
  warn: (msg: string) => void,
  mode: ParamMismatchMode,
): BaseClassContracts {
  const result: BaseClassContracts = {
    methods: new Map(),
    invariants: [],
  };
  const className = classNode.name?.text ?? 'UnknownClass';

  const heritageClauses = classNode.heritageClauses ?? [];
  heritageClauses.forEach((clause) => {
    if (clause.token === typescript.SyntaxKind.ExtendsKeyword) {
      clause.types.forEach((typeRef) => {
        const baseType = checker.getTypeAtLocation(typeRef.expression);
        const declarations = baseType.symbol?.declarations;
        if (declarations !== undefined) {
          declarations.forEach((decl) => {
            if (typescript.isClassDeclaration(decl)) {
              processBaseClassDeclaration(
                decl, classNode, cache, warn, mode, className, result,
              );
            }
          });
        }
      });
    }
  });

  return result;
}
```

### 7.2 Modified: `src/class-rewriter.ts`

`rewriteClass` gains a call to `resolveBaseClassContracts` after the existing `resolveInterfaceContracts` call. The two results are merged via a new internal `mergeContractSets` helper before being passed to `rewriteMembers` and `resolveEffectiveInvariants`.

The `hasImplementsClauses` guard that gates the transpileModule warning is extended to also check for `ExtendsKeyword` clauses (see §9).

`resolveEffectiveInvariants` gains a `baseClassInvariants: string[]` parameter in addition to the existing `interfaceInvariants: string[]` parameter. The merge warning is updated to name which sources contribute.

No changes to `rewriteMember`, `rewriteMembers`, `lookupIfaceMethodContracts`, or `tryRewriteFunction`.

### 7.3 No changes required

- `src/function-rewriter.ts` — `tryRewriteFunction` already accepts `InterfaceMethodContracts | undefined` and prepends those tags to class tags. The merged contract object passed in already contains base class contracts; no changes needed.
- `src/transformer.ts` — no new plugin options are added. `paramMismatch` / `mode` already flows through.
- `src/jsdoc-parser.ts` — no changes.
- `src/ast-builder.ts` — no changes.

### 7.4 Import graph (additions only)

```
class-rewriter.ts
  └── interface-resolver.ts
        ├── resolveInterfaceContracts   (existing)
        └── resolveBaseClassContracts   (new)
```

---

## 8. Merge Behaviour

### 8.1 Method contract merge

Method contracts from the three sources are merged in order: interface → base class → subclass own. Each step calls the existing `mergeMethodContracts` helper:

```
step1 = mergeMethodContracts(undefined, interfaceMethodContracts)
step2 = mergeMethodContracts(step1, baseClassMethodContracts)
// step2 is stored in mergedContracts.methods
// subclass own contracts are merged at rewrite time in tryRewriteFunction
```

The final merge (subclass own tags prepended by the existing `ifaceMethodContracts` parameter in `tryRewriteFunction`) remains unchanged.

### 8.2 `@prev` merge

`@prev` follows the same precedence rule as today: the first non-undefined `prevExpression` in merge order wins (interface → base → subclass). A warning is emitted when multiple sources define `@prev`.

### 8.3 Invariant merge

Invariants from interface, base class, and subclass are concatenated in that order. `resolveEffectiveInvariants` is updated to:

```typescript
function resolveEffectiveInvariants(
  node: typescript.ClassDeclaration,
  reparsedClass: typescript.ClassDeclaration | typescript.Node,
  className: string,
  warn: (msg: string) => void,
  interfaceInvariants: string[],
  baseClassInvariants: string[],    // new parameter
): string[]
```

A merge warning lists all contributing source names (e.g. `IFoo`, `Animal`, and `Dog`) when more than one source contributes invariants.

---

## 9. Parameter Mismatch

### 9.1 Name mismatch (rename mode, default)

If the base class declares `feed(amount: number)` and the subclass declares `feed(qty: number)`, the base class `@pre amount > 0` is rewritten to `@pre qty > 0` before injection. A warning is emitted:

```
[axiom] Parameter name mismatch in Dog.feed:
  base class Animal uses 'amount', subclass uses 'qty' — expression renamed
```

### 9.2 Name mismatch (ignore mode)

All base class contracts for that method are skipped. A warning is emitted:

```
[axiom] Parameter name mismatch in Dog.feed:
  base class Animal uses 'amount', subclass uses 'qty' — contract skipped
```

### 9.3 Count mismatch

If the base class and subclass method have different parameter counts, all base class contracts for that method are skipped unconditionally and a hard warning is emitted:

```
[axiom] Parameter count mismatch in Dog.feed:
  base class Animal has 2 parameters, subclass has 1 — base class contracts skipped
```

### 9.4 Configuration

`ParamMismatchMode` already exists as a plugin option (`interfaceParamMismatch`). The same option governs base class parameter mismatch behaviour — no new option is introduced.

---

## 10. `transpileModule` Mode

When `checker` is `undefined` (transpileModule / ts-jest without Program integration):

- If the class has either an `implements` **or** an `extends` clause, a single warning is emitted:

```
[axiom] Interface contract resolution skipped in <fileName>:
  no TypeChecker available (transpileModule mode) — class-level contracts unaffected
```

This reuses the existing warning text and guard. The `hasImplementsClauses` helper in `src/class-rewriter.ts` is renamed to `hasResolvableHeritageClauses` (or a second check is added inline) to cover both `ImplementsKeyword` and `ExtendsKeyword` clauses.

Class-own contracts continue to function normally in transpileModule mode.

---

## 11. Warning Messages

| Situation | Message |
|---|---|
| Base class contracts resolved, method merge | `[axiom] Contract merge warning in Dog.feed:` ` both Animal and Dog define @pre tags — additive merge applied` |
| Interface + base class + subclass all define @pre | `[axiom] Contract merge warning in Dog.feed:` ` IAnimal, Animal, and Dog all define @pre tags — additive merge applied` |
| Invariant merge (base + subclass) | `[axiom] Contract merge warning in Dog:` ` both Animal and Dog define @invariant tags — additive merge applied` |
| Invariant merge (interface + base + subclass) | `[axiom] Contract merge warning in Dog:` ` IAnimal, Animal, and Dog all define @invariant tags — additive merge applied` |
| Parameter name mismatch, rename mode | `[axiom] Parameter name mismatch in Dog.feed:` ` base class Animal uses 'amount', subclass uses 'qty' — expression renamed` |
| Parameter name mismatch, ignore mode | `[axiom] Parameter name mismatch in Dog.feed:` ` base class Animal uses 'amount', subclass uses 'qty' — contract skipped` |
| Parameter count mismatch | `[axiom] Parameter count mismatch in Dog.feed:` ` base class Animal has 2 parameters, subclass has 1 — base class contracts skipped` |
| TypeChecker unavailable, extends clause present | `[axiom] Interface contract resolution skipped in <fileName>:` ` no TypeChecker available (transpileModule mode) — class-level contracts unaffected` |

---

## 12. Changes Summary

| File | Change |
|---|---|
| `src/interface-resolver.ts` | Add `resolveBaseClassContracts`, `findClassByPos`, `findBaseClassMethodParams`, `extractBaseMethodContracts`, `processBaseClassDeclaration` |
| `src/class-rewriter.ts` | Call `resolveBaseClassContracts`; add `mergeContractSets` helper; extend `resolveEffectiveInvariants` for base invariants; extend transpileModule guard to cover `ExtendsKeyword` |
| `src/interface-resolver.ts` | Export `BaseClassContracts` type |

No changes to `transformer.ts`, `function-rewriter.ts`, `ast-builder.ts`, `jsdoc-parser.ts`, or `contract-validator.ts`.

---

## 13. Testing Plan

### 13.1 Unit tests (`src/interface-resolver.test.ts` or new `src/base-class-resolver.test.ts`)

- `resolveBaseClassContracts` returns empty result when no `extends` clause is present.
- `resolveBaseClassContracts` returns empty result when base class has no contracts.
- `resolveBaseClassContracts` returns method contracts when base class declares `@pre` / `@post` on a matching method.
- `resolveBaseClassContracts` returns base class invariants.
- Parameter name mismatch in rename mode: expressions are rewritten, warning emitted.
- Parameter name mismatch in ignore mode: contracts skipped, warning emitted.
- Parameter count mismatch: contracts skipped, hard warning emitted.

### 13.2 Integration tests (`test/` directory)

- **Basic inheritance**: `Dog extends Animal` — `Animal.feed` has `@pre amount > 0`. Calling `dog.feed(-1)` throws `ContractViolationError`.
- **Post-condition inherited**: `Animal.feed` has `@post this.energy > 0`. Subclass override that violates it throws `ContractViolationError`.
- **Invariant inherited**: `Animal` has `@invariant this.energy >= 0`. Subclass violating the invariant in an overridden method throws `InvariantViolationError`.
- **Additive merge — base + subclass**: Both `Animal.feed` and `Dog.feed` have `@pre`. Both fire; merge warning emitted.
- **Three-way merge — interface + base + subclass**: All three sources have `@pre`. All three fire in order; merge warning lists all three sources.
- **Cross-file base class**: Base class defined in a separate `.ts` file — contracts are still resolved.
- **No override**: Subclass does not override the base method — no double-injection occurs.
- **transpileModule mode**: Warning emitted, class-own contracts still fire normally.
- **Parameter rename**: Base uses `amount`, subclass uses `qty`. Guard uses `qty > 0` in runtime check.
- **Parameter rename with prev**: `@prev` expression references renamed parameters correctly.

### 13.3 Regression

All existing interface contract tests must continue to pass without modification.

---

## 14. Out of Scope

- Transitive (multi-level) inheritance — grandparent and above contracts are not resolved.
- Constructor `@pre` / `@post` from base classes.
- Liskov-aware merging (weakened preconditions, strengthened postconditions).
- `async` method contracts.
- Detecting conflicts between interface and base class contracts on the same method (additive merge only).
- Abstract class method contracts are inherited using the same mechanism; no special-casing of `abstract` is required or performed.
