import { inspect } from "node:util";

/** Record the whole thrown value without invoking its getters or custom formatter. */
export function serializeThrownValue(value: unknown): string {
  return inspect(value, {
    depth: null,
    maxArrayLength: null,
    maxStringLength: null,
    showHidden: true,
    customInspect: false,
  });
}
