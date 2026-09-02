/**
 * #621 bare live seam — Notary duty acceptance (ordinary scripted tests cannot prove).
 *
 * Fixtures give only 受审票面 / 判词 / 授权材料. Oracle expect is test-side only.
 * Assert typed `status`; bounce requires non-empty findings structure (no text lock).
 * Skip without openai-codex/xai credentials (same contract as grok-controlled-live).
 *
 * Pre-fix exposure (frozen): #617 gate all-pass; standalone bounce 01a06294/01a06295.
 * Current soul (a97ee70d). Gate subject matches judge-role: material = JSON.stringify(verdict).
 */
import assert from "node:assert/strict";
import { access, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

import { runGatekeeper } from "../../src/gatekeeper-role.ts";
import { issuePiDurablePrincipalCoordinates } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { loadCredentialProviders } from "../../src/public-cli/config.ts";
import { writeRoleRunState } from "../../src/public-cli/run-lifecycle.ts";
import {
  appendTicketProvenanceEntry,
  writeTicketProvenanceHumanView,
} from "../../src/ticket-provenance.ts";
import type { TicketProvenanceEntry } from "../../src/ticket-provenance-contracts.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import {
  parentInheritedSeats,
  writeInstitutionalSeatTable,
} from "../helpers/institutional-seat-table.ts";
import {
  packageRoot,
  realMachineAgentDir,
  seedAgentDirModelsJsonFromFaux,
  withActivationHome,
  withInProcessPi,
} from "../helpers/pi-test-harness.ts";

const LIVE_TIMEOUT_MS = 600_000;

type DutyScenario = {
  readonly id: string;
  readonly ticketNumber: number;
  readonly ticketFace: string;
  readonly verdict: Record<string, unknown>;
  readonly diary: readonly TicketProvenanceEntry[];
  readonly adr0077Keys?: string;
  readonly expect: "pass" | "bounce";
};

function diaryEntry(
  anchors: readonly string[],
  entryId: string,
  transcript: string,
  timestamp: string,
): TicketProvenanceEntry {
  return {
    basis: { method: "llm-semantic", anchors: [...anchors] },
    sourceKind: "cc-session",
    sourceRef: { entryId, sessionFile: "fixture-cc" },
    transcript,
    timestamp,
  };
}

/** Four 验收面. Oracle expect is test-side only — never injected into role materials. */
const SCENARIOS: readonly DutyScenario[] = [
  {
    id: "rebuild-session-without-quote",
    ticketNumber: 62101,
    // #617 shape: ticket Scope invents rebuild protocol; diary only has bare
    // cross-host feasibility. Verdict cites Scope 2 as if it were authority.
    ticketFace: [
      "#62101 fixture ticket face",
      "",
      "## Scope",
      "1. 以该 run 的 session/session.jsonl 为唯一真源，在目标宿主按统一转码器协议重建会话续跑（Pi→grok、grok→Pi 双向；一次调用一对写回）。",
    ].join("\n"),
    verdict: {
      judgeStatus: "continue",
      fixSummary:
        "按 Scope 2 / ADR 0077 以 session.jsonl 为唯一真源，用统一转码器协议在目标宿主重建会话（Pi→grok 双向，一次调用一对写回）；条款出处：Scope 2、ADR 0077。",
      classes: [{ name: "resume-rebuild-transcoder", disposition: "fix_now" }],
    },
    diary: [
      diaryEntry(
        ["#62101", "理论上就是一个session文件。跨宿主也能加。"],
        "dk1",
        "DK-1：「理论上就是一个session文件。跨宿主也能加。」（仅可行性；无重建协议、无真源路径、无双向、无一次调用一对。）",
        "2026-09-02T14:39:06.135Z",
      ),
    ],
    expect: "bounce",
  },
  {
    id: "adr-name-without-key",
    ticketNumber: 62102,
    ticketFace: "#62102\n\n## Scope\n1. 统一全宿主 session 格式，一次调用一对写回。",
    verdict: {
      judgeStatus: "continue",
      fixSummary: "按 ADR 0077 统一全宿主 session 格式并写回；条款出处：ADR 0077。",
      classes: [{ name: "unified-format", disposition: "fix_now" }],
    },
    diary: [
      diaryEntry(
        ["#62102", "不是统一交给司天台存吗"],
        "adr0077",
        [
          "ADR 0077 keys only:",
          "- record-scope-phase-two = all-host-session-records",
          "- live-session-in-books = 运行中活卷与终局卷宗同在 books",
          "No key authorizes「统一格式 / 写回 / 一次调用一对」。",
        ].join("\n"),
        "2026-09-02T10:00:00.000Z",
      ),
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
    // True 对不上: ticket = DK-2 only; verdict = DK-1 only. Both quoted.
    // Alignment-checking notary would bounce; duty-correct must pass.
    ticketFace: "#62103\n\n## Scope\n1. 引擎应该是我想要就要不想要就不要（DK-2）。",
    verdict: {
      judgeStatus: "continue",
      fixSummary: "理论上就是一个session文件。跨宿主也能加（DK-1）。",
      classes: [{ name: "cross-host", disposition: "fix_now" }],
    },
    diary: [
      diaryEntry(
        ["#62103", "理论上就是一个session文件。跨宿主也能加。"],
        "dk1",
        "DK-1：「理论上就是一个session文件。跨宿主也能加。」",
        "2026-09-02T14:39:06.135Z",
      ),
      diaryEntry(
        ["#62103", "引擎应该是我想要就要不想要就不要"],
        "dk2",
        "DK-2：「引擎应该是我想要就要不想要就不要。」",
        "2026-09-02T15:21:35.016Z",
      ),
    ],
    expect: "pass",
  },
];

function casePack(scenario: DutyScenario): Record<string, unknown> {
  return {
    ticketNumber: scenario.ticketNumber,
    ticketFace: scenario.ticketFace,
    verdict: scenario.verdict,
    ...(scenario.adr0077Keys === undefined ? {} : { adr0077Keys: scenario.adr0077Keys }),
  };
}

function seedDiary(scenario: DutyScenario, project: string, home: string): void {
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
  const packPath = join(attachmentsDir, "00-case-pack.json");
  await writeFile(packPath, `${JSON.stringify(casePack(input.scenario), null, 2)}\n`);
  await writeFile(join(attachmentsDir, "01-ticket-face.md"), `${input.scenario.ticketFace}\n`);
  await writeFile(
    join(attachmentsDir, "02-verdict.json"),
    `${JSON.stringify(input.scenario.verdict, null, 2)}\n`,
  );
  const admittedRequestPath = join(coords.runDirectory, "admitted-request.json");
  await writeFile(
    admittedRequestPath,
    `${JSON.stringify({
      role: "judge",
      runId: input.runId,
      ticketNumber: input.scenario.ticketNumber,
      instruction: `受审材料见 attachments/（票 #${input.scenario.ticketNumber}）。`,
      attachments: [{ frozenPath: packPath, provenancePath: packPath, mediaKind: "regular-file" }],
    })}\n`,
  );
  await writeFile(
    coords.sessionFile,
    `${JSON.stringify({
      type: "message",
      message: { role: "user", content: `judge draft #${input.scenario.ticketNumber}` },
    })}\n`,
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
  seedDiary(input.scenario, input.project, input.home);
  return realpath(coords.runDirectory);
}

function assertBounceFindings(status: unknown, findings: unknown, label: string): void {
  assert.equal(status, "bounce", label);
  assert.ok(Array.isArray(findings), `${label}: findings array`);
  assert.ok((findings as unknown[]).length > 0, `${label}: findings non-empty`);
  for (const item of findings as unknown[]) {
    assert.equal(typeof item, "string", `${label}: finding string`);
    assert.ok((item as string).length > 0, `${label}: finding non-empty`);
  }
}

async function liveReady(): Promise<{ ok: true; agentDir: string } | { ok: false; reason: string }> {
  const agentDir = realMachineAgentDir();
  try {
    await access(join(agentDir, "auth.json"));
  } catch {
    return { ok: false, reason: "machine agentDir auth.json missing" };
  }
  const credentials = await loadCredentialProviders(agentDir);
  if (credentials["openai-codex"] !== true && credentials.xai !== true) {
    return { ok: false, reason: "neither openai-codex nor xai credentials present" };
  }
  return { ok: true, agentDir };
}

/** Ledger under temp HOME; auth from machine agentDir. No PI_OFFLINE. */
async function withLiveHome<T>(
  run: (ctx: { home: string; project: string; agentDir: string }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-notary-duty-live-"));
  const project = join(home, "project");
  const agentDir = realMachineAgentDir();
  const previousHome = process.env.HOME;
  try {
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const credentials = await loadCredentialProviders(agentDir);
    const seat =
      credentials["openai-codex"] === true
        ? { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "low" }
        : { provider: "xai", model: "grok-4.5", thinking: "low" };
    await mkdir(join(home, ".ak-roles"), { recursive: true });
    await writeFile(
      join(home, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ seats: { notary: seat } })}\n`,
    );
    process.env.HOME = home;
    return await run({ home, project, agentDir });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
}

describe(
  "#621 live Notary duty acceptance",
  { concurrency: 1, timeout: LIVE_TIMEOUT_MS * (SCENARIOS.length + 2) },
  () => {
    for (const [index, scenario] of SCENARIOS.entries()) {
      test(
        `standalone ${scenario.id} → ${scenario.expect}`,
        { timeout: LIVE_TIMEOUT_MS },
        async (t) => {
          const live = await liveReady();
          if (!live.ok) {
            t.skip(live.reason);
            return;
          }

          await withLiveHome(async ({ home, project, agentDir }) => {
            const runId = `01a06210-6210-7000-8000-${String(index).padStart(12, "0")}`;
            const sourceRunPath = await seedSourceRun({ home, project, scenario, runId });
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
              `${scenario.id}: exit 0; stderr=${stderr.join("").slice(0, 1500)}`,
            );
            assert.ok(result.terminal, `${scenario.id}: terminal`);
            assert.equal(result.terminal.roleOutcome.kind, "accepted");
            assert.equal(result.terminal.roleOutcome.role, "notary");
            const status = result.terminal.roleOutcome.status;
            const facts = result.terminal.roleOutcome.decisiveFacts as {
              findings?: unknown;
              findingsCount?: unknown;
            };
            assert.equal(status, scenario.expect, scenario.id);
            if (scenario.expect === "bounce") {
              if (Array.isArray(facts.findings)) {
                assertBounceFindings(status, facts.findings, scenario.id);
              } else {
                assert.ok(
                  typeof facts.findingsCount === "number" && facts.findingsCount > 0,
                  `${scenario.id}: bounce findingsCount>0 got ${String(facts.findingsCount)}`,
                );
              }
            }
          });
        },
      );
    }

    /**
     * Gate path: production judge subject (verdict JSON only). Ticket face + 起居录
     * seeded for self-fetch. Only typed transport_failure retries once.
     */
    test(
      "gatekeeper→notary rebuild-session-without-quote → bounce",
      { timeout: LIVE_TIMEOUT_MS },
      async (t) => {
        const live = await liveReady();
        if (!live.ok) {
          t.skip(live.reason);
          return;
        }
        const scenario = SCENARIOS[0]!;
        assert.equal(scenario.id, "rebuild-session-without-quote");

        let transportRetries = 0;
        for (;;) {
          const result = await withActivationHome(
            { prefix: "ak-notary-gate-live-" },
            async ({ home, agentDir }) => {
              const previousOffline = process.env.PI_OFFLINE;
              const previousRunDir = process.env.AK_ROLE_RUN_DIR;
              delete process.env.PI_OFFLINE;
              await copyFile(join(live.agentDir, "auth.json"), join(agentDir, "auth.json"));
              try {
                const faux = fauxProvider({
                  api: "gatekeeper-parent",
                  provider: "gatekeeper-parent",
                  tokenSize: { min: 1000, max: 1000 },
                });
                faux.setResponses([fauxAssistantMessage("parent")]);
                const seeded = await seedAgentDirModelsJsonFromFaux(faux, agentDir);
                try {
                  return await withInProcessPi(
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
                        credentials["openai-codex"] === true ? "openai-codex" : "xai";
                      const seatModel =
                        provider === "openai-codex" ? "gpt-5.6-sol" : "grok-4.5";
                      await writeInstitutionalSeatTable(home, {
                        ...parentInheritedSeats({
                          provider: model.provider,
                          model: model.id,
                        }),
                        // high thinking on notary: low/medium sometimes falls back to
                        // pre-#621 alignment check and false-pass on Scope-as-authority.
                        gatekeeper: { provider, model: seatModel, thinking: "low" },
                        notary: { provider, model: seatModel, thinking: "high" },
                      });

                      await mkdir(join(home, "attachments"), { recursive: true });
                      await writeFile(
                        join(home, "attachments", "00-ticket-face.md"),
                        `${scenario.ticketFace}\n`,
                      );
                      seedDiary(scenario, home, home);
                      const diaryText = scenario.diary
                        .map((entry) => entry.transcript)
                        .join("\n");
                      session.sessionManager.appendMessage({
                        role: "user",
                        content: [
                          {
                            type: "text",
                            text: [
                              `大理寺审票 #${scenario.ticketNumber}。`,
                              "票面见 attachments/00-ticket-face.md：",
                              scenario.ticketFace,
                              "",
                              "起居录摘录（亦在 ticket-provenance 卷）：",
                              diaryText,
                            ].join("\n"),
                          },
                        ],
                      } as never);
                      process.env.AK_ROLE_RUN_DIR = home;

                      // Production judge-role.ts: material is the verdict only.
                      const material = JSON.stringify(scenario.verdict);
                      return runGatekeeper({
                        context: {
                          cwd: home,
                          model,
                          modelRegistry: {
                            getProvider: () => undefined,
                            find: () => model,
                            getProviderAuth: async () => ({ auth: {} }),
                            getApiKeyAndHeaders: async () => ({ ok: true }),
                          },
                          thinkingLevel: "off",
                          sessionManager: session.sessionManager,
                          runDirectory: home,
                        } as never,
                        runDirectory: home,
                        subject: { kind: "judge_draft", material },
                      });
                    },
                  );
                } finally {
                  await seeded.close();
                }
              } finally {
                if (previousOffline === undefined) delete process.env.PI_OFFLINE;
                else process.env.PI_OFFLINE = previousOffline;
                if (previousRunDir === undefined) delete process.env.AK_ROLE_RUN_DIR;
                else process.env.AK_ROLE_RUN_DIR = previousRunDir;
              }
            },
          );

          // Only typed transport_failure may retry once. Business status fails immediately.
          if (result.status === "transport_failure" && transportRetries === 0) {
            transportRetries += 1;
            continue;
          }

          assert.equal(
            result.status,
            "bounce",
            `gate status; got ${JSON.stringify(result).slice(0, 1200)}`,
          );
          if (result.status === "bounce") {
            assert.equal(result.officer, "notary");
            assertBounceFindings(result.status, result.findings, "gatekeeper→notary");
          }
          break;
        }
      },
    );
  },
);
