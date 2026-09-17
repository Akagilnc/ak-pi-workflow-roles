/**
 * #959: required package-owned durable session entry flush failure must not
 * close as accepted / retry — reuse typed infrastructure-failure channel.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import {
  sampleCompletedDoctorOutput,
  seedDoctorIssueRuns,
} from "../helpers/doctor-fixtures.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

async function withTempEnvelopeHome(
  roleLabel: string,
  run: (input: {
    home: string;
    runDirectory: string;
    sessionDir: string;
    sessionFile: string;
    socketPath: string;
  }) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), `ak-959-durable-${roleLabel}-`));
  try {
    const runDirectory = join(home, ".ak-roles", "books", "probe", "runs", `run-959@${roleLabel}`);
    const sessionDir = join(runDirectory, "session");
    await mkdir(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, "session.jsonl");
    const socketPath = join(home, "mcp.sock");
    await mkdir(join(home, ".ak-roles"), { recursive: true });
    await run({ home, runDirectory, sessionDir, sessionFile, socketPath });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function assertDurableFlushFailure(closed: {
  readonly accepted: boolean;
  readonly failure?: { readonly identity?: { readonly code?: string | number }; readonly cause?: string; readonly diagnostic?: string };
  readonly retry?: unknown;
}): void {
  assert.equal(closed.accepted, false, "flush failure must not report accepted");
  assert.equal("retry" in closed && closed.retry !== undefined, false, "infrastructure outranks correctable retry");
  assert.equal("failure" in closed, true, "typed infrastructure failure required");
  const failure = "failure" in closed ? closed.failure : undefined;
  assert.ok(failure !== undefined);
  assert.equal(failure?.identity?.code, "durable-session-write-failed");
  assert.equal(failure?.cause, "output");
  assert.match(String(failure?.diagnostic ?? ""), /durable session entry flush failed/);
}

test("#959 durable session entry flush failure is infrastructure not accepted", async () => {
  await withTempEnvelopeHome("navigator", async ({ home, runDirectory, sessionDir, sessionFile, socketPath }) => {
    // Temp seat table only — never touch the real public-cli.json (席位表法).
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
        stationChild: true,
      },
      dependencies: createRoleRuntimeDependencies(packageRoot),
      socketPath,
      sessionFile,
    });
    try {
      await chmod(sessionFile, 0o444);
      await prepared.ingestStructuredOutput({ prose: "下一步送 reviewer" });
      assertDurableFlushFailure(await prepared.closeRound());
    } finally {
      await chmod(sessionFile, 0o644).catch(() => undefined);
      await prepared.dispose?.();
    }
  });
});

test("#959 durable flush failure outranks correctable rejection retry", async () => {
  await withTempEnvelopeHome("doctor", async ({ home, runDirectory, sessionDir, sessionFile, socketPath }) => {
    await writeFile(
      join(home, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({
        seats: {
          doctor: { provider: "provider", model: "model" },
          auditor: { provider: "provider", model: "model" },
          navigator: { provider: "provider", model: "model" },
        },
      }, null, 2)}\n`,
    );
    const runsPath = await seedDoctorIssueRuns(home, "probe", 959);
    const base = createRoleRuntimeDependencies(packageRoot);
    const prepared = await prepareRoleEnvelope({
      request: {
        principal: fixturePrincipal(sessionDir),
        activation: { role: "doctor", casePath: runsPath },
        methods: [],
        continuation: { kind: "initial", prompt: "durable flush + bounce probe" },
        cwd: packageRoot,
        home,
        agentDir: join(home, "agent"),
        runDirectory,
        stationChild: true,
      },
      dependencies: {
        ...base,
        // Doctor path: appendCandidate (package durable) then GatekeeperDecisionError bounce.
        auditDoctorCompliance: async () => ({
          status: "bounce" as const,
          violations: [{ article: "method-proof", reason: "missing proof" }],
        }),
      },
      socketPath,
      sessionFile,
    });
    try {
      await chmod(sessionFile, 0o444);
      await prepared.ingestStructuredOutput(
        sampleCompletedDoctorOutput({ issueNumber: 959, runsPath }),
      );
      assertDurableFlushFailure(await prepared.closeRound());
    } finally {
      await chmod(sessionFile, 0o644).catch(() => undefined);
      await prepared.dispose?.();
    }
  });
});
