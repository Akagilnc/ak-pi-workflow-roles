/**
 * #708 / #779 / #901 public 起居郎 seat — `ak-role diarist` is a role like the other seats.
 * LLM submits bounds (+ optional amendments); mechanical layer reprojects records.jsonl.
 * Single seam: real entry, scripted host, on-disk session fixture, assert the unique diary file.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { resolveActivationLedgerHome } from "../../src/activation-ledger-topology.ts";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { DIARIST_OUTPUT_TOOL_NAME } from "../../src/diarist-contracts.ts";
import type {
  DurablePrincipal,
  DurablePrincipalAuthority,
  HostContext,
  RoleHost,
} from "../../src/host-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { readRoleRunState } from "../../src/public-cli/run-lifecycle.ts";
import { roleRunPlacement } from "../../src/role-run-placement.ts";
import { ticketProvenancePartitionMigrator } from "../../src/book-topology-record-class-migrators.ts";
import {
  readTicketProvenance,
  reprojectTicketProvenance,
  resolveTicketProvenanceVolume,
  TicketProvenanceInputError,
} from "../../src/ticket-provenance.ts";
import { createDiaristRoleRuntime } from "../../src/role-runtime.ts";
import { ParentQueueReaskError } from "../../src/submission-errors.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
  type LegacyFauxPiRunner,
} from "../helpers/role-turn-host-fixture.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

const TICKET = 708;

const immutablePrincipalAuthority: DurablePrincipalAuthority = {
  issue(request) {
    const coordinates = piDurablePrincipalAuthority.decode(
      piDurablePrincipalAuthority.issue(request),
    );
    return Object.freeze({ coordinates }) as DurablePrincipal;
  },
  seal(coordinates) {
    return Object.freeze({ coordinates, relocated: true }) as DurablePrincipal;
  },
  decode(principal) {
    const wire = principal as { coordinates?: unknown };
    return piDurablePrincipalAuthority.decode(wire.coordinates ?? principal);
  },
  async isAvailable(principal) {
    return piDurablePrincipalAuthority.isAvailable(
      piDurablePrincipalAuthority.seal(this.decode(principal)),
    );
  },
};

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-public-cli-diarist-", async (home) => scenario(home));
}

type RegisteredTool = {
  readonly name: string;
  execute(
    toolCallId: string,
    parameters: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: HostContext,
  ): Promise<{ details?: unknown }>;
};

type DiaristSubmit = unknown | ((round: number, lastReask?: string) => unknown);

/**
 * Faux pi process for this seat: drives the production diarist role envelope.
 * Supports the #901 reask loop (unusable bounds / unparsable-line amendments).
 */
function diaristEnvelopeRunner(
  submitted: DiaristSubmit,
  behavior?: { readonly afterAdmit?: "throw" },
): LegacyFauxPiRunner {
  return async (args, options) => {
    let registered: RegisteredTool | undefined;
    const host = {
      registerTool(tool: unknown) {
        registered = tool as RegisteredTool;
      },
      on() {},
      getAllTools: () => (registered === undefined ? [] : [{ name: registered.name }]),
    } as unknown as RoleHost;
    const runDir = options.env.AK_ROLE_RUN_DIR;
    assert.ok(runDir);
    const sessionDir = join(runDir, "session");
    const sessionFile = join(sessionDir, "session.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionFile, "");
    const runtime = createDiaristRoleRuntime(host, {
      loadSoul: async () => "起居郎职分（测试装载）",
    });
    await runtime.activate();
    assert.ok(registered, "diarist envelope registered no output tool");

    const ctx = {
      runDirectory: runDir,
      sessionManager: {
        getSessionDir: () => sessionDir,
        getSessionFile: () => sessionFile,
      },
    } as HostContext;

    let round = 0;
    let lastReask: string | undefined;
    let accepted: { details?: unknown } | undefined;
    // No round cap in production either — fixture stops after a generous bound
    // so a stuck reask fails the test instead of hanging the suite.
    while (round < 8) {
      round += 1;
      const payload =
        typeof submitted === "function" ? submitted(round, lastReask) : submitted;
      try {
        accepted = await registered.execute(
          `call_diarist_${round}`,
          payload,
          undefined,
          undefined,
          ctx,
        );
        break;
      } catch (error) {
        if (!(error instanceof ParentQueueReaskError)) throw error;
        lastReask = error.message;
        if (typeof submitted !== "function") throw error;
      }
    }
    assert.ok(accepted, `diarist did not accept within ${round} rounds; last reask: ${lastReask ?? "(none)"}`);

    if (behavior?.afterAdmit === "throw") {
      throw new Error("host turn failed after diarist board bind");
    }
    return scriptedTerminatingToolSession({
      role: "diarist",
      toolName: DIARIST_OUTPUT_TOOL_NAME,
      details: accepted.details,
    })(args, options);
  };
}

/**
 * Session fixture covering the #901 external contracts in one volume:
 * ordinary owner message coexisting with enqueue, queue-sourced owner input +
 * paired dequeue materialization (no double-count), empty-content enqueue whose
 * sole materialization user must be kept, runner reply, pure tool result
 * (excluded), mixed tool_result+text (text kept), Codex response_item dialogue,
 * absorbed interjection (enqueue-only), duplicate id (first-seen), and one
 * unparsable line. Path must sit under an authorized host session root.
 */
async function writeDialogueSessionFixture(path: string): Promise<{
  readonly path: string;
  readonly plainOwnerId: string;
  readonly plainOwnerText: string;
  readonly ownerId: string;
  readonly emptyEnqueueOwnerId: string;
  readonly emptyEnqueueOwnerText: string;
  readonly runnerId: string;
  readonly mixedOwnerText: string;
  readonly codexOwnerText: string;
  readonly codexRunnerText: string;
  readonly codexInjectionText: string;
  readonly interjectionId: string;
  readonly duplicateId: string;
  readonly unparsableLine: number;
  readonly unparsableRaw: string;
  readonly lastLine: number;
}> {
  const plainOwnerId = "msg-plain-owner";
  const plainOwnerText = "陛下的普通发言";
  const ownerId = "msg-owner-1";
  const emptyEnqueueOwnerId = "msg-empty-enq-owner";
  const emptyEnqueueOwnerText = "这种问题你联网搜一下好吗？直接copy过来能行吗？";
  const runnerId = "msg-runner-1";
  const mixedOwnerText = "工具旁路的原话要留";
  const codexOwnerText = "Codex 上拍的决定";
  const codexRunnerText = "Codex runner 回话";
  const codexInjectionText = "# AGENTS.md instructions for /workspace";
  const interjectionId = "queue-interject-1";
  const duplicateId = "msg-dup-1";
  const unparsableRaw = "{this is not json at all";
  const rows = [
    // 1. ordinary owner message — must survive alongside later enqueue events
    JSON.stringify({
      type: "user",
      uuid: plainOwnerId,
      message: {
        role: "user",
        content: [{ type: "text", text: plainOwnerText }],
      },
    }),
    // 2. owner via queue enqueue
    JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      uuid: ownerId,
      content: "立文件。送司天台记录。",
    }),
    // 3. paired dequeue
    JSON.stringify({
      type: "queue-operation",
      operation: "dequeue",
      uuid: "queue-deq-1",
    }),
    // 4. dequeue materialization — same words as enqueue; must not double-count
    JSON.stringify({
      type: "user",
      uuid: "msg-owner-materialized",
      message: {
        role: "user",
        content: [{ type: "text", text: "立文件。送司天台记录。" }],
      },
    }),
    // 5. empty-content enqueue — fromQueueEvent retains nothing
    JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      uuid: "queue-empty-1",
    }),
    // 6. its dequeue must not authorize skipping the sole human user below
    JSON.stringify({
      type: "queue-operation",
      operation: "dequeue",
      uuid: "queue-deq-empty",
    }),
    // 7. system noise between dequeue and user (real CC shape)
    JSON.stringify({
      type: "system",
      uuid: "sys-1",
      content: "status",
    }),
    // 8. sole materialization of the empty enqueue — must keep verbatim
    JSON.stringify({
      type: "user",
      uuid: emptyEnqueueOwnerId,
      message: {
        role: "user",
        content: [{ type: "text", text: emptyEnqueueOwnerText }],
      },
    }),
    // 9. runner assistant reply — two text blocks share one native id (must both keep)
    JSON.stringify({
      type: "assistant",
      uuid: runnerId,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "已写入 records.jsonl。" },
          { type: "text", text: "下一步送符宝郎。" },
        ],
      },
    }),
    // 10. pure tool result payload — must not enter the diary
    JSON.stringify({
      type: "user",
      uuid: "tool-result-1",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ls -la output 12085 chars" }],
      },
    }),
    // 11. mixed tool_result + speaker text — keep text only
    JSON.stringify({
      type: "user",
      uuid: "mixed-tool-text",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t2", content: "should not land" },
          { type: "text", text: mixedOwnerText },
        ],
      },
    }),
    // 12. Codex developer injection — never owner/runner dialogue
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "<permissions instructions> sandbox" }],
      },
    }),
    // 13. Desktop Codex injection-only turn (kinds, no event_msg) — must not be owner
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        id: "msg-codex-inject-only",
        content: [
          { type: "input_text", text: codexInjectionText },
          { type: "input_text", text: "<environment_context> cwd=/tmp" },
        ],
        internal_chat_message_metadata_passthrough: {
          turn_id: "turn-inject-only",
          content_item_kinds: [
            "plugins.recommendations",
            "agents_md.instructions",
            "environments.environment_context",
          ],
        },
      },
    }),
    // 14. Same-turn injection + real user: injection kinds first
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        id: "msg-codex-inject-paired",
        content: [{ type: "input_text", text: codexInjectionText }],
        internal_chat_message_metadata_passthrough: {
          turn_id: "turn-paired",
          content_item_kinds: [
            "agents_md.instructions",
            "environments.environment_context",
          ],
        },
      },
    }),
    // 15. Desktop Codex real owner (content_item_kinds user.text) — no event_msg needed
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        id: "msg-codex-owner",
        content: [{ type: "input_text", text: codexOwnerText }],
        internal_chat_message_metadata_passthrough: {
          turn_id: "turn-paired",
          content_item_kinds: ["user.text"],
        },
      },
    }),
    // 16. event_msg.user_message has no provenance kinds — must NOT become owner
    // (exec volumes pair this with worker-entrypoint injection; cannot prove owner).
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "# Coder worker entrypoint\n\nRead the baked role soul first",
        images: [],
        local_images: [],
        text_elements: [],
      },
    }),
    // 17. Codex rollout runner (response_item + output_text)
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        id: "msg-codex-runner",
        content: [{ type: "output_text", text: codexRunnerText }],
      },
    }),
    // 18. absorbed interjection (enqueue + dequeue; no independent message record)
    JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      uuid: interjectionId,
      content: "中途插一句：保留原话。",
    }),
    JSON.stringify({
      type: "queue-operation",
      operation: "dequeue",
      uuid: "queue-deq-2",
    }),
    // 19. first occurrence of duplicate id
    JSON.stringify({
      type: "assistant",
      uuid: duplicateId,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "首现正文" }],
      },
    }),
    // 20. unparsable line (completed by terminator)
    unparsableRaw,
    // 21. duplicate id second occurrence — must not re-enter
    JSON.stringify({
      type: "assistant",
      uuid: duplicateId,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "副本正文（应被首现吞掉）" }],
      },
    }),
  ];
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${rows.join("\n")}\n`, "utf8");
  // Line numbers are 1-based physical lines matching the file we just wrote.
  return {
    path,
    plainOwnerId,
    plainOwnerText,
    ownerId,
    emptyEnqueueOwnerId,
    emptyEnqueueOwnerText,
    runnerId,
    mixedOwnerText,
    codexOwnerText,
    codexRunnerText,
    codexInjectionText,
    interjectionId,
    duplicateId,
    unparsableLine: 21,
    unparsableRaw,
    lastLine: 22,
  };
}

test("ak-role diarist projects dialogue bounds, skips unparsable, reasks, lands amendment", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    // Path under authorized host session root (ADR 0038 real I/O seam).
    const fixture = await writeDialogueSessionFixture(
      join(home, ".claude", "projects", "probe", "session.jsonl"),
    );

    // Seed an already-accepted authoritative volume so round-1 unparsable reask
    // must leave it byte-identical (publication integrity).
    const paths = resolveTicketProvenanceVolume(TICKET, project, home);
    await mkdir(paths.volumeDir, { recursive: true });
    const priorBody = `${JSON.stringify({
      repo: resolveBookKeyFromGit(project),
      ticket: TICKET,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sessions: [{ path: fixture.path, ranges: [{ from: { line: 1 }, to: { line: 1 } }] }],
    })}\n${JSON.stringify({
      speaker: "owner",
      s: 0,
      line: 1,
      id: "prior-seed",
      text: "既有权威卷原文",
    })}\n`;
    await writeFile(paths.recordFile, priorBody, "utf8");
    const priorBytes = priorBody;
    let sawUnparsableReask = false;

    const runId = "01a0diar00-0000-7000-8000-000000000001";
    const { io, stdout } = captureIo();
    const result = await runAkRole(
      ["diarist", "--project", project, `整理 #${TICKET} 起居录`],
      {
        home,
        packageRoot,
        cwd: project,
        io,
        createRunId: () => runId,
        principalAuthority: immutablePrincipalAuthority,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: immutablePrincipalAuthority,
          piRunner: diaristEnvelopeRunner((round: number, lastReask?: string) => {
            if (round === 1) {
              return {
                status: "completed",
                ticketNumber: TICKET,
                sessions: [
                  {
                    path: fixture.path,
                    // Overlapping ranges: must merge, not double-emit id-less rows.
                    ranges: [
                      { from: { line: 1 }, to: { line: fixture.lastLine } },
                      { from: { line: 12 }, to: { line: fixture.lastLine } },
                    ],
                  },
                ],
              };
            }
            // Second turn: cover the unparsable line handed back by reask.
            assert.ok(lastReask, "expected unparsable-line reask before amendment");
            assert.match(lastReask, /amendments/);
            assert.ok(lastReask.includes(fixture.unparsableRaw));
            sawUnparsableReask = true;
            // Rejected first submission must not have rewritten the prior volume.
            assert.equal(
              readFileSync(paths.recordFile, "utf8"),
              priorBytes,
              "first-round unparsable reask must not publish over the prior diary",
            );
            return {
              status: "completed",
              ticketNumber: TICKET,
              sessions: [
                {
                  path: fixture.path,
                  ranges: [{ from: { line: 1 }, to: { line: fixture.lastLine } }],
                },
              ],
              amendments: [
                {
                  s: 0,
                  line: fixture.unparsableLine,
                  speaker: "owner",
                  text: "补写：坏行原话由起居郎交回。",
                },
              ],
            };
          }),
        }),
      },
    );

    assert.equal(result.exitCode, 0, stdout.join("") || "diarist run failed");
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.equal(result.terminal?.roleOutcome.role, "diarist");
    assert.equal(sawUnparsableReask, true, "expected an unparsable reask before accept");

    const placement = roleRunPlacement(resolveActivationLedgerHome(home), {
      bookKey: resolveBookKeyFromGit(project),
      subject: { ticketNumber: TICKET },
      runId,
      role: "diarist",
    });
    const state = await readRoleRunState(
      placement.runDirectory,
      immutablePrincipalAuthority,
    );
    assert.equal(state?.role, "diarist");
    assert.equal(state?.state, "terminal");

    const volume = await readTicketProvenance(TICKET, project, home);
    assert.equal(volume.recordFile, paths.recordFile);
    assert.equal(existsSync(paths.recordFile), true, "unique diary file must exist");
    // Human view cancelled (#900 / single-volume).
    assert.equal(existsSync(join(paths.volumeDir, "起居录.md")), false);

    assert.ok(volume.header, "diary header must be present");
    assert.equal(volume.header.ticket, TICKET);
    assert.equal(volume.header.sessions.length, 1);
    assert.equal(volume.header.sessions[0]?.path, fixture.path);

    // Speakers + first-seen identity + no tool output + amendment landed.
    const byId = new Map(
      volume.lines.filter((line) => line.id !== undefined).map((line) => [line.id!, line]),
    );
    // Ordinary owner message coexists with enqueue in the same volume.
    assert.equal(byId.get(fixture.plainOwnerId)?.speaker, "owner");
    assert.equal(byId.get(fixture.plainOwnerId)?.text, fixture.plainOwnerText);
    assert.equal(byId.get(fixture.ownerId)?.speaker, "owner");
    assert.equal(byId.get(fixture.ownerId)?.text, "立文件。送司天台记录。");
    // Dequeue materialization must not double-count the enqueue text.
    assert.equal(
      volume.lines.filter((line) => line.text === "立文件。送司天台记录。").length,
      1,
    );
    assert.equal(
      volume.lines.some((line) => line.id === "msg-owner-materialized"),
      false,
    );
    // Empty-content enqueue retains nothing — its sole user materialization stays.
    assert.equal(byId.get(fixture.emptyEnqueueOwnerId)?.speaker, "owner");
    assert.equal(
      byId.get(fixture.emptyEnqueueOwnerId)?.text,
      fixture.emptyEnqueueOwnerText,
    );
    assert.equal(byId.get(fixture.runnerId)?.speaker, "runner");
    assert.equal(
      byId.get(fixture.runnerId)?.text,
      "已写入 records.jsonl。下一步送符宝郎。",
    );
    assert.equal(byId.get(fixture.interjectionId)?.speaker, "owner");
    assert.equal(byId.get(fixture.interjectionId)?.text, "中途插一句：保留原话。");
    assert.equal(byId.get(fixture.duplicateId)?.text, "首现正文");
    // Duplicate second occurrence must not produce a second line with that id.
    assert.equal(
      volume.lines.filter((line) => line.id === fixture.duplicateId).length,
      1,
    );
    // Pure tool result never enters; mixed message keeps speaker text only.
    assert.equal(
      volume.lines.some((line) => line.text.includes("ls -la") || line.text.includes("should not land")),
      false,
    );
    assert.equal(
      volume.lines.filter((line) => line.text === fixture.mixedOwnerText).length,
      1,
    );
    // Codex desktop: content_item_kinds user.text keeps owner; injection kinds drop.
    assert.equal(
      volume.lines.filter((line) => line.text === fixture.codexOwnerText).length,
      1,
    );
    assert.equal(
      volume.lines.filter((line) => line.text === fixture.codexRunnerText).length,
      1,
    );
    assert.equal(
      volume.lines.some(
        (line) =>
          line.text.includes(fixture.codexInjectionText) ||
          line.text.includes("permissions instructions") ||
          line.text.includes("environment_context") ||
          line.text.includes("Coder worker entrypoint"),
      ),
      false,
      "Codex structured injections and unproven event_msg must not become owner",
    );
    // Amendment at the unparsable line.
    const amended = volume.lines.find((line) => line.line === fixture.unparsableLine);
    assert.ok(amended, "amended unparsable line must land");
    assert.equal(amended.speaker, "owner");
    assert.equal(amended.text, "补写：坏行原话由起居郎交回。");

    // Codex payload.id is both landed and resolvable as a bound endpoint (single nativeEventId).
    assert.equal(byId.get("msg-codex-owner")?.text, fixture.codexOwnerText);
    assert.equal(byId.get("msg-codex-runner")?.text, fixture.codexRunnerText);
    const byPayloadId = await reprojectTicketProvenance({
      ticketNumber: TICKET,
      cwd: project,
      home,
      sessions: [
        {
          path: fixture.path,
          ranges: [
            {
              from: { id: "msg-codex-owner" },
              to: { id: "msg-codex-runner" },
            },
          ],
        },
      ],
    });
    assert.equal(
      byPayloadId.lines.some((line) => line.id === "msg-codex-owner"),
      true,
      "bound by Codex payload id must resolve",
    );
    assert.equal(byPayloadId.unparsable.length, 0);

    // Amendments-only continuation: empty sessions reuses prior header sessions (not no-op).
    // Restore full-range header first so amendments-only has bounds to apply.
    await reprojectTicketProvenance({
      ticketNumber: TICKET,
      cwd: project,
      home,
      sessions: [
        {
          path: fixture.path,
          ranges: [{ from: { line: 1 }, to: { line: fixture.lastLine } }],
        },
      ],
      amendments: [
        {
          s: 0,
          line: fixture.unparsableLine,
          speaker: "owner",
          text: "补写：坏行原话由起居郎交回。",
        },
      ],
    });
    const amendOnly = await reprojectTicketProvenance({
      ticketNumber: TICKET,
      cwd: project,
      home,
      sessions: [],
      amendments: [
        {
          s: 0,
          line: fixture.unparsableLine,
          speaker: "owner",
          text: "amendments-only 续写",
        },
      ],
    });
    assert.equal(
      amendOnly.lines.find((line) => line.line === fixture.unparsableLine)?.text,
      "amendments-only 续写",
      "amendments-only must reproject via prior header sessions",
    );
    // Seed volume with lawful empty sessions header — amendments-only must typed-fail.
    await writeFile(
      paths.recordFile,
      `${JSON.stringify({
        repo: resolveBookKeyFromGit(project),
        ticket: TICKET,
        createdAt: "t0",
        updatedAt: "t0",
        sessions: [],
      })}\n`,
      "utf8",
    );
    await assert.rejects(
      () =>
        reprojectTicketProvenance({
          ticketNumber: TICKET,
          cwd: project,
          home,
          sessions: [],
          amendments: [{ s: 0, line: 1, speaker: "owner", text: "x" }],
        }),
      (error: unknown) => error instanceof TicketProvenanceInputError,
    );

    // Restore a good volume for subsequent damage/path probes.
    await reprojectTicketProvenance({
      ticketNumber: TICKET,
      cwd: project,
      home,
      sessions: [
        {
          path: fixture.path,
          ranges: [{ from: { line: 1 }, to: { line: fixture.lastLine } }],
        },
      ],
      amendments: [
        {
          s: 0,
          line: fixture.unparsableLine,
          speaker: "owner",
          text: "补写：坏行原话由起居郎交回。",
        },
      ],
    });

    // On-disk shape: first line header, bare dialogue rows after (no SitianRecord shell).
    const rawFile = await readFile(paths.recordFile, "utf8");
    const rawLines = rawFile.split("\n").filter((line) => line.trim() !== "");
    assert.equal(JSON.parse(rawLines[0]!).ticket, TICKET);
    assert.equal(typeof JSON.parse(rawLines[1]!).speaker, "string");
    assert.equal(JSON.parse(rawLines[1]!).kind, undefined);

    // Empty sessions must preserve any existing non-empty volume (damaged header too).
    const damagedBody = `{"repo":"x","ticket":${TICKET},"createdAt":"t0","updatedAt":"t0","sessions":"bad"}\n{"speaker":"owner","s":0,"text":"opaque-preserved"}\n`;
    await writeFile(paths.recordFile, damagedBody, "utf8");
    await reprojectTicketProvenance({
      ticketNumber: TICKET,
      cwd: project,
      home,
      sessions: [],
    });
    assert.equal(
      await readFile(paths.recordFile, "utf8"),
      damagedBody,
      "empty sessions must not wipe a non-empty volume lacking a lawful header",
    );

    // Broad host roots are not session sources: `.pi/not-a-session.jsonl` stays out.
    const decoy = join(home, ".pi", "not-a-session.jsonl");
    await mkdir(join(home, ".pi"), { recursive: true });
    await writeFile(
      decoy,
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "decoy" }] },
      })}\n`,
      "utf8",
    );
    await assert.rejects(
      () =>
        reprojectTicketProvenance({
          ticketNumber: TICKET,
          cwd: project,
          home,
          sessions: [{ path: decoy, ranges: [{ from: { line: 1 }, to: { line: 1 } }] }],
        }),
      /session unreadable/,
    );
    assert.equal(
      await readFile(paths.recordFile, "utf8"),
      damagedBody,
      "rejected path must not rewrite the preserved volume",
    );

    // Bare + legacy migration for the same ticket must not mix (header stays first line).
    const bookKey = resolveBookKeyFromGit(project);
    const backupBooks = join(home, "mig-backup", "books");
    const destBooks = join(home, "mig-dest", "books");
    const legacyDir = join(backupBooks, bookKey, "ticket-provenance");
    const bareDir = join(backupBooks, bookKey, String(TICKET));
    await mkdir(legacyDir, { recursive: true });
    await mkdir(bareDir, { recursive: true });
    await writeFile(
      join(legacyDir, "records.jsonl"),
      `${JSON.stringify({
        kind: "ticket-provenance",
        subject: String(TICKET),
        identity: "legacy-1",
        payload: { note: "old" },
      })}\n`,
      "utf8",
    );
    const bareHeader = JSON.stringify({
      repo: bookKey,
      ticket: TICKET,
      createdAt: "t0",
      updatedAt: "t0",
      sessions: [],
    });
    const bareLine = JSON.stringify({
      speaker: "owner",
      s: 0,
      text: "bare-body",
    });
    await writeFile(
      join(bareDir, "records.jsonl"),
      `${bareHeader}\n${bareLine}\n`,
      "utf8",
    );
    await mkdir(destBooks, { recursive: true });
    await ticketProvenancePartitionMigrator.migrate({
      backupBooksDirectory: backupBooks,
      booksDirectory: destBooks,
    });
    const migrated = await readFile(
      join(destBooks, bookKey, String(TICKET), "records.jsonl"),
      "utf8",
    );
    const migratedLines = migrated.split("\n").filter((line) => line.trim() !== "");
    assert.equal(JSON.parse(migratedLines[0]!).ticket, TICKET);
    assert.equal(JSON.parse(migratedLines[0]!).kind, undefined);
    assert.equal(
      migratedLines.some((line) => {
        try {
          return JSON.parse(line).kind === "ticket-provenance";
        } catch {
          return false;
        }
      }),
      false,
      "legacy SitianRecord must not sit under bare header",
    );
    assert.equal(JSON.parse(migratedLines[1]!).text, "bare-body");
  });
});

test("ak-role diarist true-unbound leaves no 起居录", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const runId = "01a0diar00-0000-7000-8000-000000000002";
    const { io, stdout } = captureIo();
    const result = await runAkRole(
      ["diarist", "--project", project, "整理这份方案的依据"],
      {
        home,
        packageRoot,
        cwd: project,
        io,
        createRunId: () => runId,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: diaristEnvelopeRunner({
            status: "completed",
            ticketNumber: null,
            sessions: [],
          }),
        }),
      },
    );

    assert.equal(result.exitCode, 0, stdout.join("") || "true-unbound failed");
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    const facts = (
      result.terminal?.roleOutcome as {
        decisiveFacts?: { ticketNumber?: unknown; sitian?: unknown };
      }
    ).decisiveFacts;
    assert.equal(facts?.ticketNumber ?? null, null);
    assert.equal(facts?.sitian, undefined);

    // 真无票→无录: ticket dir itself (topology authority) stays unminted.
    const sample = resolveTicketProvenanceVolume(1, project, home);
    assert.equal(existsSync(sample.recordFile), false);
    assert.equal(
      existsSync(sample.volumeDir),
      false,
      `true-unbound must not mint ticket dir ${sample.volumeDir}`,
    );
    assert.equal(existsSync(join(sample.volumeDir, "起居录.md")), false);
  });
});

/**
 * Host turn already started + board ticket already written by the accept hook,
 * then the turn fails: failure stays honest and the run still relocates under the
 * ticket before lease release (shared afterDispatch once-only finish).
 */
test("ak-role diarist host-turn failure still relocates board-bound run", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    // Temp-home config only — never the real seat table. Zero resume budget so
    // this tracer stays on the post-turn relocate seam.
    await mkdir(join(home, ".ak-roles"), { recursive: true });
    await writeFile(
      join(home, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ autoResumeLimit: 0 }, null, 2)}\n`,
    );

    const runId = "01a0diar00-0000-7000-8000-000000000003";
    const { io } = captureIo();

    const result = await runAkRole(
      ["diarist", "--project", project, `整理 #${TICKET} 起居录`],
      {
        home,
        packageRoot,
        cwd: project,
        io,
        createRunId: () => runId,
        principalAuthority: immutablePrincipalAuthority,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: immutablePrincipalAuthority,
          piRunner: diaristEnvelopeRunner(
            {
              status: "completed",
              ticketNumber: TICKET,
              sessions: [],
            },
            { afterAdmit: "throw" },
          ),
        }),
      },
    );

    assert.notEqual(result.exitCode, 0, "host failure must stay non-zero");
    assert.equal(result.terminal?.roleOutcome.kind, "failure");

    const bookKey = resolveBookKeyFromGit(project);
    const ticketPlacement = roleRunPlacement(resolveActivationLedgerHome(home), {
      bookKey,
      subject: { ticketNumber: TICKET },
      runId,
      role: "diarist",
    });
    const unboundPlacement = roleRunPlacement(resolveActivationLedgerHome(home), {
      bookKey,
      subject: { unbound: true },
      runId,
      role: "diarist",
    });
    assert.equal(
      existsSync(join(ticketPlacement.runDirectory, "run-state.json")),
      true,
      `failure run must relocate under ticket with durable state at ${ticketPlacement.runDirectory}`,
    );
    assert.equal(
      existsSync(join(unboundPlacement.runDirectory, "run-state.json")),
      false,
      "unbound must not keep the durable run-state after relocate",
    );
  });
});
