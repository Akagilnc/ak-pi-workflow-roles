/**
 * #1183 — typed ticket identity places before reask/seal; live session write
 * handle follows host-authority principal coords (not default session.jsonl rebuild).
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { seedCurrentSection } from "../helpers/run-dossier-fixture.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { formatRunLeaf, isUnboundRunDirectory, sessionFileOf } from "../../src/role-run-placement.ts";
import { rewriteRunDirectoryPathValue } from "../../src/role-run-path-rewrite.ts";

const TICKET = 1183;
const RUN_ID = "01a01183-0000-7000-8000-ticketid01";

async function withFixerEnvelope(input: {
  readonly sessionFileName?: string;
  readonly run: (ctx: {
    readonly home: string;
    readonly project: string;
    readonly unboundRun: string;
    readonly ticketRun: string;
    readonly sessionDir: string;
    readonly sessionFile: string;
    readonly socketPath: string;
    readonly prepared: Awaited<ReturnType<typeof prepareRoleEnvelope>>;
  }) => Promise<void>;
}): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "ak-1183-ticket-id-"));
  try {
    const project = join(home, "work");
    await mkdir(project);
    seedGitProject(project);
    await mkdir(join(home, ".ak-roles"), { recursive: true });
    await writeFile(
      join(home, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({
        autoResumeLimit: 0,
        seats: {
          fixer: { provider: "provider", model: "model" },
          navigator: { provider: "provider", model: "model" },
          auditor: { provider: "provider", model: "model" },
        },
      }, null, 2)}\n`,
    );
    const unboundRun = join(
      home,
      ".ak-roles",
      "books",
      "work",
      "unbound",
      "runs",
      formatRunLeaf(RUN_ID, "fixer"),
    );
    const ticketRun = join(
      home,
      ".ak-roles",
      "books",
      "work",
      String(TICKET),
      "runs",
      formatRunLeaf(RUN_ID, "fixer"),
    );
    const sessionDir = join(unboundRun, "session");
    await mkdir(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, input.sessionFileName ?? "session.jsonl");
    await writeFile(sessionFile, "");
    const durable = {
      role: "fixer",
      runId: RUN_ID,
      bookKey: "work",
      projectRoot: project,
      runDirectory: unboundRun,
    } as const;
    seedCurrentSection(unboundRun, "admitted", durable);
    seedCurrentSection(unboundRun, "invocation", durable);
    const socketPath = join(home, "mcp.sock");
    const prepared = await prepareRoleEnvelope({
      request: {
        principal: fixturePrincipal(sessionDir, sessionFile),
        activation: { role: "fixer", phase: "apply" },
        methods: [],
        continuation: { kind: "initial", prompt: "#1183 ticket identity probe" },
        cwd: project,
        home,
        agentDir: join(home, "agent"),
        runDirectory: unboundRun,
        stationChild: true,
      },
      dependencies: createRoleRuntimeDependencies(packageRoot),
      socketPath,
      sessionFile,
      principalAuthority: piDurablePrincipalAuthority,
    });
    try {
      await input.run({
        home,
        project,
        unboundRun,
        ticketRun,
        sessionDir,
        sessionFile,
        socketPath,
        prepared,
      });
    } finally {
      await prepared.dispose?.();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("#1183 worker_commit_reminder still places after typed ticket is read", async () => {
  await withFixerEnvelope({
    run: async ({ unboundRun, ticketRun, prepared }) => {
      assert.equal(isUnboundRunDirectory(unboundRun), true);
      await prepared.ingestStructuredOutput({
        status: "completed",
        report: "no commit yet",
        ticketNumber: TICKET,
        classResults: [{
          name: "main",
          disposition: "completed",
          searchScope: "src",
          exceptions: [],
          commitSha: "deadbeef",
        }],
      });
      // Placement must already be under the ticket leaf before closeRound —
      // commit reminder never reaches seal/projectClosure.
      assert.equal(existsSync(unboundRun), false, "unbound leaf must be gone after typed identity");
      assert.equal(existsSync(ticketRun), true, "run must sit under the ticket leaf");
      assert.equal(isUnboundRunDirectory(ticketRun), false);
      const closed = await prepared.closeRound();
      assert.equal(closed.accepted, false, "commit reminder must stay a correctable retry");
      assert.ok("retry" in closed && closed.retry !== undefined);
      assert.equal(
        (closed as { retry?: { code?: string } }).retry?.code,
        "worker_commit_reminder",
      );
    },
  });
});

test("#1183 non-default principal session handle survives live relocate", async () => {
  await withFixerEnvelope({
    sessionFileName: "package-custom.jsonl",
    run: async ({ unboundRun, ticketRun, sessionFile, prepared }) => {
      await prepared.ingestStructuredOutput({
        status: "planned",
        report: "plan only — no commit gate",
        ticketNumber: TICKET,
      });
      const closed = await prepared.closeRound();
      assert.equal(closed.accepted, true);
      assert.equal(existsSync(unboundRun), false);
      assert.equal(existsSync(ticketRun), true);
      const expectedSessionFile = rewriteRunDirectoryPathValue(
        sessionFile,
        unboundRun,
        ticketRun,
      );
      assert.equal(typeof expectedSessionFile, "string");
      assert.equal(
        expectedSessionFile,
        join(ticketRun, "session", "package-custom.jsonl"),
      );
      assert.equal(existsSync(String(expectedSessionFile)), true);
      assert.equal(existsSync(sessionFileOf(ticketRun)), false, "default session.jsonl must stay unused");
      const customRaw = await readFile(String(expectedSessionFile), "utf8");
      assert.ok(
        customRaw.includes("ak-role-submission-closure")
          || customRaw.includes("planned")
          || customRaw.length > 0,
        "package-owned writes must land on the authority session file",
      );
    },
  });
});
