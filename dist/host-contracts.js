import { Type } from "typebox";
/**
 * Thrown activation failure with a production-owned typed cause.
 * Prefer this over ad-hoc Error property tags so settlement retains typed identity.
 * Final owner = host contract (#526); public-cli/pi/role-runtime all import here.
 */
export class ExplicitInternalActivationError extends Error {
    knownCause;
    failureCode;
    constructor(message, options) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = options.name ?? "ExplicitInternalActivationError";
        this.knownCause = options.knownCause;
        if (options.code !== undefined) {
            this.failureCode = options.code;
        }
    }
}
/** Local replacement for Pi AI's convenience constructor. */
export function stringEnum(values, options = {}) {
    return Type.Union(values.map((value) => Type.Literal(value)), options);
}
