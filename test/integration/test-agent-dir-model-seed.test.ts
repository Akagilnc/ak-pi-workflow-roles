import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { fauxProvider } from "@earendil-works/pi-ai";

import { seedAgentDirModelsJsonFromFaux } from "../helpers/pi-test-harness.ts";

const exec = promisify(execFile);

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
    const harnessUrl = new URL("../helpers/pi-test-harness.ts", import.meta.url).href;
    const source = `
      import { fauxProvider } from "@earendil-works/pi-ai";
      import { seedAgentDirModelsJsonFromFaux } from ${JSON.stringify(harnessUrl)};
      const faux = fauxProvider({ provider: "ak-seed-child", api: "ak-seed-child", tokenSize: { min: 1, max: 1 } });
      try {
        await seedAgentDirModelsJsonFromFaux(faux, process.env.AK_TEST_AGENT_DIR);
        process.exitCode = 2;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    `;
    await exec(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      {
        timeout: 3_000,
        env: { ...process.env, AK_TEST_AGENT_DIR: agentDir },
      },
    );
  });
});
