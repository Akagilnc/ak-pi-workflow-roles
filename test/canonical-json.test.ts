import assert from "node:assert/strict";
import test from "node:test";

import { CANONICAL_JSON_VALIDATION_ERROR_CODE, CanonicalJsonValidationError, canonicalJson, canonicalJsonBytes } from "../src/canonical-json.ts";

test("Doctor consumers share recursive canonical JSON semantics", () => {
  const left = { zebra: [3, { beta: true, alpha: null }], alpha: "value" };
  const right = { alpha: "value", zebra: [3, { alpha: null, beta: true }] };
  const expected = '{"alpha":"value","zebra":[3,{"alpha":null,"beta":true}]}';
  assert.equal(canonicalJson(left), expected);
  assert.equal(canonicalJson(right), expected);
  assert.deepEqual(canonicalJsonBytes(left), canonicalJsonBytes(right));
});

test("canonical JSON rejects the closed domain counterexamples with typed structural paths", () => {
  const sparse = Array(1);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  const objectSymbol = {}; Object.defineProperty(objectSymbol, Symbol("alias"), { value: undefined });
  const arrayExtra: unknown[] = []; Object.defineProperty(arrayExtra, "extra", { value: undefined });
  const cases: Array<[unknown, string]> = [
    [[undefined], "$/0"], [Number.NaN, "$"], [new Date(0), "$"],
    [{ nested: Infinity }, "$/nested"], [sparse, "$/0"], [cyclic, "$/self"],
    [objectSymbol, "$/<symbol>"], [arrayExtra, "$/extra"],
    [new (class extends Array<number> {})(1), "$"], [1n, "$"], [Symbol("x"), "$"], [() => undefined, "$"],
  ];
  for (const [value, path] of cases) assert.throws(
    () => canonicalJson(value),
    (error) => error instanceof CanonicalJsonValidationError && error.code === CANONICAL_JSON_VALIDATION_ERROR_CODE && error.path === path,
  );
});

test("canonical JSON does not relabel unexpected proxy and property failures", () => {
  const ownKeysFailure = new Error("ownKeys exploded");
  assert.throws(() => canonicalJson(new Proxy({}, { ownKeys() { throw ownKeysFailure; } })), (error) => error === ownKeysFailure);
  const propertyFailure = new Error("getter exploded");
  const value = Object.defineProperty({}, "field", { enumerable: true, get() { throw propertyFailure; } });
  assert.throws(() => canonicalJson(value), (error) => error === propertyFailure);
});
