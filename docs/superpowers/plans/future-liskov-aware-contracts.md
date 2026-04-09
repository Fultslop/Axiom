# Future Spec Stub: Liskov-Aware Contract Merge

**Status:** Deferred — not yet scheduled
**Depends on:** `2026-04-09-interface-contracts-design.md` (additive merge, spec 004)

---

## Problem

The current additive merge strategy (spec 004) concatenates interface and class contract tags and injects all of them. This violates the Liskov Substitution Principle for preconditions:

> A subtype must not strengthen preconditions. Callers written against the interface only know about the interface's `@pre` constraints. If the class adds additional `@pre` constraints, those callers cannot satisfy them — breaking substitutability.

For postconditions the situation is reversed: a subtype may only strengthen (not weaken) postconditions, and additive merge (AND) happens to be correct there.

---

## What Liskov-aware merge would look like

**Preconditions (`@pre`):** class `@pre` tags are OR'd with interface `@pre` tags, not stacked. The generated guard becomes a single negated disjunction:

```typescript
// Interface: @pre amount > 0
// Class:     @pre amount < 10000
// Liskov merge produces:
if (!(amount > 0 || amount < 10000))
  throw new ContractViolationError('PRE', ...);
```

This means the class *weakens* the precondition: either condition being true is sufficient. Callers against the interface satisfy `amount > 0` and are automatically covered.

**Postconditions (`@post`):** additive (AND) is already correct for LSP. No change needed.

**Invariants:** class invariants must imply the interface invariant. In practice this means AND, which is what additive merge already does. No change needed.

---

## Trade-offs vs additive merge

| Dimension | Additive (current) | Liskov-aware |
|---|---|---|
| Implementation complexity | Low — concatenate tag lists | High — detect which tags come from interface vs class, generate compound OR expressions |
| AST complexity | N independent `if (!cond)` guards | One `if (!(A \|\| B \|\| ...))` guard per merge site |
| Correctness | Violates LSP for preconditions | Correct per formal DbC theory |
| User mental model | Familiar — every `@pre` you write fires | Counterintuitive — class `@pre` may silently not fire if the interface `@pre` passes |
| Warning usefulness | "Both define @pre — additive merge" is clear | "Precondition weakened" is hard to explain without DbC background |
| Multiple interface conflicts | Not detected | Natural extension point — OR across all interfaces |

---

## When to implement

This spec becomes worthwhile when:

1. Multi-interface conflict detection is in scope (the OR-of-preconditions model is essential there), OR
2. Users report that the additive merge causes false positives in their test suites because class `@pre` tags block calls that the interface legitimately permits

Until then, additive merge with a warning is the correct default — it is conservative (more enforcement, not less) and transparent.

---

## Relationship to multi-interface conflict detection

When a class implements two interfaces that both define `@pre` for the same method, Liskov-aware merge is the only theoretically sound resolution: the effective precondition is the OR of all interface preconditions. Additive merge would require callers to satisfy ALL interface preconditions simultaneously, which may be impossible if the interfaces were designed independently.

This is the natural forcing function for implementing this spec.
