/**
 * #959: required package-owned durable session entry flush failure must not
 * close as accepted — reuse typed infrastructure-failure channel.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

test("#959 durable session entry flush failure is infrastructure not accepted", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-959-durable-write-"));
  try {
    const runDirectory = join(home, ".ak-roles", "books", "probe", "runs", "run-959@navigator");
    const sessionDir = join(runDirectory, "session");
    await mkdir(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, "session.jsonl");
    const socketPath = join(home, "mcp.sock");
    // Temp seat table only — never touch the real public-cli.json (席位表法).
    await mkdir(join(home, ".ak-roles"), { recursive: true });
    await writeFile(
      join(home, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ seats: { navigator: { provider: "provider", model: "model" } } }, null, 2)}\n`,
    );

    const prepared = await prepareRoleEnvelope({
      request: {
        principal: fixturePrincipal(sessionDir),
        activation: { role: "navigator" },
        methods: [],
        continuation: { kind: "initial", prompt: "durable flush probe" },
        cwd: packageRoot,
        home,
        agentDir: join(home, "agent"),
        runDirectory,
        // Skip automatic nested attendance — not under test here.
        stationChild: true,
      },
      dependencies: createRoleRuntimeDependencies(packageRoot),
      socketPath,
      sessionFile,
    });
    try {
      // Lock only the durable principal file so package-owned append fails.
      await chmod(sessionFile, 0o444);

      await prepared.ingestStructuredOutput({ prose: "下一步送 reviewer" });
      const closed = await prepared.closeRound();
      assert.equal(closed.accepted, false, "flush failure must not report accepted");
      assert.equal("failure" in closed, true, "typed infrastructure failure required");
      const failure = "failure" in closed ? closed.failure : undefined;
      assert.ok(failure !== undefined);
      assert.equal(failure?.identity?.code, "durable-session-write-failed");
      assert.equal(failure?.cause, "output");
      assert.match(String(failure?.diagnostic ?? ""), /durable session entry flush failed/);
    } finally {
      await chmod(sessionFile, 0o644).catch(() => undefined);
      await prepared.dispose?.();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
