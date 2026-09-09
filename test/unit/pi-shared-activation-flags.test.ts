/**
 * #819: pi last hop consumes the sole middle-layer activation flag assembly.
 * change-locator: edit projectActivationFlags once → pi argv and shared envelope both move.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RoleTurnActivation, RoleTurnRequest } from "../../src/host-contracts.ts";
import { projectActivationFlags } from "../../src/role-activation-flags.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { buildPiTurnExtraArgs } from "../../src/pi/role-turn-host.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";

function requestFor(
  runDirectory: string,
  activation: RoleTurnActivation,
): RoleTurnRequest {
  return {
    principal: fixturePrincipal(join(runDirectory, "session")),
    activation,
    methods: [],
    continuation: { kind: "initial", prompt: "assignment" },
    cwd: runDirectory,
    home: runDirectory,
    agentDir: join(runDirectory, "agent"),
    runDirectory,
  };
}

/** Pull `--name value` pairs (and bare `--flag`) that match shared activation flag names. */
function activationArgvPairs(
  argv: readonly string[],
  flags: ReadonlyMap<string, boolean | string>,
): string[] {
  const names = new Set([...flags.keys()].map((name) => `--${name}`));
  const pairs: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!names.has(token)) continue;
    pairs.push(token);
    const flagName = token.slice(2);
    const value = flags.get(flagName);
    if (value !== true && value !== false) {
      i += 1;
      pairs.push(argv[i]!);
    }
  }
  return pairs;
}

function expectedArgvPairs(flags: ReadonlyMap<string, boolean | string>): string[] {
  const pairs: string[] = [];
  for (const [name, value] of flags) {
    if (value === false) continue;
    pairs.push(`--${name}`);
    if (value !== true) pairs.push(String(value));
  }
  return pairs;
}

const ACTIVATIONS: readonly RoleTurnActivation[] = [
  { role: "judge" },
  { role: "coder", phase: "apply", taskPath: "/task.md" },
  {
    role: "fixer",
    phase: "plan",
    packetPath: "/packet.json",
    prerequisitesPath: "/pre.json",
  },
  {
    role: "reviewer",
    baseRevision: "abc",
    authorityRefs: ["ref-1"],
    ticketNumber: 42,
  },
  { role: "reviewer", baseRevision: "abc", authorityRefs: [] },
  { role: "merger", inputPath: "/merger.json" },
  {
    role: "collector",
    repo: "o/r",
    pr: "7",
    requestManifestPath: "/manifest.json",
    waitMs: "60000",
  },
  { role: "collector", repo: "o/r" },
  { role: "doctor", casePath: "/case.json" },
  { role: "notary", sourceRun: "/src-run", ticketNumber: 9 },
  { role: "countersign" },
  { role: "gleaner-left", baseRevision: "base" },
  { role: "inspector" },
  { role: "gatekeeper" },
  { role: "navigator" },
  { role: "auditor" },
  { role: "diarist" },
];

test("pi argv activation flags are exactly the shared projectActivationFlags projection", async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), "ak-819-pi-flags-"));
  try {
    for (const activation of ACTIVATIONS) {
      const request = requestFor(runDirectory, activation);
      const flags = projectActivationFlags(request);
      const argv = buildPiTurnExtraArgs(request, piDurablePrincipalAuthority);
      assert.deepEqual(
        activationArgvPairs(argv, flags),
        expectedArgvPairs(flags),
        `activation ${activation.role}`,
      );
    }
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});
