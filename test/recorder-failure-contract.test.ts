import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RECORDER_DIAGNOSTIC_CATEGORIES,
  RECORDER_FAILURE_CODES,
  RECORDER_STAGES,
} from "../src/recorder/errors.ts";
import { spawnOnce } from "../src/recorder/spawn.ts";

const schema = JSON.parse(readFileSync("schemas/recorder-failure-v1.schema.json", "utf8"));
const diagnosticProperties = schema.properties.recorder.properties.diagnostic.oneOf[1].properties;

test("shipped failure schema vocabulary exactly matches TypeScript", () => {
  assert.deepEqual(schema.properties.recorder.properties.code.enum, [...RECORDER_FAILURE_CODES]);
  assert.deepEqual(diagnosticProperties.stage.enum, [...RECORDER_STAGES]);
  assert.deepEqual(diagnosticProperties.category.enum, [...RECORDER_DIAGNOSTIC_CATEGORIES]);
});

for (const childCase of [
  { name: "exit", source: "process.stdout.write('x'); process.exit(17)", expected: { exitCode: 17, signal: null } },
  { name: "signal", source: "process.stdout.write('x'); process.kill(process.pid, 'SIGTERM')", expected: { exitCode: null, signal: "SIGTERM" } },
] as const) {
  test(`real tee sink failure preserves exact child ${childCase.name} settlement`, async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-tee-test-"));
    const failingSink = join(root, "sink-directory");
    mkdirSync(failingSink);
    const execution = await spawnOnce({
      argv: [process.execPath, "-e", childCase.source], cwd: root, env: process.env,
      stdin: "inherit", stdoutPath: failingSink, stderrPath: join(root, "stderr"),
    });
    const [settlement, tee] = await Promise.all([
      execution.settlement,
      execution.teeCompletion.then(() => "resolved", () => "rejected"),
    ]);
    assert.deepEqual(settlement, childCase.expected);
    assert.equal(tee, "rejected");
  });
}
