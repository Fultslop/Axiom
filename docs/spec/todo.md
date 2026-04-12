* Export all failing acceptance tests and implement the gaps, where possible or call them out as hard constraints:

| 6 | #6 — Template literals (full reifier support) | M | [template-literals](2026-04-10-template-literals-design.md) |
| 7 | #9 — Multi-level property chains | L | [property-chain-validation](2026-04-10-property-chain-validation-design.md) |
| 8 | #11 — Compound conditions / type narrowing | XL | (deferred — no spec yet) |

* liskov aware contracts
* option hard compile to pre post conditions/invariants into release as well, per module, per file 


/**
 * @pre obj?.value > 0
 * @post result === obj ? obj.value + 1 | null
 */ 
export function doOptionalFn(obj: ValueCarrier | null) : number | null {
    return obj ? obj.value + 1 : 0;
}
