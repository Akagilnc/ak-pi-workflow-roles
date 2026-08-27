import { Type } from "typebox";
export function isHostToolCall(part) {
    return part.type === "toolCall" && "id" in part && "name" in part;
}
/** Local replacement for Pi AI's convenience constructor. */
export function stringEnum(values, options = {}) {
    return Type.Union(values.map((value) => Type.Literal(value)), options);
}
