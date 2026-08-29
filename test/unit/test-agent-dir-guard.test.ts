import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fauxProvider } from "@earendil-works/pi-ai";

import {
  assertWritableTestAgentDir,
  realMachineAgentDir,
} from "../helpers/test-agent-dir-guard.ts";
import { seedAgentDirModelsJsonFromFaux } from "../helpers/pi-test-harness.ts";

test("models.json test fixture fails closed outside an explicit isolated agentDir", async () => {
  assert.throws(
    () => assertWritableTestAgentDir(undefined),
    /explicitly provided/,
  );
  assert.throws(
    () => assertWritableTestAgentDir(realMachineAgentDir()),
    /machine agentDir/,
  );
  assert.throws(
    () => assertWritableTestAgentDir(join(realMachineAgentDir(), "nested")),
    /machine agentDir/,
  );

  const root = await mkdtemp(join(tmpdir(), "ak-model-seed-"));
  const fresh = join(root, "fresh-agent");
  const malformed = join(root, "malformed-agent");
  const faux = fauxProvider({
    provider: "ak-model-seed-test",
    api: "ak-model-seed-test",
    tokenSize: { min: 1, max: 1 },
  });
  try {
    await mkdir(fresh, { recursive: true });
    const seeded = await seedAgentDirModelsJsonFromFaux(faux, fresh);
    await seeded.close();

    await mkdir(malformed, { recursive: true });
    await writeFile(join(malformed, "models.json"), "{not-json", "utf8");
    await assert.rejects(
      seedAgentDirModelsJsonFromFaux(faux, malformed),
      SyntaxError,
      "malformed models.json must retain its parse failure; the seeded mock server closes before rejection",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
