import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fauxProvider } from "@earendil-works/pi-ai";

import { seedAgentDirModelsJsonFromFaux } from "../helpers/pi-test-harness.ts";

const faux = fauxProvider({
  provider: "ak-model-seed-test",
  api: "ak-model-seed-test",
  tokenSize: { min: 1, max: 1 },
});

async function withAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ak-model-seed-"));
  try {
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    return await run(agentDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("models.json seed treats ENOENT as a fresh file", async () => {
  await withAgentDir(async (agentDir) => {
    const seeded = await seedAgentDirModelsJsonFromFaux(faux, agentDir);
    try {
      const parsed = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8"));
      assert.ok(parsed.providers["ak-model-seed-test"]);
    } finally {
      await seeded.close();
    }
  });
});

test("models.json malformed seed closes its listener before rejecting", async () => {
  await withAgentDir(async (agentDir) => {
    await writeFile(join(agentDir, "models.json"), "{not-json", "utf8");
    // Contract: parse failure must close the mock listener before throw (not a wall-clock hang probe).
    await assert.rejects(
      () => seedAgentDirModelsJsonFromFaux(faux, agentDir),
      (error: unknown) => error instanceof SyntaxError,
    );
    // Listener released: rewrite valid JSON and seed again — proves prior mock closed (no leaked server).
    await writeFile(join(agentDir, "models.json"), "{}", "utf8");
    const seeded = await seedAgentDirModelsJsonFromFaux(faux, agentDir);
    try {
      const parsed = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8"));
      assert.ok(parsed.providers["ak-model-seed-test"]);
    } finally {
      await seeded.close();
    }
  });
});
