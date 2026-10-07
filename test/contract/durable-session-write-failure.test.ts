/**
 * #959: required package-owned durable session entry flush failure must not
 * close as accepted / retry — reuse typed infrastructure-failure channel.
 * Also: session_shutdown producers (navigator attendance) drain before dispose
 * returns; their flush failure is a dispose terminal failure, not washed.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import type { RoleRuntimeDependencies } from "../../src/role-runtime.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import {
  sampleCompletedDoctorOutput,
  seedDoctorIssueRuns,
} from "../helpers/doctor-fixtures.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { createHeadlessRoleTurnHost } from "../../src/headless-host/role-turn-host.ts";
import { lookupHeadlessHostDescription } from "../../src/host-descriptions.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { createSessionIdentityAuthority } from "../../src/session-identity.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { runLogPayloads } from "../helpers/run-dossier-fixture.ts";

/** Stage one pending attendance so session_shutdown will book a package entry. */
function withStagedShutdownAttendance(
  base: RoleRuntimeDependencies,
  runDirectory: string,
): RoleRuntimeDependencies {
  return {
    ...base,
    loadNavigatorWorkContext: async () => ({
      subjectKey: `${runDirectory}/work`,
      subjectProvenance: "role_input" as const,
    }),
    createNavigatorAttendance: async (options) => {
      const event = {
        version: 1 as const,
        disposition: "unavailable" as const,
        invocationId: options.invocationId,
        role: options.role,
        phase: options.phase,
        subjectKey: options.subjectKey,
        unavailableReason: "staged for session_shutdown drain probe",
        unavailableSource: "unknown" as const,
        unavailableCause: "unknown" as const,
      };
      const report = {
        disposition: "unavailable" as const,
        unavailableReason: "staged for session_shutdown drain probe",
        unavailableSource: "unknown" as const,
        unavailableCause: "unknown" as const,
      };
      await options.onEvent(event, report);
      return {
        prepare() {},
        setWorkContext() {},
        warmHelp() {},
        isPreparing: () => false,
        settle: async () => {},
        dispose() {},
      };
    },
  };
}

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
  assert.ok(failure?.diagnostic, "infrastructure failure carries a diagnostic");
}

/** Root-independent write failure: path becomes a directory → appendFile EISDIR. */
async function poisonSessionFileWrite(sessionFile: string): Promise<void> {
  await rm(sessionFile, { force: true });
  await mkdir(sessionFile);
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
      await poisonSessionFileWrite(sessionFile);
      await prepared.ingestStructuredOutput({ prose: "下一步送 reviewer" });
      assertDurableFlushFailure(await prepared.closeRound());
    } finally {
      await prepared.dispose?.();
    }
  });
});

test("#959 durable flush failure outranks completed Doctor submission", async () => {
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
      dependencies: base,
      socketPath,
      sessionFile,
    });
    try {
      await poisonSessionFileWrite(sessionFile);
      await prepared.ingestStructuredOutput(
        sampleCompletedDoctorOutput({ issueNumber: 959, runsPath }),
      );
      assertDurableFlushFailure(await prepared.closeRound());
    } finally {
      await prepared.dispose?.();
    }
  });
});

test("#1032 shutdown durable failure reaches the public terminal without replacing host facts", async () => {
  await withTempEnvelopeHome("shutdown-fail", async ({ home, socketPath }) => {
    const project = join(home, "work");
    await mkdir(project);
    seedGitProject(project);
    await writeFile(join(home, ".ak-roles", "public-cli.json"), JSON.stringify({
      autoResumeLimit: 0,
      seats: { navigator: { provider: "provider", model: "model" } },
    }));
    const binary = join(home, "fake-claude");
    await writeFile(binary, `#!/usr/bin/env node
for await (const chunk of process.stdin) {}
process.stderr.write("HOST STDERR\\n");
process.exit(0);
`);
    await chmod(binary, 0o755);
    const description = lookupHeadlessHostDescription("claude");
    assert.ok(description);
    const identity = createSessionIdentityAuthority(piDurablePrincipalAuthority, "claude");
    let actualRunDirectory = "";
    const host = createHeadlessRoleTurnHost({
      description, hostName: "claude", binary, sessionIdentity: identity,
      prepare: async (request) => {
        actualRunDirectory = request.runDirectory;
        const sessionFile = identity.resolveSessionFile(request.principal);
        const prepared = await prepareRoleEnvelope({
          request,
          dependencies: withStagedShutdownAttendance(createRoleRuntimeDependencies(packageRoot), request.runDirectory),
          socketPath, sessionFile,
        });
        return {
          ...prepared,
          async dispose() {
            // Inject a filesystem fault, not a mocked disposal result. The real
            // shutdown handler and required append must own the failure.
            await poisonSessionFileWrite(sessionFile);
            await prepared.dispose?.();
          },
        };
      },
    });
    const captured = captureIo();
    const result = await runAkRole([
      "judge", "--host", "claude", "--model", "openai-codex/gpt-5.6-sol:high", "probe",
    ], {
      packageRoot, home, cwd: project, io: captured.io,
      credentials: { "openai-codex": true, xai: false },
      principalAuthority: piDurablePrincipalAuthority,
      hostAdapters: [{ name: "claude", create: () => ({ ok: true, host }) }],
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.terminal?.roleOutcome.kind, "failure");
    assert.equal(result.terminal?.roleOutcome.decisiveFacts?.errorCode, "durable-session-write-failed");
    assert.deepEqual(result.terminal?.roleOutcome.decisiveFacts?.packageFact, { exitCode: 0 });
    assert.deepEqual(runLogPayloads(actualRunDirectory, "stderr"), [{ text: "HOST STDERR\n" }]);
  });
});
