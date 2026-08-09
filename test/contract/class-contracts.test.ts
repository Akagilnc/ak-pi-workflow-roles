import assert from "node:assert/strict";
import test from "node:test";

import { validateAcceptedWorkerDetails } from "../../src/package-contracts/worker-output.ts";

test("current Fixer and Coder settlements use open runtime projection", () => {
  const fixer = { status: "completed", report: "done", presentation: "opaque" };
  const coder = { status: "completed", report: "done", presentation: "opaque" };
  assert.equal(validateAcceptedWorkerDetails(fixer, "Fixer"), fixer);
  assert.equal(validateAcceptedWorkerDetails(coder, "Coder"), coder);
});
