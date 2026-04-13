# Async Functions and Generators — Design Doc

**Date:** 2026-04-13
**Covers issue:** #15 (async functions and generators)

---

## 1. Problem

`@pre` and `@post` contracts on `async` functions and `async` class methods are silently broken for post-conditions. The transformer currently treats an `async` function identically to a synchronous one.

Pre-conditions inject correctly: they run synchronously before the async body executes, which is the right behaviour.

Post-conditions do not. The current transform applies `buildBodyCapture`, which wraps the original function body in an IIFE:

```javascript
// what the transformer currently produces for an async function:
const __axiom_result__ = (() => { /* original body */ })();
if (!(__axiom_result__ !== null)) throw new ContractViolationError(…);
return __axiom_result__;
```

For an async function the body IIFE is not itself `async`, so `__axiom_result__` is a `Promise<T>`, not a `T`. The post-condition `result !== null` then compares a `Promise` object to `null`, which always passes. The contract appears to run but checks nothing useful.

For generators (`function*`) the situation is structurally different and harder — each `yield` is a potential check point, not a single return value. Generators are deferred; see Section 3.

### Concrete example

```typescript
/**
 * @pre id > 0
 * @post result !== null
 */
async function findUser(id: number): Promise<User | null> {
  return db.query(id);
}
```

Currently injected (wrong):

```javascript
async function findUser(id) {
  if (!(id > 0)) throw new ContractViolationError('PRE', 'id > 0', 'findUser');
  const __axiom_result__ = (() => { return db.query(id); })();
  // __axiom_result__ is Promise<User | null> here — check is meaningless
  if (!(__axiom_result__ !== null)) throw new ContractViolationError('POST', …);
  return __axiom_result__;
}
```

Target output (correct):

```javascript
async function findUser(id) {
  if (!(id > 0)) throw new ContractViolationError('PRE', 'id > 0', 'findUser');
  const __axiom_result__ = await (async () => { return db.query(id); })();
  if (!(__axiom_result__ !== null)) throw new ContractViolationError('POST', …);
  return __axiom_result__;
}
```

---

## 2. Goals

- `@post` contracts on `async` standalone functions check the **resolved** value, not the `Promise` object.
- `@post` contracts on `async` class methods check the resolved value with the same semantics.
- `result` in a `@post` expression for `async function foo(): Promise<T>` refers to `T`, and type-mismatch detection (in `type-helpers.ts`) unwraps `Promise<T>` to resolve `T` for mismatch checking.
- `@pre` contracts on async functions are unchanged — they already work correctly.
- `@prev` capture on async functions is unchanged — it already captures state synchronously before the body runs, which is correct.
- `@invariant` calls injected into async methods resolve against the resolved value, not the promise (this is already the case for method rewriting; verify it still holds after the body-capture change).
- The fix composes with all existing contract features: interface contracts, `@prev`, `@invariant`, and the identifier-scope system.
- Generators (`function*`) are explicitly deferred and not addressed in this spec.

---

## 3. Non-Goals

- **Generators (`function*`)**: Each `yield` is a potential post-condition point, not a single return. The semantics of `result` for a generator are ambiguous (yielded values vs final return). This is deferred to a future spec.
- **`async function*` (async generators)**: Deferred together with plain generators.
- **`Promise`-returning functions that are not declared `async`**: A function declared `function foo(): Promise<T>` without the `async` keyword is a synchronous function that happens to return a promise. The transformer does not auto-detect this pattern. Only functions with the `async` modifier keyword are affected by this spec.
- **Awaiting `@pre` expressions**: Pre-conditions remain synchronous. Writing `@pre await someCheck()` is not supported and will produce a validation warning (the `await` keyword is not a valid standalone expression identifier).
- **`@invariant` async semantics**: Class invariants are injected at the end of each public method body. For async methods the invariant call fires after `await` resolves (because it is sequenced after the post-check in the rewritten body). No special handling is needed beyond the body-capture fix.

---

## 4. Approach

### 4.1 Async pre-conditions

No change. Pre-condition statements are injected at the top of the function body before the body capture. For an `async` function the injected pre-check statements are synchronous guard statements, which is correct — they execute before the async work begins.

### 4.2 Async post-condition body wrapping

The core problem is in `buildBodyCapture` (`src/ast-builder.ts`). It currently wraps the original body statements in a synchronous IIFE:

```
const __axiom_result__ = (() => { <original statements> })();
```

For an async function, the IIFE must itself be `async` and the call site must `await` it:

```
const __axiom_result__ = await (async () => { <original statements> })();
```

#### Detection

The transformer must know whether the function being rewritten is `async`. The `typescript.FunctionLikeDeclaration` node carries `node.modifiers` (or `typescript.getModifiers(node)`). The presence of `typescript.SyntaxKind.AsyncKeyword` in the modifier list indicates an async function. A small helper is sufficient:

```typescript
function isAsyncFunction(node: typescript.FunctionLikeDeclaration): boolean {
  const modifiers = typescript.canHaveModifiers(node)
    ? typescript.getModifiers(node) ?? []
    : [];
  return modifiers.some((mod) => mod.kind === typescript.SyntaxKind.AsyncKeyword);
}
```

#### `buildBodyCapture` change

`buildBodyCapture` currently takes `originalStatements` and `factory`. It must also accept an `isAsync` flag. When `isAsync` is true:

1. The arrow function wrapping the body gains an `async` modifier token (`typescript.SyntaxKind.AsyncKeyword`).
2. The initialiser expression becomes `await <iife-call>` — an `AwaitExpression` wrapping the `CallExpression`.

Pseudocode for the async path:

```
asyncModifier = factory.createModifier(SyntaxKind.AsyncKeyword)
iife = factory.createCallExpression(
  factory.createArrowFunction(
    [asyncModifier],    // <-- async modifier on the arrow
    undefined, [], undefined, =>Token,
    factory.createBlock(reifiedStatements, true),
  ),
  undefined, [],
)
awaitedIife = factory.createAwaitExpression(iife)

// variable declaration: const __axiom_result__ = await (async () => { … })();
```

The `VariableStatement` and `VariableDeclarationList` construction is otherwise identical to the current synchronous path.

#### Call site change in `buildGuardedStatements`

`buildGuardedStatements` in `src/function-rewriter.ts` calls `buildBodyCapture`. It must pass the `isAsync` flag. The flag flows from `rewriteFunction`, which already has access to `node` and can compute `isAsyncFunction(node)`.

### 4.3 `result` type resolution for `Promise<T>`

In `buildPostParamTypes` (`src/type-helpers.ts`), the return type of an async function as reported by the TypeChecker's `getReturnTypeOfSignature` is `Promise<T>`, which has `TypeFlags.Object`. Under the current code, `resolveSimpleType` returns `'non-primitive'` for it, and the `result` key is set to `'non-primitive'` in the type map — meaning any literal comparison against `result` emits a mismatch warning, even if the resolved `T` is `number`.

The fix: when the declared return type node of an async function is a `Promise<T>` reference, unwrap `T` from the type argument before calling `resolveSimpleType`.

**Detection approach in `buildPostParamTypes`:**

1. Check `isAsyncFunction(node)` (same helper as above, or pass a boolean).
2. If async and the return type is a reference type, call `checker.getTypeArguments(returnType as TypeReference)`.
3. If there is exactly one type argument, use that type argument as the type to resolve via `resolveSimpleType`.
4. If unwrapping fails or there are no type arguments (e.g. `async function foo(): Promise<void>`), fall through to the existing logic, which will return `undefined` for `void` — matching the existing behaviour for synchronous void functions.

This unwrapping is scoped to `buildPostParamTypes` and does not affect `buildParameterTypes` or any other type resolution path.

### 4.4 `returnTypeDescription` and the `@post result` filter

`returnTypeDescription` in `src/function-rewriter.ts` inspects the raw TypeScript type annotation node (`node.type`) to decide whether `@post` expressions that use `result` should be dropped. For a synchronous `void` function it returns `'void'` and the post tag is dropped.

For an async function with return type `Promise<void>`, `node.type` is a `TypeReference` node, not `VoidKeyword`. `returnTypeDescription` currently returns `'ok'` for this case, which means the post tag is kept — but the resolved value is `void`. The behaviour should match the synchronous case: `@post result !== undefined` on an `async (): Promise<void>` function should be warned and dropped.

**Fix in `returnTypeDescription`:** When the type node is a `TypeReference` whose type name is `Promise` and whose single type argument is `void`, `never`, or `undefined`, return the inner keyword string (e.g. `'void'`), matching the behaviour for synchronous functions with those return types.

This fix is narrow: it only applies to `Promise<void>`, `Promise<never>`, and `Promise<undefined>`. Any other `Promise<T>` returns `'ok'` — the post tag is kept and the body-capture fix ensures the resolved value is checked.

### 4.5 `async` class methods

`rewriteMember` in `src/class-rewriter.ts` delegates to `tryRewriteFunction`, which eventually calls `rewriteFunction` and then `buildGuardedStatements`. Because the fix is inside `buildGuardedStatements` / `buildBodyCapture`, async class methods are covered by the same change with no extra class-rewriter logic.

The `isAsyncFunction` helper detects the `async` modifier on `MethodDeclaration` nodes in the same way as on `FunctionDeclaration` nodes — the modifier representation is identical in the TypeScript AST.

### 4.6 Interaction with `@prev`

`buildPrevCapture` emits a `const __axiom_prev__ = <expression>` statement. It is injected before `buildBodyCapture`, meaning `@prev` state is captured synchronously before the async body runs. This is the correct semantics: `prev` represents state at the time the method was called, not the state after the promise resolves. No change is needed.

### 4.7 `@invariant` on async methods

`buildCheckInvariantsCall` emits `this.#checkInvariants(location)`. It is placed after the post-checks in `buildGuardedStatements`, so it runs after `__axiom_result__` is set to the resolved value. The `#checkInvariants` method itself is synchronous (it checks `this` properties, not the return value). Because the surrounding function is `async`, and `#checkInvariants` is called in the `async` IIFE's outer scope (not inside the inner body IIFE), the invariant call executes after the await resolves. This is correct and requires no change.

---

## 5. Changes Summary

| File | Change |
|---|---|
| `src/ast-builder.ts` | `buildBodyCapture` gains an `isAsync: boolean` parameter. When `true`, the arrow function gets an `async` modifier and the call is wrapped in `await`. |
| `src/function-rewriter.ts` | `buildGuardedStatements` gains an `isAsync: boolean` parameter, threaded from `rewriteFunction` via `isAsyncFunction(node)`. New `isAsyncFunction` helper. `returnTypeDescription` gains detection for `Promise<void | never | undefined>`. |
| `src/type-helpers.ts` | `buildPostParamTypes` unwraps `Promise<T>` for async functions before calling `resolveSimpleType`, so `result` type-checking operates on `T` rather than `Promise<T>`. Requires an `isAsync` flag or a direct `isAsyncFunction` check — pass the node and checker. |

No new exported symbols are required. The `isAsyncFunction` helper can be file-private in `function-rewriter.ts`; if `type-helpers.ts` needs the same check it can duplicate the two-liner or accept a boolean from the caller.

---

## 6. Testing Plan

### 6.1 Async standalone functions

- `@post result !== null` on `async function findUser(): Promise<User | null>` — verify the injected post-check fires with the resolved `User | null` value, not a `Promise`.
- `@post result > 0` on `async function count(): Promise<number>` — verify violation throws when the resolved number is `0`.
- `@pre id > 0` on an async function — verify pre-condition still fires synchronously and unchanged.

### 6.2 `async` class methods

- `@post result !== null` on an async method — same semantics as standalone; verify the resolved value is checked.
- Class with `@invariant` and an async method — verify invariant fires after the await resolves, not on the unresolved promise.

### 6.3 `result` type mismatch detection

- `@post result === "ok"` on `async function foo(): Promise<number>` — verify a type-mismatch warning is emitted (resolved type `number` vs string literal).
- `@post result !== null` on `async function foo(): Promise<string>` — no type-mismatch warning (right side is not a primitive literal).
- `@post result !== null` on `async function foo(): Promise<void>` — verify the post tag is dropped with a warning (void return has no meaningful `result`).

### 6.4 `@prev` with async methods

- `@prev { ...this }` with `@post result > prev.count` on an async method — verify `prev` is captured before the body runs and compared against the resolved return value.

### 6.5 Regression

- All existing synchronous post-condition tests must continue to pass without change — the `isAsync: false` path in `buildBodyCapture` must be identical to the current behaviour.

---

## 7. Out of Scope

- **Generators (`function*`)**: Deferred. `yield` semantics make a single `result` post-condition meaningless; the design for generator contracts requires a separate spec.
- **`async function*` (async generators)**: Deferred with generators.
- **Non-`async` functions returning `Promise`**: Not detected. Only the `async` keyword is used as the trigger.
- **Awaiting `@pre` expressions**: Not supported. Pre-conditions remain synchronous guards.
- **`async` constructors**: TypeScript does not allow `async` constructors; no case to handle.
- **`async` arrow functions assigned to variables**: The transformer currently targets `FunctionDeclaration` and `MethodDeclaration` nodes. Async arrow functions stored in `const` variables are not rewritten today and remain out of scope.
