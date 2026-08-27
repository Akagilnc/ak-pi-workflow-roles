import { Type } from "typebox";
/** Local replacement for Pi AI's convenience constructor. */
export function stringEnum(values, options = {}) {
    return Type.Union(values.map((value) => Type.Literal(value)), options);
}
