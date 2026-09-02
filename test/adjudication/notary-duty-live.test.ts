/**
 * #621 bare live seam — Notary duty acceptance (ordinary scripted tests cannot prove).
 *
 * Fixture materials give the role only 受审票面 / 判词 / 授权材料. Expected
 * status lives solely in the test oracle table and is never injected into the
 * role leg. Assertions bite typed `status` only; bounce additionally requires
 * non-empty structured `findings` (no free-text match/regex lock).
 *
 * Skip when machine agentDir has no openai-codex/xai credentials — same
 * live-seam contract as grok-controlled-live.test.ts; not part of the daily suite.
 *
 * Pre-fix exposure (frozen, not re-scripted here):
 * - Gate all-pass on #617 r1–r11 (old duty: 判词引票面/ADR 即放行) — issue body.
 * - Standalone bounce on the same countersign face: roles-r1audit runs
 *   01a06294@notary / 01a06295@notary (typed status=bounce + findings).
 * Current soul (a97ee70d) is what this live leg exercises.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";

import { issuePiDurablePrincipalCoordinates } from "../../src/pi/durable-principal.ts";
import {
  loadCredentialProviders,
} from "../../src/public-cli/config.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { writeRoleRunState } from "../../src/public-cli/run-lifecycle.ts";
import {
  runGatekeeper,
  type GatekeeperResult,
} from "../../src/gatekeeper-role.ts";
import {
  appendTicketProvenanceEntry,
  writeTicketProvenanceHumanView,
} from "../../src/ticket-provenance.ts";
import type { TicketProvenanceEntry } from "../../src/ticket-provenance-contracts.ts";
import {
  packageRoot,
  realMachineAgentDir,
  seedAgentDirModelsJsonFromFaux,
  withActivationHome,
  withInProcessPi,
} from "../helpers/pi-test-harness.ts";
import { fauxProvider } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  parentInheritedSeats,
  writeInstitutionalSeatTable,
} from "../helpers/institutional-seat-table.ts";

/** Per-scenario wall budget — live LLM legs vary; parent no longer wraps all four. */
const LIVE_TIMEOUT_MS = 600_000;

type ExpectedStatus = "pass" | "bounce";

type DutyScenario = {
  readonly id: string;
  readonly ticketNumber: number;
  /** Materials the role may read — never carries expected status/findings. */
  readonly ticketFace: string;
  readonly verdict: Record<string, unknown>;
  readonly diary: readonly TicketProvenanceEntry[];
  /** Optional ADR key table excerpt (scenario 2). */
  readonly adr0077Keys?: string;
  readonly expect: ExpectedStatus;
};

/**
 * Four 验收面 scenarios. Oracle `expect` is test-side only.
 * Diary transcripts are the authorization surface the Notary must chase.
 */
const SCENARIOS: readonly DutyScenario[] = [
  {
    id: "rebuild-session-without-quote",
    ticketNumber: 62101,
    ticketFace: [
      "#62101 fixture ticket face",
      "",
      "## Scope",
      "1. 引擎由 owner 显式选择。",
      "2. 以该 run 的 session/session.jsonl 为真源在目标宿主重建会话续跑（Pi→grok、grok→Pi 双向）。",
      "",
      "## Out of scope",
      "- 不改审刑院。",
    ].join("\n"),
    verdict: {
      judgeStatus: "continue",
      fixSummary:
        "按 Scope 2 以 session.jsonl 为真源在目标宿主重建会话；条款出处：Scope 2。",
      classes: [{ name: "resume-rebuild", disposition: "fix_now" }],
    },
    diary: [
      {
        basis: {
          method: "llm-semantic",
          anchors: ["#62101", "理论上就是一个session文件。跨宿主也能加。"],
        },
        sourceKind: "cc-session",
        sourceRef: { entryId: "dk1-fixture", sessionFile: "fixture-cc" },
        transcript:
          "DK-1 cross-host-resume-is-feasible：「瞎说。昨天亲口给我说的。理论上就是一个session文件。跨宿主也能加。」",
        timestamp: "2026-09-02T14:39:06.135Z",
      },
    ],
    expect: "bounce",
  },
  {
    id: "adr-name-without-key",
    ticketNumber: 62102,
    ticketFace: [
      "#62102 fixture ticket face",
      "",
      "## Scope",
      "1. 统一全宿主 session 格式，一次调用一对写回。",
    ].join("\n"),
    verdict: {
      judgeStatus: "continue",
      fixSummary:
        "按 ADR 0077 统一全宿主 session 格式并写回；条款出处：ADR 0077。",
      classes: [{ name: "unified-format", disposition: "fix_now" }],
    },
    diary: [
      {
        basis: {
          method: "llm-semantic",
          anchors: ["#62102", "不是统一交给司天台存吗"],
        },
        sourceKind: "adr-decision-key",
        sourceRef: { path: "docs/adr/0077-all-host-session-records-unified-direct-write.md" },
        transcript: [
          "ADR 0077 decision keys only:",
          "- record-scope-phase-two = all-host-session-records 「什么叫grok home？ 不是统一交给司天台存吗？」",
          "- live-session-in-books = 运行中活卷与终局卷宗同在 books 「卷宗不是统一存放吗？」",
          "No key authorizes「统一格式 / 写回 / 一次调用一对」。",
        ].join("\n"),
        timestamp: "2026-09-02T10:00:00.000Z",
      },
    ],
    adr0077Keys: [
      "| key | 值 |",
      "| record-scope-phase-two | all-host-session-records |",
      "| live-session-in-books | 运行中活卷与终局卷宗同在 books |",
    ].join("\n"),
    expect: "bounce",
  },
  {
    id: "misaligned-but-both-quoted",
    ticketNumber: 62103,
    // Ticket has both DK-1 and DK-2; verdict only takes DK-1 and leaves DK-2
    // unaddressed ("对不上"). Both sides bind emperor quotes — must pass
    // (DK-2 of #621: 判词与票面对不对得上不归符宝郎).
    ticketFace: [
      "#62103 fixture ticket face",
      "",
      "## Scope",
      "1. 引擎由 owner 显式选择（DK-2：「引擎应该是我想要就要不想要就不要」）。",
      "2. 跨宿主续跑可行（DK-1：「理论上就是一个session文件。跨宿主也能加」）。",
    ].join("\n"),
    verdict: {
      judgeStatus: "continue",
      fixSummary:
        "只落实 DK-1 跨宿主可行（「理论上就是一个session文件。跨宿主也能加」）；票面 Scope 1 引擎条款有 DK-2 原话但不在本判处理范围——对不上不构成加戏。",
      classes: [{ name: "cross-host-only", disposition: "fix_now" }],
    },
    diary: [
      {
        basis: {
          method: "llm-semantic",
          anchors: ["#62103", "理论上就是一个session文件。跨宿主也能加。"],
        },
        sourceKind: "cc-session",
        sourceRef: { entryId: "dk1-b", sessionFile: "fixture-cc" },
        transcript:
          "DK-1 cross-host-resume-is-feasible：「瞎说。昨天亲口给我说的。理论上就是一个session文件。跨宿主也能加。」",
        timestamp: "2026-09-02T14:39:06.135Z",
      },
      {
        basis: {
          method: "llm-semantic",
          anchors: ["#62103", "引擎应该是我想要就要不想要就不要"],
        },
        sourceKind: "cc-session",
        sourceRef: { entryId: "dk2-b", sessionFile: "fixture-cc" },
        transcript:
          "DK-2 engine-explicit-not-automatic：「另外我也不要自动的引擎。引擎应该是我想要就要不想要就不要。哪来的不能和不收！瞎扯」",
        timestamp: "2026-09-02T15:21:35.016Z",
      },
    ],
    expect: "pass",
  },
  {
    id: "dk3-three-axes-quoted",
    ticketNumber: 62104,
    ticketFace: [
      "#62104 fixture ticket face",
      "",
      "## Scope",
      "1. 所有运行根据现在定的席位三轴 model/host/engine；额度由 owner 控制（DK-3：「所有运行都根据现在定的席位来。三轴 model、host、engine。额度我来控。」）。",
    ].join("\n"),
    verdict: {
      judgeStatus: "continue",
      fixSummary:
        "按 DK-3 执行：所有运行根据现在定的席位三轴 model/host/engine，额度由 owner 控制（原话：「所有运行都根据现在定的席位来。三轴 model、host、engine。额度我来控。」）。",
      classes: [{ name: "three-axes", disposition: "fix_now" }],
    },
    diary: [
      {
        basis: {
          method: "llm-semantic",
          anchors: ["#62104", "根据现在定的席位", "三轴"],
        },
        sourceKind: "cc-session",
        sourceRef: { entryId: "dk3", sessionFile: "fixture-cc" },
        transcript:
          "DK-3 three-axes：「所有运行都根据现在定的席位来。三轴 model、host、engine。额度我来控。」",
        timestamp: "2026-09-02T16:00:00.000Z",
      },
    ],
    expect: "pass",
  },
];

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "notary-live@test.local"], {
    cwd: root,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Notary Live"], {
    cwd: root,
    stdio: "ignore",
  });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], {
    cwd: root,
    stdio: "ignore",
  });
}

/** Case pack the role may read — no expected status/findings fields. */
function casePackFor(scenario: DutyScenario): Record<string, unknown> {
  return {
    ticketNumber: scenario.ticketNumber,
    ticketFace: scenario.ticketFace,
    verdict: scenario.verdict,
    ...(scenario.adr0077Keys === undefined
      ? {}
      : { adr0077Keys: scenario.adr0077Keys }),
  };
}

async function seedDiary(
  scenario: DutyScenario,
  project: string,
  home: string,
): Promise<void> {
  for (const entry of scenario.diary) {
    appendTicketProvenanceEntry({
      ticketNumber: scenario.ticketNumber,
      entry,
      cwd: project,
      home,
    });
  }
  writeTicketProvenanceHumanView({
    ticketNumber: scenario.ticketNumber,
    cwd: project,
    home,
    entries: scenario.diary,
  });
}

/**
 * Seed a retained judge source-run under the hermetic machine ledger.
 * Attachments carry only 受审材料 (ticket face + verdict + optional ADR keys).
 */
async function seedSourceRun(input: {
  readonly home: string;
  readonly project: string;
  readonly scenario: DutyScenario;
  readonly runId: string;
}): Promise<string> {
  const coords = issuePiDurablePrincipalCoordinates({
    cwd: input.project,
    runId: input.runId,
    role: "judge",
    home: input.home,
  });
  await mkdir(coords.sessionDirectory, { recursive: true });
  const attachmentsDir = join(coords.runDirectory, "attachments");
  await mkdir(attachmentsDir, { recursive: true });

  const pack = casePackFor(input.scenario);
  const packPath = join(attachmentsDir, "00-case-pack.json");
  await writeFile(packPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  await writeFile(
    join(attachmentsDir, "01-ticket-face.md"),
    `${input.scenario.ticketFace}\n`,
    "utf8",
  );
  await writeFile(
    join(attachmentsDir, "02-verdict.json"),
    `${JSON.stringify(input.scenario.verdict, null, 2)}\n`,
    "utf8",
  );

  const admittedRequestPath = join(coords.runDirectory, "admitted-request.json");
  await writeFile(
    admittedRequestPath,
    `${JSON.stringify(
      {
        role: "judge",
        runId: input.runId,
        ticketNumber: input.scenario.ticketNumber,
        instruction: `受审材料见 attachments/（票 #${input.scenario.ticketNumber}）。`,
        attachments: [
          {
            frozenPath: packPath,
            provenancePath: packPath,
            mediaKind: "regular-file",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    coords.sessionFile,
    `${JSON.stringify({
      type: "message",
      message: {
        role: "user",
        content: `judge draft for ticket #${input.scenario.ticketNumber}`,
      },
    })}\n`,
    "utf8",
  );
  await writeRoleRunState(coords.runDirectory, {
    runId: input.runId,
    role: "judge",
    state: "terminal",
    bookKey: coords.bookKey,
    projectRoot: input.project,
    sessionDirectory: coords.sessionDirectory,
    sessionFile: coords.sessionFile,
    admittedRequestPath,
  });
  await seedDiary(input.scenario, input.project, input.home);
  return await realpath(coords.runDirectory);
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
    },
  };
}

function assertNotaryStatus(
  status: unknown,
  expect: ExpectedStatus,
  findings: unknown,
  label: string,
): void {
  assert.equal(status, expect, `${label}: typed status`);
  if (expect === "bounce") {
    assert.ok(Array.isArray(findings), `${label}: bounce findings must be an array`);
    assert.ok(
      (findings as unknown[]).length > 0,
      `${label}: bounce findings must be non-empty structure`,
    );
    for (const item of findings as unknown[]) {
      assert.equal(typeof item, "string", `${label}: finding entries are strings`);
      assert.ok(
        (item as string).length > 0,
        `${label}: finding entries non-empty`,
      );
    }
  }
}

async function liveCredentialsReady(): Promise<{
  readonly ok: boolean;
  readonly agentDir: string;
  readonly reason?: string;
}> {
  const agentDir = realMachineAgentDir();
  try {
    await access(join(agentDir, "auth.json"));
  } catch {
    return { ok: false, agentDir, reason: "machine agentDir auth.json missing" };
  }
  const credentials = await loadCredentialProviders(agentDir);
  if (credentials["openai-codex"] !== true && credentials.xai !== true) {
    return {
      ok: false,
      agentDir,
      reason: "neither openai-codex nor xai credentials present",
    };
  }
  return { ok: true, agentDir };
}

/** Live home: ledger under temp HOME; auth from real machine agentDir. No PI_OFFLINE. */
async function withLiveNotaryHome<T>(
  scenario: (ctx: {
    readonly home: string;
    readonly project: string;
    readonly agentDir: string;
  }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-notary-duty-live-"));
  const project = join(home, "project");
  const agentDir = realMachineAgentDir();
  const previousHome = process.env.HOME;
  try {
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    // Prefer a fast notary seat for live acceptance (machine public-cli.json is not used).
    const credentials = await loadCredentialProviders(agentDir);
    const seat =
      credentials["openai-codex"] === true
        ? { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "low" }
        : { provider: "xai", model: "grok-4.5", thinking: "low" };
    await mkdir(join(home, ".ak-roles"), { recursive: true });
    await writeFile(
      join(home, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ seats: { notary: seat } }, null, 2)}\n`,
      "utf8",
    );
    // Ledger home follows HOME; do not pin PI_CODING_AGENT_DIR/PI_OFFLINE —
    // child pi turn sets PI_CODING_AGENT_DIR from request.agentDir.
    process.env.HOME = home;
    return await scenario({ home, project, agentDir });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
}

describe(
  "#621 live Notary duty acceptance",
  { concurrency: 1, timeout: LIVE_TIMEOUT_MS * (SCENARIOS.length + 1) },
  () => {
    for (const [index, scenario] of SCENARIOS.entries()) {
      test(
        `standalone ${scenario.id} → ${scenario.expect}`,
        { timeout: LIVE_TIMEOUT_MS },
        async (t) => {
          const live = await liveCredentialsReady();
          if (!live.ok) {
            t.skip(live.reason ?? "live credentials unavailable");
            return;
          }

          await withLiveNotaryHome(async ({ home, project, agentDir }) => {
            const runId = `01a06210-6210-7000-8000-${String(index).padStart(12, "0")}`;
            const sourceRunPath = await seedSourceRun({
              home,
              project,
              scenario,
              runId,
            });
            const { io, stderr } = captureIo();
            const result = await runAkRole(
              [
                "notary",
                "--source-run",
                sourceRunPath,
                "--ticket",
                String(scenario.ticketNumber),
                "--project",
                project,
              ],
              {
                home,
                packageRoot,
                cwd: project,
                agentDir,
                io,
                notaryTimeoutMs: LIVE_TIMEOUT_MS - 30_000,
                createRunId: () =>
                  `01a06211-6210-7000-8000-${String(index).padStart(12, "0")}`,
              },
            );

            assert.equal(
              result.exitCode,
              0,
              `${scenario.id}: exitCode=0; stderr=${stderr.join("").slice(0, 2000)}`,
            );
            assert.ok(result.terminal, `${scenario.id}: terminal present`);
            assert.equal(result.terminal.roleOutcome.kind, "accepted");
            assert.equal(result.terminal.roleOutcome.role, "notary");
            const status = result.terminal.roleOutcome.status;
            const facts = result.terminal.roleOutcome.decisiveFacts as {
              findings?: unknown;
              findingsCount?: unknown;
            };
            assert.equal(status, scenario.expect, scenario.id);
            if (scenario.expect === "bounce") {
              // Typed structural proof only — no findings text lock (锚定宪法).
              // Production decisiveFacts currently projects findingsCount; array may
              // also appear. Either non-empty form satisfies the bounce clause record.
              if (Array.isArray(facts.findings)) {
                assertNotaryStatus(status, "bounce", facts.findings, scenario.id);
              } else {
                assert.ok(
                  typeof facts.findingsCount === "number" && facts.findingsCount > 0,
                  `${scenario.id}: bounce must retain non-empty findings structure (count=${String(facts.findingsCount)}; facts=${JSON.stringify(facts)})`,
                );
              }
            }
          });
        },
      );
    }

    /**
     * Gatekeeper→notary live path for the #617-shaped scenario only.
     * Parent session is faux; institutional children resolve real auth via
     * auth.json copied into the hermetic agentDir (PI_CODING_AGENT_DIR pin).
     */
    test(
      "gatekeeper→notary rebuild-session-without-quote → bounce",
      { timeout: LIVE_TIMEOUT_MS },
      async (t) => {
        const live = await liveCredentialsReady();
        if (!live.ok) {
          t.skip(live.reason ?? "live credentials unavailable");
          return;
        }

        const scenario = SCENARIOS[0]!;
        assert.equal(scenario.id, "rebuild-session-without-quote");

        await withActivationHome(
          { prefix: "ak-notary-gate-live-" },
          async ({ home, agentDir }) => {
            // withActivationHome sets PI_OFFLINE=1; institutional live children need network.
            const previousOffline = process.env.PI_OFFLINE;
            delete process.env.PI_OFFLINE;
            // Auth for ModelRegistry.getProviderAuth (reads getAgentDir()/auth.json).
            await copyFile(
              join(live.agentDir, "auth.json"),
              join(agentDir, "auth.json"),
            );

            try {
              // Parent stays faux; only gate seats use real provider/model.
              const faux = fauxProvider({
                api: "gatekeeper-parent",
                provider: "gatekeeper-parent",
                tokenSize: { min: 1000, max: 1000 },
              });
              faux.setResponses([fauxAssistantMessage("parent")]);
              const seeded = await seedAgentDirModelsJsonFromFaux(faux, agentDir);
              try {
                await withInProcessPi(
                  {
                    cwd: home,
                    home,
                    agentDir,
                    activationLedgerSession: true,
                    faux,
                    modelsPath: null,
                    noExtensions: true,
                    noTools: "builtin",
                    mode: "print",
                    systemPrompt: "BASE",
                    flags: {},
                  },
                  async ({ session, model }) => {
                    const credentials = await loadCredentialProviders(agentDir);
                    const provider =
                      credentials["openai-codex"] === true
                        ? "openai-codex"
                        : "xai";
                    const seatModel =
                      provider === "openai-codex" ? "gpt-5.6-sol" : "grok-4.5";
                    await writeInstitutionalSeatTable(home, {
                      ...parentInheritedSeats({
                        provider: model.provider,
                        model: model.id,
                      }),
                      gatekeeper: {
                        provider,
                        model: seatModel,
                        thinking: "low",
                      },
                      notary: {
                        provider,
                        model: seatModel,
                        thinking: "low",
                      },
                    });

                    // Subject carries only 受审材料 — no expected status.
                    const material = JSON.stringify({
                      kind: "judge_draft_case",
                      ...casePackFor(scenario),
                      diary: scenario.diary.map((entry) => ({
                        sourceKind: entry.sourceKind,
                        transcript: entry.transcript,
                      })),
                    });

                    const context = {
                      cwd: home,
                      model,
                      modelRegistry: {
                        getProvider() {
                          return undefined;
                        },
                        find() {
                          return model;
                        },
                        async getProviderAuth() {
                          return { auth: {} };
                        },
                        async getApiKeyAndHeaders() {
                          return { ok: true };
                        },
                      },
                      thinkingLevel: "off" as const,
                      sessionManager: session.sessionManager,
                      runDirectory: home,
                    };

                    const result: GatekeeperResult = await runGatekeeper({
                      context: context as never,
                      runDirectory: home,
                      subject: { kind: "judge_draft", material },
                    });

                    assert.equal(
                      result.status,
                      "bounce",
                      `gate path status; got ${JSON.stringify(result).slice(0, 1500)}`,
                    );
                    if (result.status === "bounce") {
                      assert.equal(result.officer, "notary");
                      assertNotaryStatus(
                        result.status,
                        "bounce",
                        result.findings,
                        "gatekeeper→notary",
                      );
                    }
                  },
                );
              } finally {
                await seeded.close();
              }
            } finally {
              if (previousOffline === undefined) delete process.env.PI_OFFLINE;
              else process.env.PI_OFFLINE = previousOffline;
            }
          },
        );
      },
    );
  },
);
