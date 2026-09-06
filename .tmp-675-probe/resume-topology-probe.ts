/**
 * #675 plan probe — structured trajectory under resume topology.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";

import type { RoleTurnHost, RoleTurnRequest } from "../src/host-contracts.ts";
import { NAVIGATOR_OUTPUT_TOOL_NAME } from "../src/package-contracts/navigator-output.ts";
import { piDurablePrincipalAuthority } from "../src/pi/durable-principal.ts";
import { runAkRole } from "../src/public-cli/cli.ts";
import {
  JUDGE_OUTPUT_TOOL_NAME,
  NAVIGATOR_PREPARE_TOOL_NAME,
  NOTARY_OUTPUT_TOOL,
} from "../src/role-runtime.ts";
import { installHermesFixture } from "../test/helpers/hermes-fixture.ts";
import {
  packageRoot,
  seedGitRepository,
  withAgentDirProviderFixture,
  withInProcessPi,
} from "../test/helpers/pi-test-harness.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../test/helpers/role-turn-host-fixture.ts";

const SCRATCH = dirname(fileURLToPath(import.meta.url));

type SeenTurn = {
  runId: string;
  runDirectory: string;
  kind: RoleTurnRequest["continuation"]["kind"];
  model?: RoleTurnRequest["model"];
  role: string;
  courtAttemptId?: string;
};

function runIdFromDirectory(runDirectory: string): string {
  const base = runDirectory.split(/[\\/]/).pop() ?? "";
  const at = base.indexOf("@");
  return at === -1 ? base : base.slice(0, at);
}

async function listBookRunDirs(home: string): Promise<Array<{ path: string; role: string }>> {
  const booksRoot = join(home, ".ak-roles", "books");
  const books = await readdir(booksRoot).catch(() => [] as string[]);
  const dirs: Array<{ path: string; role: string }> = [];
  for (const b of books) {
    const runsDir = join(booksRoot, b, "runs");
    const entries = await readdir(runsDir).catch(() => [] as string[]);
    for (const entry of entries) {
      const at = entry.lastIndexOf("@");
      const role = at === -1 ? "?" : entry.slice(at + 1);
      dirs.push({ path: join(runsDir, entry), role });
    }
  }
  return dirs;
}

function seedGitProject(root: string): void {
  seedGitRepository(root);
  try {
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:Akagilnc/ak-pi-workflow-roles.git"],
      { cwd: root },
    );
  } catch {
    /* already has origin */
  }
}

function observingHost(inner: RoleTurnHost, seen: SeenTurn[]): RoleTurnHost {
  return {
    executeTurn: async (request) => {
      seen.push({
        runId: runIdFromDirectory(request.runDirectory),
        runDirectory: request.runDirectory,
        kind: request.continuation.kind,
        role: request.activation.role,
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.courtAttemptId === undefined
          ? {}
          : { courtAttemptId: request.courtAttemptId }),
      });
      return inner.executeTurn(request);
    },
  };
}

async function probeNavigatorResume(): Promise<unknown> {
  const home = await mkdtemp(join(SCRATCH, "nav-"));
  const project = join(home, "project");
  await mkdir(project, { recursive: true });
  seedGitProject(project);
  const issueRoot = join(project, ".ak/work/issues/675");
  await mkdir(issueRoot, { recursive: true });
  await writeFile(join(issueRoot, "authority.md"), "owner authority\n", "utf8");

  const binDir = join(home, "bin");
  await mkdir(binDir, { recursive: true });
  await installHermesFixture(binDir, {
    resolverResponse: { assertion: "ticket", ticketNumber: 675 },
  });
  const priorPath = process.env.PATH;
  process.env.PATH = `${binDir}:${priorPath ?? ""}`;

  const io = { stdout: (_t: string) => {}, stderr: (_t: string) => {} };
  const credentials = { "openai-codex": true, xai: true } as const;

  await runAkRole(["config", "set", "navigator", "faux/nav-model:high"], {
    home,
    packageRoot,
    io,
  });

  const seen: SeenTurn[] = [];
  let turn = 0;
  const candidates = [
    {
      id: "probe-route",
      matches: { role: "judge", phase: null, kind: "accepted" },
      route: [
        { role: "judge", phase: null },
        { role: "reviewer", phase: null },
      ],
      next: { role: "reviewer", phase: null },
      reason: "probe",
      command: "ak-role reviewer",
    },
  ];
  const inner = roleTurnHostFromLegacyPiRunner({
    packageRoot,
    principalAuthority: piDurablePrincipalAuthority,
    piRunner: async () => {
      turn += 1;
      return scriptedTerminatingToolSession({
        role: "navigator",
        toolName: NAVIGATOR_OUTPUT_TOOL_NAME,
        details: { status: "advice", candidates },
      })([], {});
    },
  });
  const host = observingHost(inner, seen);

  try {
    const first = await runAkRole(["navigator", "route judgment for #675"], {
      home,
      packageRoot,
      cwd: issueRoot,
      credentials,
      io,
      roleTurnHost: host,
      createRunId: () => "01a067500-0000-7000-8000-00000000n001",
    });
    const runsAfterFirst = await listBookRunDirs(home);

    await runAkRole(["config", "set", "navigator", "faux/live-nav:low"], {
      home,
      packageRoot,
      io,
    });
    const second = await runAkRole(["navigator", "route judgment for #675 again"], {
      home,
      packageRoot,
      cwd: issueRoot,
      credentials,
      io,
      roleTurnHost: host,
      createRunId: () => "01a067500-0000-7000-8000-00000000n002",
    });
    const runsAfterSecond = await listBookRunDirs(home);

    const runId = seen[0]?.runId;
    const resumed =
      runId === undefined
        ? undefined
        : await runAkRole(["resume", runId], {
            home,
            packageRoot,
            cwd: issueRoot,
            credentials,
            io,
            roleTurnHost: host,
          });
    const runsAfterResume = await listBookRunDirs(home);

    return {
      probe: "navigator-instruction-seat",
      firstExit: first.exitCode,
      firstKind: first.terminal?.roleOutcome?.kind,
      secondExit: second.exitCode,
      secondKind: second.terminal?.roleOutcome?.kind,
      resumeExit: resumed?.exitCode,
      resumeKind: resumed?.terminal?.roleOutcome?.kind,
      turns: turn,
      seen: seen.map((s) => ({
        kind: s.kind,
        role: s.role,
        runId: s.runId,
        model: s.model?.model,
        thinking: s.model?.thinking,
        courtAttemptId: s.courtAttemptId,
        sameRunAsFirst: s.runDirectory === seen[0]?.runDirectory,
      })),
      runCounts: {
        afterFirst: runsAfterFirst.map((r) => r.role),
        afterSecond: runsAfterSecond.map((r) => r.role),
        afterResume: runsAfterResume.map((r) => r.role),
        navigatorDirsUnique: new Set(
          runsAfterResume.filter((r) => r.role === "navigator").map((r) => r.path),
        ).size,
      },
    };
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    await rm(home, { recursive: true, force: true });
  }
}

async function probeJudgeWithNavigatorAttendance(): Promise<unknown> {
  const home = await mkdtemp(join(SCRATCH, "judge-"));
  const project = join(home, "project");
  await mkdir(project, { recursive: true });
  seedGitProject(project);
  const issueRoot = join(project, ".ak/work/issues/675");
  await mkdir(issueRoot, { recursive: true });
  await writeFile(join(issueRoot, "authority.md"), "owner authority\n", "utf8");

  const binDir = join(home, "bin");
  await mkdir(binDir, { recursive: true });
  await installHermesFixture(binDir);
  const priorPath = process.env.PATH;
  process.env.PATH = `${binDir}:${priorPath ?? ""}`;

  const agentDir = join(home, ".pi-agent");
  await mkdir(agentDir, { recursive: true });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousHome = process.env.HOME;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HOME = home;

  const faux = fauxProvider({
    api: "openai-responses",
    provider: "ak-probe-offline",
    tokenSize: { min: 1000, max: 1000 },
  });
  const model = faux.getModel();
  assert.ok(model);

  const { savePublicCliConfig } = await import("../src/public-cli/config.ts");
  const seat = { provider: model.provider, model: model.id! };
  await savePublicCliConfig(
    {
      seats: {
        navigator: seat,
        judge: seat,
        notary: seat,
        inspector: seat,
        auditor: seat,
      },
    },
    home,
  );

  const modelRequests: Array<{ provider: string; id: string; tools: string[] }> = [];
  let navigatorOutputHits = 0;
  let prepareToolHits = 0;
  let judgeHits = 0;
  let notaryHits = 0;
  let auditorHits = 0;
  let otherHits = 0;

  const response = (
    context: Context,
    _o: unknown,
    _s: unknown,
    requestModel: { provider: string; id: string },
  ) => {
    const names = context.tools?.map((t) => t.name) ?? [];
    modelRequests.push({
      provider: requestModel.provider,
      id: requestModel.id,
      tools: [...names],
    });
    if (names.includes(NOTARY_OUTPUT_TOOL)) {
      notaryHits += 1;
      return fauxAssistantMessage(
        fauxToolCall(NOTARY_OUTPUT_TOOL, { status: "pass", findings: [] }),
        { stopReason: "toolUse" },
      );
    }
    if (names.includes("ak_navigator_output")) {
      navigatorOutputHits += 1;
      const candidates = [
        {
          id: "probe-route",
          matches: { role: "judge", phase: null, kind: "accepted" },
          route: [
            { role: "judge", phase: null },
            { role: "reviewer", phase: null },
          ],
          next: { role: "reviewer", phase: null },
          reason: "probe",
          command: "ak-role reviewer",
        },
      ];
      return fauxAssistantMessage(
        fauxToolCall("ak_navigator_output", { status: "advice", candidates }),
        { stopReason: "toolUse" },
      );
    }
    if (names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
      prepareToolHits += 1;
      return fauxAssistantMessage(
        fauxToolCall(NAVIGATOR_PREPARE_TOOL_NAME, {
          candidates: [
            {
              id: "probe-route",
              matches: { role: "judge", phase: null, kind: "accepted" },
              route: [
                { role: "judge", phase: null },
                { role: "reviewer", phase: null },
              ],
              next: { role: "reviewer", phase: null },
              reason: "probe",
              command: "ak-role reviewer",
            },
          ],
        }),
        { stopReason: "toolUse" },
      );
    }
    if (names.includes("ak_auditor_output") || names.includes("ak_soul_audit")) {
      auditorHits += 1;
      const t = names.includes("ak_auditor_output") ? "ak_auditor_output" : "ak_soul_audit";
      return fauxAssistantMessage(
        fauxToolCall(t, {
          status: "pass",
          violations: [],
          conflicts: [],
          decisionGate: null,
        }),
        { stopReason: "toolUse" },
      );
    }
    if (names.includes(JUDGE_OUTPUT_TOOL_NAME)) {
      judgeHits += 1;
      return fauxAssistantMessage(
        fauxToolCall(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" }),
        { stopReason: "toolUse" },
      );
    }
    otherHits += 1;
    return fauxAssistantMessage("idle", { stopReason: "stop" });
  };

  // Observation pool only — not a test floor. Large enough to not starve measurement.
  faux.setResponses(Array.from({ length: 40 }, () => response));

  let attendanceDisposition: string | undefined;
  let attendanceSource: string | undefined;

  try {
    await withAgentDirProviderFixture(faux, agentDir, async () => {
      await withInProcessPi(
        {
          activationLedgerSession: true,
          cwd: issueRoot,
          agentDir,
          faux,
          model,
          modelsPath: null,
          additionalExtensionPaths: [join(packageRoot, "extensions/role-runtime.ts")],
          systemPrompt: "PROBE JUDGE NAV",
          mode: "json",
          flags: { "ak-role": "judge" },
          noTools: "builtin",
        },
        async ({ session, sessionManager }) => {
          await session.prompt("ordinary probe attendance");
          const attendance = sessionManager.getEntries().find(
            (e) => e.type === "custom_message" && e.customType === "ak-navigator-attendance",
          );
          if (attendance?.type === "custom_message") {
            const d = attendance.details as {
              disposition?: string;
              unavailableSource?: string;
            };
            attendanceDisposition = d.disposition;
            attendanceSource = d.unavailableSource;
          }
        },
      );
    });

    const runs = await listBookRunDirs(home);
    const roleCounts: Record<string, number> = {};
    for (const r of runs) roleCounts[r.role] = (roleCounts[r.role] ?? 0) + 1;

    return {
      probe: "judge-with-navigator-attendance",
      attendanceDisposition,
      attendanceSource,
      hits: {
        navigatorOutput: navigatorOutputHits,
        prepareTool: prepareToolHits,
        judge: judgeHits,
        notary: notaryHits,
        auditor: auditorHits,
        other: otherHits,
        modelRequestsTotal: modelRequests.length,
      },
      modelRequestTable: modelRequests.map((m) => ({
        model: `${m.provider}/${m.id}`,
        tools: m.tools.filter(
          (t) =>
            t.includes("navigator") ||
            t.includes("judge") ||
            t.includes("notary") ||
            t.includes("auditor") ||
            t.includes("soul"),
        ),
      })),
      runRoleCounts: roleCounts,
      runDirs: runs.map((r) => `${r.role}`),
    };
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
}

const results: unknown[] = [];
try {
  results.push(await probeNavigatorResume());
} catch (e) {
  results.push({
    probe: "navigator-instruction-seat",
    error: String(e),
    stack: (e as Error).stack?.split("\n").slice(0, 12),
  });
}
try {
  results.push(await probeJudgeWithNavigatorAttendance());
} catch (e) {
  results.push({
    probe: "judge-with-navigator-attendance",
    error: String(e),
    stack: (e as Error).stack?.split("\n").slice(0, 12),
  });
}
console.log(JSON.stringify(results, null, 2));
