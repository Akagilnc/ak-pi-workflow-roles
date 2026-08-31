/**
 * Production grok-build isolation seam (#580): createProductionGrokRoleTurnHost
 * binds ephemeral GROK_HOME + S6 seatbelt hang + auth copy to one root outside
 * the retained run ledger; binary still resolves from the operator home.
 */
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installGrokPreToolUseDeny } from "../../src/grok/bash-seatbelt.ts";
import { createProductionGrokRoleTurnHost } from "../../src/grok/production-host.ts";
import type { DurablePrincipalAuthority, RoleTurnRequest } from "../../src/host-contracts.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

const principalAuthority: DurablePrincipalAuthority = {
  async resolve() {
    return { kind: "anonymous" } as never;
  },
  async bind() {},
};

function under(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

test("production host executeTurn binds seatbelt, GROK_HOME, and auth to one home outside the run ledger", async () => {
  const operatorHome = await mkdtemp(join(tmpdir(), "ak-grok-op-"));
  const runDirectory = await mkdtemp(join(tmpdir(), "ak-grok-run-"));
  try {
    await mkdir(join(operatorHome, ".grok"), { recursive: true });
    await writeFile(join(operatorHome, ".grok", "auth.json"), "SECRET-AUTH\n", "utf8");

    let observed:
      | {
          adapterHome: string;
          operatorHome: string;
          controlledHome: string;
          binary: string;
          grokHome: string | undefined;
          childHome: string | undefined;
          auth: string;
          seatbeltPresent: boolean;
          operatorHooksPresent: boolean;
        }
      | undefined;

    const host = createProductionGrokRoleTurnHost({
      packageRoot,
      principalAuthority,
      // Observe the exact request production passes into the S6 adapter slot.
      createInnerHost: ({ getTurn }) => ({
        async executeTurn(adapterRequest) {
          const turn = getTurn();
          // S6 hangs the Fixer seatbelt on request.home — same contract production must satisfy.
          await installGrokPreToolUseDeny(adapterRequest.home);
          let operatorHooksPresent = true;
          try {
            await access(join(turn.operatorHome, "hooks"));
          } catch {
            operatorHooksPresent = false;
          }
          observed = {
            adapterHome: adapterRequest.home,
            operatorHome: turn.operatorHome,
            controlledHome: turn.controlledHome,
            binary: turn.binary,
            grokHome: turn.env.GROK_HOME,
            childHome: turn.env.HOME,
            auth: await readFile(join(adapterRequest.home, "auth.json"), "utf8"),
            seatbeltPresent: true,
            operatorHooksPresent,
          };
          // Confirm seatbelt file landed on the adapter home (throws if missing).
          await readFile(join(adapterRequest.home, "hooks", "ak-bash-seatbelt.json"), "utf8");
          return { code: 0, stderr: "", timedOut: false };
        },
      }),
    });

    const request = {
      home: operatorHome,
      runDirectory,
      cwd: runDirectory,
      agentDir: join(operatorHome, "agent"),
      activation: { role: "fixer" as const },
      methods: [],
      continuation: { kind: "initial" as const, prompt: "x" },
      principal: {} as RoleTurnRequest["principal"],
    } as RoleTurnRequest;

    assert.equal((await host.executeTurn(request)).code, 0);
    assert.ok(observed, "inner executeTurn must run");

    // Single root: adapter home (S6 seatbelt) === child GROK_HOME === auth root.
    assert.equal(observed.adapterHome, observed.controlledHome);
    assert.equal(observed.grokHome, observed.controlledHome);
    assert.equal(observed.childHome, observed.controlledHome);
    assert.equal(observed.auth, "SECRET-AUTH\n");
    assert.equal(observed.seatbeltPresent, true);

    // Not the operator home, not under the retained run ledger.
    assert.notEqual(observed.adapterHome, operatorHome);
    assert.equal(under(runDirectory, observed.adapterHome), false);
    await assert.rejects(access(join(runDirectory, "grok-home")));
    assert.equal(observed.operatorHooksPresent, false);

    // Binary still resolved from the operator home (not the ephemeral controlled root).
    assert.equal(observed.operatorHome, operatorHome);
    assert.equal(observed.binary, join(operatorHome, ".grok", "bin", "grok"));
    assert.equal(under(observed.controlledHome, observed.binary), false);
  } finally {
    await rm(operatorHome, { recursive: true, force: true });
    await rm(runDirectory, { recursive: true, force: true });
  }
});
