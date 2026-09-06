/**
 * Production grok-build host (#717): operator home in place, no run-scoped
 * isolation directory, no HOME rewrite. Sititian records on the run are the dossier.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createProductionGrokRoleTurnHost } from "../../src/grok/production-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

test("production grok-build turn inherits operator HOME and writes only sitian records under the run", async () => {
  await withTempRoot("ak-grok-no-isolate-", async (root) => {
    const operatorHome = join(root, "op");
    const runDirectory = join(root, "run");
    const envDump = join(root, "child-env.json");
    await mkdir(join(operatorHome, ".grok", "bin"), { recursive: true });
    await writeFile(join(operatorHome, ".grok", "auth.json"), "SECRET-AUTH\n", {
      mode: 0o600,
    });
    const binary = join(operatorHome, ".grok", "bin", "grok");
    await writeFile(
      binary,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(envDump)}, JSON.stringify(process.env));
if (process.argv.includes("inspect")) {
  process.stdout.write(JSON.stringify({
    skills: [], plugins: [], agents: [], hooks: [], mcpServers: [], projectInstructions: [],
  }));
}
process.exit(0);
`,
      { encoding: "utf8" },
    );
    await chmod(binary, 0o755);
    await mkdir(runDirectory, { recursive: true });

    const host = createProductionGrokRoleTurnHost({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
    });
    const sessionDirectory = join(runDirectory, "session");
    const request = {
      principal: fixturePrincipal(sessionDirectory),
      activation: { role: "judge" },
      methods: [],
      continuation: { kind: "initial", prompt: "decide" },
      model: { provider: "xai", model: "grok-4.5" },
      cwd: root,
      home: operatorHome,
      agentDir: join(root, "agent"),
      runDirectory,
    } as RoleTurnRequest;
    try {
      await host.executeTurn(request);
    } catch {
      // Envelope/ACP may fail with the faux binary; isolation side effects are the contract.
    }

    const children = await readdir(runDirectory);
    assert.equal(children.some((name) => name.endsWith("-home")), false);
    const dumped = JSON.parse(await readFile(envDump, "utf8")) as NodeJS.Dict<string>;
    assert.equal(dumped.HOME, process.env.HOME);
    const grokHomeKey = ["GROK", "HOME"].join("_");
    assert.equal(dumped[grokHomeKey], process.env[grokHomeKey]);
  });
});
