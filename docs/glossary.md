# Glossary

Terms used in the Axiom codebase, mapped to plain equivalents.

---

## Contract

A boolean TypeScript expression extracted from a JSDoc tag that asserts something about a function's inputs or outputs. Contracts are the core unit of the library — every other concept exists to inject them into compiled code.

---

## Tag

A single JSDoc annotation on a function or class: `@pre`, `@post`, `@invariant`, or `@prev`. A tag has a kind (which annotation type it is) and an expression (the text after the `@tag` keyword).

```typescript
/**
 * @pre amount > 0           ← kind: 'pre',  expression: 'amount > 0'
 * @post result >= 0         ← kind: 'post', expression: 'result >= 0'
 */
```

---

## Reify

**Plain meaning: make a parsed AST node position-independent by rebuilding it from scratch using factory calls.**

TypeScript AST nodes parsed from source carry `pos` and `end` offsets pointing into their source file's text buffer. If you try to emit such a node against a *different* source file, the printer reads the wrong bytes. `reifyExpression` / `reifyStatement` in [reifier.ts](../src/reifier.ts) walk the node tree and reconstruct every node via `factory.create*()`, producing nodes with `pos = -1`. Those synthetic nodes carry no source-file dependency and can be safely printed anywhere.

Renamed equivalents in other compilers/code-generators: *synthesize*, *clone without positions*, *detach from source*.

---

## Synthetic node

An AST node created by `factory.create*()` rather than parsed from source. Synthetic nodes have `pos = -1`. The TypeScript printer omits JSDoc when it encounters a synthetic node — this is intentional, used to strip contract tags in release builds.

---

## Guard statement

An injected `if` statement that checks a contract expression and throws when it is false. Pre-guards run before the original function body; post-guards run after.

```typescript
// injected @pre guard
if (!(amount > 0)) {
  throw new ContractViolationError('PRE', 'amount > 0', 'Account.withdraw');
}
```

---

## Body capture

The technique used to make the function's return value available to `@post` checks. The original function body is wrapped in an immediately-invoked function expression (IIFE) and its return value is stored in `__axiom_result__`. Post-guards then reference `__axiom_result__` via the user-facing alias `result`.

---

## `result` / `prev`

Alias identifiers available inside `@post` expressions:

- **`result`** — the value returned by the function (internally `__axiom_result__`).
- **`prev`** — a snapshot of state captured before the function body ran (internally `__axiom_prev__`). Populated by a `@prev` tag, or automatically as `{ ...this }` for methods that reference `prev` without a `@prev` tag.

---

## keepContracts

A compile-time flag (`false` | `'pre'` | `'post'` | `'invariant'` | `'all'`) that controls which contract types survive a release build. Default is `false` — all contracts are stripped. Library authors use the `// @axiom keepContracts` file-level directive to retain contracts in published code.

---

## ReparsedIndex

The TypeScript compiler delivers AST nodes to transformers without `setParentNodes: true`, which means `getJSDocTags()` returns nothing on those nodes. To work around this, the transformer re-parses each source file independently with `setParentNodes: true` and builds a lookup map (`pos → node`). Contract tags are read from the reparsed counterpart, not the original.

---

## TransformerContext

The shared bag of state threaded through every function in the pipeline: the AST factory, the type checker, the `warn` callback, `keepContracts` setting, the reparsed index, and a `transformed` flag that tells the outer loop whether to prepend the runtime import.

---

## Location name

A human-readable string identifying where a contract violation occurred, used in error messages: `Account.withdraw`, `add`, `BankAccount`. Built in [node-helpers.ts](../src/node-helpers.ts) from the enclosing class name and method name.

---

## Fork (a library)

Copying a third-party library's source code into your own project so you can modify it directly. Once forked, the copy diverges from the original — you own the changes but must manually re-apply upstream bug fixes and updates for as long as you maintain the fork.

The alternative is to use the library as an external dependency and drive its behaviour through configuration options or extension points it already exposes. `TransformerOptions` exists precisely so consumers don't have to fork the transformer just to change how warnings or parameter mismatches are handled.

The term shares its metaphor with git forks: one codebase splits into two diverging copies.

---

## Interface contract

A contract declared on an interface method that is automatically applied to all implementing classes. Resolved by [interface-resolver.ts](../src/interface-resolver.ts) using the TypeScript type checker. Requires `isolatedModules: false`.
