
* Add invariant
* Add contract on interface
* Post with result should have the user define a return type 
* Add 'previous' // @post this.balance === prev - amount 


/**
 * @pre obj?.value > 0
 * @post result === obj ? obj.value + 1 | null
 */ 
export function doOptionalFn(obj: ValueCarrier | null) : number | null {
    return obj ? obj.value + 1 : 0;
}
