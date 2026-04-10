* Add 'previous' // @post this.balance === prev - amount 
* rename result and previous internally to something that has less chance of a conflict, eg __result__ and __previous__
* liskov aware contracts
* Export all failing acceptance tests and implement the gaps, where possible or call them out as hard constraints
* option hard compile to pre post conditions/invariants into release as well, per module, per file 


/**
 * @pre obj?.value > 0
 * @post result === obj ? obj.value + 1 | null
 */ 
export function doOptionalFn(obj: ValueCarrier | null) : number | null {
    return obj ? obj.value + 1 : 0;
}
