import assert from "node:assert/strict";
import test from "node:test";

import { validateAcceptedWorkerDetails } from "../../src/package-contracts/worker-output.ts";
import { completed } from "../helpers/fixer-fixtures.ts";

// Judge class grammar/uniqueness negatives live in judge-output-contract.test.ts
// ("mixed and blank verdict shapes reject with named status diagnostics").

test("current Fixer settlement is independent while Coder remains byte-compatible and closed", () => {
  const fixer = { status: "completed", report: "done", classResults: [completed()] };
  assert.deepEqual(validateAcceptedWorkerDetails(fixer, "Fixer"), fixer);
  assert.deepEqual(
    validateAcceptedWorkerDetails({ status: "completed", report: "done", commitSha: "advisory" }, "Coder"),
    { status: "completed", report: "done", commitSha: "advisory" },
  );
  assert.throws(() => validateAcceptedWorkerDetails(fixer, "Coder"), /Coder output/);
  assert.throws(
    () => validateAcceptedWorkerDetails({ status: "completed", report: "old", classesRepaired: [] }, "Fixer"),
    /Fixer output/,
  );
});
