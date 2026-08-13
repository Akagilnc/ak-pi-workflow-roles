import assert from "node:assert/strict";
import { chmodSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import {
  activationBookDirectory,
  resolveActivationLedgerHome,
} from "../../src/activation-ledger-topology.ts";
import { dispatchSelectedTicketRole } from "../../src/factory-board-ticket-dispatch.ts";
import {
  DISPATCH_LEASE_PENDING_FILE,
  TICKET_BINDING_EVENT,
  TicketDispatchLeaseHeldError,
} from "../../src/ticket-dispatch-lease.ts";
import { DISPATCH_STUB_EVENT } from "../../src/activation-reconciliation.ts";

const packageRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
const tsxLoaderPath = createRequire(import.meta.url).resolve("tsx/esm");

async function withLedgerHome<T>(scenario: (ledgerHome: string, home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-board-dispatch-"));
  try {
    const ledgerHome = resolveActivationLedgerHome(() => home);
    return await scenario(ledgerHome, home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "dispatch@test.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Dispatch Test"], { cwd: root });
}

/** Tiny executable that records that it ran while the pending lease still exists. */
function writeLeaseProbeExecutable(dir: string, markerPath: string, pendingPath: string): string {
  const bin = join(dir, "fake-ak-role");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const pending = ${JSON.stringify(pendingPath)};
const marker = ${JSON.stringify(markerPath)};
const exists = fs.existsSync(pending);
fs.writeFileSync(marker, JSON.stringify({ pendingExistsAtIgnite: exists, argv: process.argv.slice(2) }) + "\\n");
process.exit(exists ? 0 : 3);
`,
    { mode: 0o755 },
  );
  chmodSync(bin, 0o755);
  return bin;
}

test("machine dispatcher offers lease then starts ak-role process", async () => {
  await withLedgerHome(async (ledgerHome) => {
    const work = await mkdtemp(join(tmpdir(), "ak-dispatch-site-"));
    try {
      const pendingPath = join(
        activationBookDirectory(ledgerHome, "demo-book"),
        DISPATCH_LEASE_PENDING_FILE,
      );
      const markerPath = join(work, "ignite-marker.json");
      const akRolePath = writeLeaseProbeExecutable(work, markerPath, pendingPath);
      const result = dispatchSelectedTicketRole({
        ledgerHome,
        bookKey: "demo-book",
        siteIdentity: work,
        ticketNumber: 176,
        akRolePath,
        akRoleArgs: ["judge", "from-machine"],
        env: process.env,
      });
      assert.equal(result.status, 0, result.stderr);
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
        pendingExistsAtIgnite: boolean;
        argv: string[];
      };
      assert.equal(marker.pendingExistsAtIgnite, true);
      assert.deepEqual(marker.argv, ["judge", "from-machine"]);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});

test("second machine dispatch while pending exists throws HeldError before start", async () => {
  await withLedgerHome(async (ledgerHome) => {
    const work = await mkdtemp(join(tmpdir(), "ak-dispatch-held-"));
    try {
      const pendingPath = join(
        activationBookDirectory(ledgerHome, "demo-book"),
        DISPATCH_LEASE_PENDING_FILE,
      );
      const markerPath = join(work, "should-not-run.json");
      const akRolePath = writeLeaseProbeExecutable(work, markerPath, pendingPath);
      dispatchSelectedTicketRole({
        ledgerHome,
        bookKey: "demo-book",
        siteIdentity: work,
        ticketNumber: 176,
        akRolePath,
        akRoleArgs: ["judge"],
        env: process.env,
      });
      assert.throws(
        () =>
          dispatchSelectedTicketRole({
            ledgerHome,
            bookKey: "demo-book",
            siteIdentity: join(work, "other"),
            ticketNumber: 177,
            akRolePath,
            akRoleArgs: ["judge"],
            env: process.env,
          }),
        (error: unknown) => error instanceof TicketDispatchLeaseHeldError,
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});

test("real machine launcher entry → admit writes opaque binding externally", async () => {
  await withLedgerHome(async (ledgerHome, home) => {
    const site = await mkdtemp(join(tmpdir(), "ak-dispatch-e2e-"));
    try {
      seedGitProject(site);
      const bookKey = resolveBookKeyFromGit(site);
      const binDir = await mkdtemp(join(tmpdir(), "ak-dispatch-bin-"));
      try {
        // Real launcher path: spawn node+tsx admit helper at the site cwd.
        // Absolute tsx loader — child cwd is the site, not the package tree.
        const admitScript = join(binDir, "admit-once.mjs");
        await writeFile(
          admitScript,
          `import { pathToFileURL } from "node:url";
const invocationUrl = pathToFileURL(${JSON.stringify(new URL("../../src/public-cli/invocation.ts", import.meta.url).pathname)}).href;
const { admitJudgeInvocation } = await import(invocationUrl);
const admitted = await admitJudgeInvocation({
  home: ${JSON.stringify(home)},
  cwd: ${JSON.stringify(site)},
  project: ${JSON.stringify(site)},
  instruction: "review from machine launcher",
  attachmentPaths: [],
  createRunId: () => "run-machine-launcher",
});
process.stdout.write(JSON.stringify({
  correlationId: admitted.correlationId ?? null,
  ticketNumber: admitted.ticketNumber ?? null,
}) + "\\n");
`,
        );
        const result = dispatchSelectedTicketRole({
          ledgerHome,
          bookKey,
          siteIdentity: site,
          ticketNumber: 176,
          akRolePath: process.execPath,
          akRoleArgs: ["--import", tsxLoaderPath, admitScript],
          env: {
            ...process.env,
            // Keep package deps resolvable while cwd is the isolated site.
            NODE_PATH: join(packageRoot, "node_modules"),
          },
        });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        const admitted = JSON.parse(result.stdout.trim()) as {
          correlationId: string | null;
          ticketNumber: number | null;
        };
        assert.equal(typeof admitted.correlationId, "string");
        assert.ok((admitted.correlationId ?? "").length > 0);
        assert.notEqual(admitted.correlationId, "176");
        assert.equal(admitted.ticketNumber, 176);

        const waiting = readFileSync(
          join(activationBookDirectory(ledgerHome, bookKey), "waiting.jsonl"),
          "utf8",
        );
        const rows = waiting
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const binding = rows.find((row) => row.event === TICKET_BINDING_EVENT);
        const stub = rows.find((row) => row.event === DISPATCH_STUB_EVENT);
        assert.ok(binding, "ticket-binding fact required from real launcher path");
        assert.ok(stub, "dispatch-stub fact required from real launcher path");
        assert.equal(binding?.ticketNumber, 176);
        const bindingCorr = binding?.correlation as { id?: string } | undefined;
        assert.equal(bindingCorr?.id, admitted.correlationId);
        assert.notEqual(bindingCorr?.id, "176");
      } finally {
        await rm(binDir, { recursive: true, force: true });
      }
    } finally {
      await rm(site, { recursive: true, force: true });
    }
  });
});
