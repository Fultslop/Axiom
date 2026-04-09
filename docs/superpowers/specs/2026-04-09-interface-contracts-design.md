# Interface Contracts — Design Doc

**Date:** 2026-04-09
**Scope:** `@pre`, `@post`, and `@invariant` on TypeScript interfaces; inherited by all implementing classes

---

## 1. Goal

Extend the transformer to recognise contract tags on interface declarations and inject them into every class that implements the interface. This enables true design-by-contract: the interface is the authoritative specification; implementing classes are bound by it automatically.

---

## 2. Syntax

Contracts on interfaces use the same JSDoc tags as on classes and methods. No new tags or syntax.

```typescript
/**
 * @invariant this.balance >= 0
 * @invariant this.owner !== null
 */
interface IBankAccount {
  /**
   * @pre amount > 0
   * @pre amount <= this.balance
   * @post result >= 0
   */
  withdraw(amount: number): number;

  /** @pre amount > 0 */
  deposit(amount: number): void;
}
```

Any class with `implements IBankAccount` automatically receives the contracts — no opt-in annotation required:

```typescript
class BankAccount implements IBankAccount {
  balance = 100;
  owner = 'Alice';

  withdraw(amount: number): number {
    this.balance -= amount;
    return this.balance;
    // @pre amount > 0 and @pre amount <= this.balance injected from interface
    // @post result >= 0 injected from interface
    // #checkInvariants injected from interface @invariant
  }
}
```

---

## 3. Semantics

### 3.1 Which classes are affected

Any class with an `implements` clause referencing the interface — abstract or concrete.

### 3.2 Merge strategy (additive)

Interface contracts and class-level contracts are merged additively. Interface tags fire first, class tags fire after. A warning is always emitted when both sides define contracts for the same target.

| Target | Interface has tags | Class has tags | Result |
|---|---|---|---|
| Method `@pre` | yes | no | interface tags only |
| Method `@pre` | no | yes | class tags only |
| Method `@pre` | yes | yes | **warn** + interface first, then class |
| Method `@post` | same pattern | | same pattern |
| `@invariant` | yes | no | interface invariants only |
| `@invariant` | no | yes | class invariants only |
| `@invariant` | yes | yes | **warn** (once per class) + interface first, then class |

### 3.3 Runtime execution order (unchanged once merged)

```
ENTRY:  @pre checks   (interface pre → class pre, in declaration order)
BODY:   IIFE capture  (when @post or @invariant present)
EXIT:   @post checks  (interface post → class post) → #checkInvariants → return result
```

### 3.4 Warning formats

```
[fsprepost] Contract merge warning in BankAccount.withdraw:
  both IBankAccount and BankAccount define @pre tags — additive merge applied

[fsprepost] Contract merge warning in BankAccount:
  both IBankAccount and BankAccount define @invariant tags — additive merge applied
```

### 3.5 TypeChecker unavailable

When the transformer runs without a `Program` (e.g. `ts.transpileModule` / ts-jest without Program integration), cross-file interface resolution cannot be performed. A warning is emitted and class-level contracts continue to work normally:

```
[fsprepost] Interface contract resolution skipped in <fileName>:
  no TypeChecker available (transpileModule mode) — class-level contracts unaffected
```

---

## 4. Parameter name mismatch

TypeScript allows an implementing class to rename parameters relative to the interface signature. When this occurs, the interface contract expression references names that do not exist in the class method's scope.

### 4.1 Behaviour options

Controlled by the `interfaceParamMismatch` plugin option (default `'rename'`):

**`'rename'` (default):** Map parameter names by position (interface param 0 → class param 0). Rewrite the expression AST to substitute renamed identifiers. Emit a warning:

```
[fsprepost] Parameter name mismatch in BankAccount.withdraw:
  interface IBankAccount uses 'amount', class uses 'value' — expression renamed
```

**`'ignore'`:** Skip the interface `@pre` and `@post` contracts for that method. Interface `@invariant` tags are unaffected (they are class-level and do not reference method parameters). Emit a warning:

```
[fsprepost] Parameter name mismatch in BankAccount.withdraw:
  interface IBankAccount uses 'amount', class uses 'value' — contract skipped
```

### 4.2 Parameter count mismatch

If the interface and class methods have different parameter counts, all interface contracts for that method are skipped and a hard warning is emitted. This is treated as an error condition — no partial rename is attempted:

```
[fsprepost] Parameter count mismatch in BankAccount.withdraw:
  interface IBankAccount has 2 parameters, class has 1 — interface contracts skipped
```

### 4.3 Rename scope

Only parameter identifiers are renamed (by position). `this`, `result`, globals, and module-level names are left unchanged.

Renaming is performed at the expression AST level: the expression string is parsed, `Identifier` nodes matching interface parameter names are replaced with the corresponding class parameter names, and the result is re-printed.

### 4.4 Configuration

```json
{
  "compilerOptions": {
    "plugins": [{
      "transform": "fsprepost/dist/src/transformer",
      "interfaceParamMismatch": "ignore"
    }]
  }
}
```

---

## 5. Architecture

### 5.1 New file: `src/interface-resolver.ts`

Single responsibility: given a class declaration and TypeChecker, return all contracts inherited from implemented interfaces.

```typescript
export type ParamMismatchMode = 'rename' | 'ignore';

export interface InterfaceMethodContracts {
  preTags: ContractTag[];
  postTags: ContractTag[];
}

export interface InterfaceContracts {
  methods: Map<string, InterfaceMethodContracts>;  // keyed by method name
  invariants: string[];
}

export function resolveInterfaceContracts(
  classNode: typescript.ClassDeclaration,
  checker: typescript.TypeChecker,
  reparsedCache: Map<string, typescript.SourceFile>,
  warn: (msg: string) => void,
  paramMismatch: ParamMismatchMode,
): InterfaceContracts
```

Internal algorithm:
1. Walk `heritageClauses` with `ImplementsKeyword`
2. `checker.getTypeAtLocation(expr)` → `type.symbol.declarations` to find interface nodes cross-file
3. Re-parse each interface's source file on demand (cached by `fileName`) with `setParentNodes: true`
4. Extract `@pre`/`@post` from each interface method signature via `extractContractTags`
5. Extract `@invariant` from the interface node via `extractInvariantExpressions`
6. Apply parameter name/count mismatch handling per §4

### 5.2 Modified: `src/class-rewriter.ts`

- `tryRewriteClass` / `rewriteClass` gain `reparsedCache: Map<string, typescript.SourceFile>` and `paramMismatch: ParamMismatchMode` parameters
- `resolveEffectiveInvariants` extended to accept and merge interface invariants (warn on conflict)
- `rewriteMember` passes merged interface method tags to `tryRewriteFunction` alongside class tags

### 5.3 Modified: `src/transformer.ts`

Options type extended:

```typescript
options?: {
  warn?: (msg: string) => void;
  interfaceParamMismatch?: 'rename' | 'ignore';  // default: 'rename'
}
```

`reparsedCache: Map<string, typescript.SourceFile>` created once per `createTransformer` call (shared across all source files in the compilation) and passed into `tryRewriteClass` via `visitNode`.

### 5.4 Import graph

```
transformer.ts
  ├── reparsed-index.ts
  ├── require-injection.ts
  ├── function-rewriter.ts
  │     ├── ast-builder.ts → reifier.ts
  │     ├── node-helpers.ts
  │     ├── type-helpers.ts
  │     └── contract-validator.ts
  └── class-rewriter.ts
        ├── function-rewriter.ts
        ├── ast-builder.ts
        ├── contract-validator.ts
        ├── jsdoc-parser.ts
        └── interface-resolver.ts   ← new
              └── jsdoc-parser.ts
```

---

## 6. Known limitation

If the class renames a parameter and `interfaceParamMismatch` is `'rename'`, the rename is purely positional. If the interface method has rest parameters or overloads, positional mapping may be ambiguous. This case is not handled in this spec — it is deferred to a future spec alongside async method support.

---

## 7. Out of scope

- Implementing multiple interfaces that both define contracts for the same method and detecting conflicts between them (separate spec)
- Liskov-aware merge (OR preconditions, AND postconditions) — see `docs/superpowers/plans/future-liskov-aware-contracts.md`
- `async` methods
- Inherited contracts from base classes (separate spec)
- Constructor contracts from interfaces

---

## 8. Acceptance criteria

- [ ] A class implementing an interface with `@pre` throws `ContractViolationError` when the precondition is violated
- [ ] A class implementing an interface with `@post` throws `ContractViolationError` when the postcondition is violated
- [ ] A class implementing an interface with `@invariant` throws `InvariantViolationError` when the invariant is violated
- [ ] Interface contracts work cross-file (interface in a separate `.ts` file)
- [ ] When both interface and class define `@pre` for the same method, both fire and a merge warning is emitted
- [ ] When both interface and class define `@invariant`, both are in `#checkInvariants` and a merge warning is emitted
- [ ] Parameter name mismatch with `'rename'` (default): guard fires using the class parameter name, warning emitted
- [ ] Parameter name mismatch with `'ignore'`: contract skipped, warning emitted
- [ ] Parameter count mismatch: all interface contracts for that method skipped, warning emitted
- [ ] TypeChecker unavailable: class contracts fire normally, warning about skipped resolution emitted
- [ ] A class with no matching interface contracts is unaffected
- [ ] Release build contains no injected interface contract code
