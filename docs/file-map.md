# File Map

Responsibilities of each source file and what each file deliberately does not do.

---

## Dependency graph

```mermaid
graph TD
    transformer --> class-rewriter
    transformer --> function-rewriter
    transformer --> jsdoc-parser
    transformer --> reparsed-index
    transformer --> require-injection
    transformer --> tag-pipeline
    transformer --> transformer-context

    class-rewriter --> ast-builder
    class-rewriter --> function-rewriter
    class-rewriter --> interface-resolver
    class-rewriter --> jsdoc-parser
    class-rewriter --> tag-pipeline
    class-rewriter --> contract-validator
    class-rewriter --> node-helpers
    class-rewriter --> keep-contracts

    function-rewriter --> ast-builder
    function-rewriter --> jsdoc-parser
    function-rewriter --> tag-pipeline
    function-rewriter --> node-helpers
    function-rewriter --> type-helpers
    function-rewriter --> keep-contracts

    ast-builder --> reifier

    tag-pipeline --> contract-validator
    tag-pipeline --> jsdoc-parser
    tag-pipeline --> contract-utils
    tag-pipeline --> type-helpers
```

---

## File responsibilities

| File | Does | Does NOT do |
|---|---|---|
| [transformer.ts](../src/transformer.ts) | Entry point. Reads the `keepContracts` file directive, walks every top-level node, dispatches to `class-rewriter` or `function-rewriter`. | Does not build any AST nodes. Does not read JSDoc tags directly. |
| [jsdoc-parser.ts](../src/jsdoc-parser.ts) | Reads `@pre`, `@post`, `@invariant`, `@prev` tags from a node and returns typed `ContractTag` objects and raw expression strings. | Does not validate whether expressions are correct. Does not filter. |
| [tag-pipeline.ts](../src/tag-pipeline.ts) | Validates each tag expression — checks that all referenced identifiers are in scope, drops tags that reference `result` on `void` functions, adds implicit `prev` capture for methods. Returns the final `preTags`, `postTags`, `prevCapture` to use. | Does not read JSDoc. Does not build AST nodes. |
| [contract-validator.ts](../src/contract-validator.ts) | Parses a contract expression string and checks whether each identifier it references is declared (parameter, `this`, `result`, `prev`, type-checker scope, or allowlist). Returns a list of validation errors. | Does not filter or modify tags — only reports errors. |
| [reifier.ts](../src/reifier.ts) | Rebuilds expression and statement AST nodes using factory calls, producing synthetic nodes (`pos = -1`) that carry no source-file dependency and can be emitted against any output file. | Does not validate expressions. Does not understand what a contract is. |
| [ast-builder.ts](../src/ast-builder.ts) | Constructs the actual injected statements: pre-guard `if` blocks, post-guard `if` blocks, body-capture IIFEs, `prev` capture, `#checkInvariants()` method, and `throw` statements. Uses `reifier.ts` to synthesize expressions. | Does not traverse the AST. Does not read JSDoc. |
| [function-rewriter.ts](../src/function-rewriter.ts) | Assembles the new function body — pre-guards, optional `prev` capture, body-capture IIFE, post-guards, invariant call, return — and returns an updated function node. Also handles nested function-like nodes inside a function body. | Does not handle class-level concerns (invariant method injection, interface contracts). |
| [class-rewriter.ts](../src/class-rewriter.ts) | Iterates over class members, calls `function-rewriter` for each public method, rewrites the constructor, and injects the `#checkInvariants()` private method. Merges contracts from interfaces and base classes. | Does not handle standalone functions or arrow functions at module scope. |
| [interface-resolver.ts](../src/interface-resolver.ts) | Uses the TypeScript type checker to find interfaces and base classes that a class implements/extends, then reads their contract tags and adapts parameter names to match the implementing class. | Does not rewrite any code. Only resolves and returns contracts. |
| [reparsed-index.ts](../src/reparsed-index.ts) | Re-parses a source file with `setParentNodes: true` and builds lookup maps (`pos → FunctionLikeDeclaration`, `pos → ClassDeclaration`). The compiler-provided AST lacks parent links, so `getJSDocTags()` returns nothing on it — reparsed nodes are used to read JSDoc instead. | Does not modify the original AST. |
| [keep-contracts.ts](../src/keep-contracts.ts) | Encodes the `keepContracts` flag logic: `shouldEmitPre`, `shouldEmitPost`, `shouldEmitInvariant`. | Nothing else. |
| [require-injection.ts](../src/require-injection.ts) | Builds the `require('@fultslop/axiom')` import statement that is prepended to any file that had contracts injected. | Nothing else. |
| [node-helpers.ts](../src/node-helpers.ts) | Utility functions: build location name strings (`Account.withdraw`), extract known identifier sets from a function's parameters and locals, get source location strings for warnings. | No single domain focus — pure utilities. |
| [type-helpers.ts](../src/type-helpers.ts) | Uses the type checker to resolve parameter types and return types, used by `tag-pipeline.ts` to detect `void` returns and `Promise<void>` async functions. | Does not modify nodes. |
| [contract-utils.ts](../src/contract-utils.ts) | Shared constants (`KIND_PRE`, `KIND_POST`) and small predicates (`expressionUsesResult`, `expressionUsesPrev`). | Nothing else. |
| [transformer-context.ts](../src/transformer-context.ts) | TypeScript type definition for the `TransformerContext` object threaded through the pipeline. | No runtime behaviour. |
| [assertions.ts](../src/assertions.ts) | Runtime `pre()` and `post()` assertion functions for manual use inside function bodies. | Not part of the compile-time transformer path. |
| [contract-error.ts](../src/contract-error.ts) / [contract-violation-error.ts](../src/contract-violation-error.ts) / [invariant-violation-error.ts](../src/invariant-violation-error.ts) | Runtime error classes thrown by injected guards. | Not part of the compile-time transformer path. |
| [index.ts](../src/index.ts) | Public package exports: error classes, assertion utilities, `snapshot`, `deepSnapshot`. | Nothing about the transformer internals. |
