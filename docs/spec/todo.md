* Post with result should match the return type 


* Add invariant
* Add contract on interface
* Add 'previous' // @post this.balance === prev - amount 
* Pre post should work with //
* fails to compile:

/**
 * @pre obj?.value > 0
 * @post result === obj ? obj.value + 1 | null
 */ 
export function doOptionalFn(obj: ValueCarrier | null) : number | null {
    return obj ? obj.value + 1 : 0;
}
