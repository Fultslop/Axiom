* loop (for, while, switch) functions currently fail
* syntax errors should throw during build but make sure errors
 are collected not throw at the 
* Add invariant
* Should fail compile on missing name
* Add 'previous' // @post this.balance === prev - amount 
* Post with result should match the return type 
* Pre post should work with //
* fails to compile:

/**
 * @pre obj?.value > 0
 * @post result === obj ? obj.value + 1 | null
 */ 
export function doOptionalFn(obj: ValueCarrier | null) : number | null {
    return obj ? obj.value + 1 : 0;
}
