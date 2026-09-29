/**
 * #708 / #779 / #901 public 起居郎 seat — `ak-role diarist` is a role like the other seats.
 * LLM submits bounds; mechanical layer reprojects records.jsonl.
 * Real public entry; diary projection uses on-disk sessions, status reask uses the real envelope.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
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
import { readRecordedSubmissionRows } from "../../src/submission-ledger.ts";
import { ATTEMPT_HISTORY_ENTRY_TYPE } from "../../src/public-cli/settlement.ts";
import { roleRunPlacement } from "../../src/role-run-placement.ts";
import { migrateBookTopology } from "../../src/book-topology-migration.ts";
import { BOOK_TOPOLOGY_PARTITION_MIGRATORS } from "../../src/book-topology-partition-migrators.ts";
import { BOOK_TOPOLOGY_MIXED_VOLUME_MIGRATORS } from "../../src/book-topology-mixed-volume-migrators.ts";
import { relocateBoardBoundUnboundRunsInBooks } from "../../src/book-topology-runs-migrator.ts";
import { findPlacedMigratingRun } from "../../src/book-topology-migration-placement.ts";
import { resolveTicketProvenanceVolume } from "../../src/ticket-provenance.ts";
import { readTicketProvenanceRecords as readTicketProvenance } from "../helpers/ticket-provenance-fixture.ts";
import { createDiaristRoleRuntime } from "../../src/role-runtime.ts";
import { ParentQueueReaskError } from "../../src/submission-errors.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  roleTurnHostFromStructuredOutputRounds,
  scriptedTerminatingToolSession,
  type LegacyFauxPiRunner,
} from "../helpers/role-turn-host-fixture.ts";
import {
  captureIo,
  seedGitProject,
} from "../helpers/failure-settlement-kit.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { payloadStatusSequence } from "../helpers/terminal-payload.ts";
import { observeTyped429ViaProductionHandler } from "../helpers/typed-429-observation.ts";

const TICKET = 708;

test("worker gate topology migration ignores the retired current-session pointer", async () => {
  await withTempRoot("ak-book-topology-gate-", async (home) => {
    const ledgerHome = join(home, ".ak-roles");
    const sourceDir = join(
      ledgerHome,
      "books",
      "demo-book",
      "worker-submission-gate",
    );
    const volume = join(sourceDir, "gate-session.jsonl");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(volume, `${JSON.stringify({ type: "session" })}\n`, "utf8");
    await writeFile(
      join(sourceDir, "current-session.json"),
      `${JSON.stringify({ sessionFile: volume })}\n`,
      "utf8",
    );

    const report = await migrateBookTopology({
      ledgerHome,
      migrators: BOOK_TOPOLOGY_MIXED_VOLUME_MIGRATORS,
      env: {},
      now: new Date("2026-09-22T00:00:00.000Z"),
    });

    const destination = join(
      report.booksDirectory,
      "demo-book",
      "unbound",
      "worker-submission-gate",
    );
    assert.equal(existsSync(join(destination, "gate-session.jsonl")), true);
    assert.equal(existsSync(join(destination, "current-session.json")), false);
  });
});

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
};

async function withTempHome<T>(
  scenario: (home: string) => Promise<T>,
): Promise<T> {
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
 * Supports the #901 unusable-bounds reask loop.
 */
function diaristEnvelopeRunner(
  submitted: DiaristSubmit,
  behavior?: {
    readonly afterAdmit?: "throw";
    readonly afterReask?: () => Promise<boolean>;
  },
): LegacyFauxPiRunner {
  return async (args, options) => {
    let registered: RegisteredTool | undefined;
    const host = {
      registerTool(tool: unknown) {
        registered = tool as RegisteredTool;
      },
      on() {},
      getAllTools: () =>
        registered === undefined ? [] : [{ name: registered.name }],
    } as unknown as RoleHost;
    const runDir = options.env.AK_ROLE_RUN_DIR;
    assert.ok(runDir);
    const sessionDir = join(runDir, "session");
    const sessionFile = join(sessionDir, "session.jsonl");
    await mkdir(sessionDir, { recursive: true });
    // Resume turns share the same ticket-run session. Do not truncate prior
    // run-owned records (ak_run_attempt_history) that settlement already appended.
    const sessionAlreadyPresent = existsSync(sessionFile);
    if (!sessionAlreadyPresent) {
      await writeFile(sessionFile, "");
    }
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
        typeof submitted === "function"
          ? submitted(round, lastReask)
          : submitted;
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
        if (await behavior?.afterReask?.()) {
          return { code: 1, stderr: "", timedOut: false, args: [...args] };
        }
        if (typeof submitted !== "function") throw error;
      }
    }
    assert.ok(
      accepted,
      `diarist did not accept within ${round} rounds; last reask: ${lastReask ?? "(none)"}`,
    );

    if (behavior?.afterAdmit === "throw") {
      throw new Error("host turn failed after diarist board bind");
    }
    return scriptedTerminatingToolSession({
      role: "diarist",
      toolName: DIARIST_OUTPUT_TOOL_NAME,
      details: accepted.details,
      sessionWriteMode: sessionAlreadyPresent ? "append" : "replace",
    })(args, options);
  };
}

/**
 * Session fixture covering the #901 external contracts in one volume:
 * ordinary owner message coexisting with enqueue, queue-sourced owner input +
 * paired dequeue materialization (no double-count), empty-content enqueue whose
 * sole materialization user must be kept, runner reply, pure tool result
 * (excluded), mixed tool_result+text (text kept), Codex response_item dialogue,
 * absorbed interjection (enqueue-only), repeated native id, and one
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
  readonly taskNotificationEnqueueId: string;
  readonly taskNotificationText: string;
  readonly humanOriginEnqueueId: string;
  readonly humanOriginText: string;
  readonly peerOriginEnqueueId: string;
  readonly peerOriginText: string;
  readonly peerQuoteInterjectionId: string;
  readonly peerQuoteInterjectionText: string;
  readonly humanOriginDirectId: string;
  readonly humanOriginDirectText: string;
  readonly removeMachineEnqueueId: string;
  readonly removeMachineText: string;
  readonly slashEnqueueId: string;
  readonly slashEnqueueText: string;
  readonly bareMachineEnqueueId: string;
  readonly bareMachineText: string;
  readonly unparsableRaw: string;
  readonly lastLine: number;
  /** Physical line of plain owner (range A anchor). */
  readonly rangeALine: number;
  /** Physical line of queue owner enqueue (range B anchor). */
  readonly rangeBLine: number;
}> {
  const plainOwnerId = "msg-plain-owner";
  const plainOwnerText = "陛下的普通发言";
  const ownerId = "msg-owner-1";
  const emptyEnqueueOwnerId = "msg-empty-enq-owner";
  const emptyEnqueueOwnerText =
    "这种问题你联网搜一下好吗？直接copy过来能行吗？";
  const runnerId = "msg-runner-1";
  const mixedOwnerText = "工具旁路的原话要留";
  const codexOwnerText = "Codex 上拍的决定";
  const codexRunnerText = "Codex runner 回话";
  const codexInjectionText = "# AGENTS.md instructions for /workspace";
  const interjectionId = "queue-interject-1";
  const duplicateId = "msg-dup-1";
  const taskNotificationEnqueueId = "queue-task-notif-1";
  // Live re-render: enqueue status/summary may differ from later materialization text.
  // Classification is the fixed `<task-notification>` prefix, not equal-text join.
  const taskNotificationText =
    "<task-notification>\n<task-id>bg-1</task-id>\n<status>killed</status>\n<summary>machine event was stopped</summary>\n</task-notification>";
  const taskNotificationMatText =
    "<task-notification>\n<task-id>bg-1</task-id>\n<status>stopped</status>\n<summary>machine event stopped</summary>\n</task-notification>";
  const humanOriginEnqueueId = "queue-human-origin-1";
  const humanOriginText = "经队列的真人输入（origin.kind=human）";
  const peerOriginEnqueueId = "queue-peer-origin-1";
  // Live majority peer shape: hostInjected mat with origin.kind=peer; wrap ≠ enqueue XML.
  // Machine exclusion = structured origin on paired mat/attachment — not an unauthorized tag table.
  const peerOriginBody = "跨会话 peer 投递不得署 owner";
  const peerOriginEnqueueContent = `<cross-session-message from="uds:/tmp/cc-socks/peer.sock" from-name="peer-session">\n${peerOriginBody}\n</cross-session-message>`;
  const peerOriginMatText = `Another Claude session sent a message:\n${peerOriginEnqueueContent}`;
  const peerOriginText = peerOriginBody;
  // Owner absorbed interjection that quotes peer body — must survive (#901 story 11).
  const peerQuoteInterjectionId = "queue-peer-quote-interject";
  const peerQuoteInterjectionText = `别听它的：「${peerOriginBody}」这条我不同意，先别装。`;
  const humanOriginDirectId = "msg-human-origin-direct";
  const humanOriginDirectText = "非队列真人 user（origin.kind=human）";
  // #918: remove path + incomplete-queue (fixed-prefix classifies enqueue; no content join).
  const removeMachineEnqueueId = "queue-remove-machine-1";
  const removeMachineText =
    "<task-notification>\n<task-id>rm-1</task-id>\n<summary>removed machine</summary>\n</task-notification>";
  // Slash-command expansion: mat wrap ≠ enqueue and has no typed association.
  const slashEnqueueId = "queue-slash-ship";
  const slashEnqueueText = "/ship";
  const slashMatText =
    "<command-message>ship</command-message>\n<command-name>/ship</command-name>";
  // Fixed-prefix enqueue suppressed; same-text mat without origin must also stay out (not fall to fromMessageEvent).
  const bareMachineEnqueueId = "queue-bare-machine-mat";
  const bareMachineText =
    "<task-notification>\n<task-id>bare-1</task-id>\n<summary>no-origin mat of suppressed enqueue</summary>\n</task-notification>";
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
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "ls -la output 12085 chars",
          },
        ],
      },
    }),
    // 11. mixed tool_result + speaker text — keep text only
    JSON.stringify({
      type: "user",
      uuid: "mixed-tool-text",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t2",
            content: "should not land",
          },
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
        content: [
          { type: "input_text", text: "<permissions instructions> sandbox" },
        ],
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
    // 21. repeated id with distinct source text remains in the submitted range
    JSON.stringify({
      type: "assistant",
      uuid: duplicateId,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "副本正文" }],
      },
    }),
    // 22. machine task-notification via queue — must NOT become owner (#918)
    JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      uuid: taskNotificationEnqueueId,
      content: taskNotificationText,
    }),
    // 23. paired dequeue
    JSON.stringify({
      type: "queue-operation",
      operation: "dequeue",
      uuid: "queue-deq-task-notif",
    }),
    // 24. re-rendered task-notification mat: text ≠ enqueue; origin.kind skips mat only
    JSON.stringify({
      type: "user",
      uuid: "msg-task-notif-mat",
      origin: { kind: "task-notification" },
      message: {
        role: "user",
        content: taskNotificationMatText,
      },
    }),
    // 25–27. live CC shape: queue human with origin.kind=human must stay owner (#918 bounce)
    JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      uuid: humanOriginEnqueueId,
      content: humanOriginText,
    }),
    JSON.stringify({
      type: "queue-operation",
      operation: "dequeue",
      uuid: "queue-deq-human-origin",
    }),
    JSON.stringify({
      type: "user",
      uuid: "msg-human-origin-mat",
      origin: { kind: "human" },
      message: {
        role: "user",
        content: [{ type: "text", text: humanOriginText }],
      },
    }),
    // 28–30. live majority peer: hostInjected, no origin.body; wrap text ≠ enqueue
    JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      uuid: peerOriginEnqueueId,
      content: peerOriginEnqueueContent,
    }),
    JSON.stringify({
      type: "queue-operation",
      operation: "dequeue",
      uuid: "queue-deq-peer-origin",
    }),
    JSON.stringify({
      type: "user",
      uuid: "msg-peer-origin-mat",
      origin: {
        kind: "peer",
        from: "local_peer-session-1",
        hostInjected: true,
        fromMode: "bypass",
      },
      message: {
        role: "user",
        content: [{ type: "text", text: peerOriginMatText }],
      },
    }),
    // 28b–28d. peer remove path: fixed prefix on enqueue; no body/prompt identity join
    JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      uuid: "queue-peer-remove-1",
      content: peerOriginEnqueueContent + "\n<!--remove-path-->",
    }),
    JSON.stringify({
      type: "attachment",
      uuid: "att-peer-remove-1",
      attachment: {
        type: "queued_command",
        commandMode: "prompt",
        prompt: peerOriginEnqueueContent + "\n<!--remove-path-->",
        origin: {
          kind: "peer",
          from: "local_peer-session-1",
          hostInjected: true,
          fromMode: "bypass",
        },
      },
    }),
    JSON.stringify({
      type: "queue-operation",
      operation: "remove",
      content: peerOriginEnqueueContent + "\n<!--remove-path-->",
      reason: "absorbed_mid_turn",
    }),
    // 28e–28g. owner interjection quoting peer body — must keep (no substring suppress).
    JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      uuid: peerQuoteInterjectionId,
      content: peerQuoteInterjectionText,
    }),
    JSON.stringify({
      type: "queue-operation",
      operation: "dequeue",
      uuid: "queue-deq-peer-quote",
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "msg-after-peer-quote",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "知道了，先按你的意见。" }],
      },
    }),
    // 31. non-queue user with origin.kind=human must still enter as owner
    JSON.stringify({
      type: "user",
      uuid: humanOriginDirectId,
      origin: { kind: "human" },
      message: {
        role: "user",
        content: [{ type: "text", text: humanOriginDirectText }],
      },
    }),
    // 32–34. live CC remove path: machine enqueue + queued_command.commandMode + remove
    // must NOT become owner (#918; fixed-prefix on enqueue, no content join).
    JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      uuid: removeMachineEnqueueId,
      content: removeMachineText,
    }),
    JSON.stringify({
      type: "attachment",
      uuid: "att-remove-machine-1",
      attachment: {
        type: "queued_command",
        commandMode: "task-notification",
        prompt: removeMachineText,
        timestamp: "2026-09-04T04:25:29.167Z",
      },
    }),
    JSON.stringify({
      type: "queue-operation",
      operation: "remove",
      content: removeMachineText,
      reason: "absorbed_mid_turn",
    }),
    // 35–37. slash-command expansion: enqueue text ≠ mat wrap, mat has no origin.
    // No typed association joins this materialization back to the enqueue.
    JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      uuid: slashEnqueueId,
      content: slashEnqueueText,
    }),
    JSON.stringify({
      type: "queue-operation",
      operation: "dequeue",
      uuid: "queue-deq-slash",
    }),
    JSON.stringify({
      type: "user",
      uuid: "msg-slash-mat",
      message: {
        role: "user",
        content: [{ type: "text", text: slashMatText }],
      },
    }),
    // 38–40. fixed-prefix classifies the enqueue only; the untyped materialization stays.
    JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      uuid: bareMachineEnqueueId,
      content: bareMachineText,
    }),
    JSON.stringify({
      type: "queue-operation",
      operation: "dequeue",
      uuid: "queue-deq-bare-machine",
    }),
    JSON.stringify({
      type: "user",
      uuid: "msg-bare-machine-mat",
      message: {
        role: "user",
        content: bareMachineText,
      },
    }),
    // 41–43. origin.kind classifies the materialized user only; it is not
    // reverse-attributed to the unlinked enqueue.
    JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      uuid: "queue-system-reminder-1",
      content: "<system-reminder>\nbackground shell exited\n</system-reminder>",
    }),
    JSON.stringify({
      type: "queue-operation",
      operation: "dequeue",
      uuid: "queue-deq-system-reminder",
    }),
    JSON.stringify({
      type: "user",
      uuid: "msg-system-reminder-mat",
      origin: { kind: "task-notification" },
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>\nbackground shell exited\n</system-reminder>",
          },
        ],
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
    taskNotificationEnqueueId,
    taskNotificationText,
    humanOriginEnqueueId,
    humanOriginText,
    peerOriginEnqueueId,
    peerOriginText,
    peerQuoteInterjectionId,
    peerQuoteInterjectionText,
    humanOriginDirectId,
    humanOriginDirectText,
    removeMachineEnqueueId,
    removeMachineText,
    slashEnqueueId,
    slashEnqueueText,
    bareMachineEnqueueId,
    bareMachineText,
    unparsableRaw,
    // rows[] length is the physical line count of the written session file.
    lastLine: 50,
    rangeALine: 1,
    rangeBLine: 2,
  };
}

test("public diarist accepts unreadable status before routing it back, and escalation skips bounds", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "01a0diar00-0000-7000-8000-0000000000c1";
    const unreadable = {
      status: { value: "completed" },
      ticketNumber: TICKET,
      sessions: [],
    };
    const corrected = {
      status: "escalate",
      reason: "无法辨认本庭对象",
      sessions: [{}],
    };
    const roleTurnHost = roleTurnHostFromStructuredOutputRounds({
      packageRoot,
      principalAuthority: immutablePrincipalAuthority,
      submissions: [unreadable, corrected],
    });

    const { io, stdout } = captureIo();
    const result = await runAkRole(
      ["diarist", "--model", "test/caller-seat:high", "--project", project, `整理 #${TICKET} 起居录`],
      {
        home,
        packageRoot,
        cwd: project,
        io,
        createRunId: () => runId,
        principalAuthority: immutablePrincipalAuthority,
        roleTurnHost,
      },
    );

    assert.equal(result.exitCode, 0, stdout.join("") || "diarist did not settle");
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.deepEqual(payloadStatusSequence(result.terminal!.roleOutcome), ["escalate"]);
    const submissions = await readRecordedSubmissionRows(project, runId, home);
    assert.deepEqual(submissions.map(({ kind, accepted }) => ({ kind, accepted })), [
      { kind: "accepted", accepted: unreadable },
      { kind: "accepted", accepted: corrected },
    ]);
  });
});

test("ak-role diarist projects dialogue bounds and preserves unparsable source bytes", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    // Path under authorized host session root (ADR 0038 real I/O seam).
    const fixture = await writeDialogueSessionFixture(
      join(home, ".claude", "projects", "probe", "session.jsonl"),
    );

    // Seed a legacy snapshot row. #1090 appends a new sitian commit after it;
    // prior bytes must remain and the new projection must land beside them.
    const paths = resolveTicketProvenanceVolume(TICKET, project, home);
    await mkdir(paths.volumeDir, { recursive: true });
    const priorBody = `${JSON.stringify({
      repo: resolveBookKeyFromGit(project),
      ticket: TICKET,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sessions: [],
    })}\n${JSON.stringify({
      speaker: "owner",
      s: 0,
      id: "prior-seed",
      text: "既有权威卷原文",
    })}\n`;
    await writeFile(paths.recordFile, priorBody, "utf8");
    const priorBytes = priorBody;
    let sawDirPathReask = false;
    // Authorized-root directory (not a session file) — EISDIR must reask, not fail the court.
    const sessionDirOnly = join(home, ".claude", "projects", "probe");

    const runId = "01a0diar00-0000-7000-8000-000000000001";
    const { io, stdout } = captureIo();
    const result = await runAkRole(
      [
        "diarist",
        "--model",
        "test/caller-seat:high",
        "--project",
        project,
        `整理 #${TICKET} 起居录`,
      ],
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
            (round: number, lastReask?: string) => {
              if (round === 1) {
                return {
                  status: "completed",
                  ticketNumber: TICKET,
                  sessions: [
                    {
                      path: sessionDirOnly,
                      ranges: [{ from: { line: 1 }, to: { line: 1 } }],
                    },
                  ],
                };
              }
              if (round === 2) {
                assert.ok(
                  lastReask,
                  "expected bounds reask for directory session path",
                );
                sawDirPathReask = true;
                assert.equal(
                  readFileSync(paths.recordFile, "utf8"),
                  priorBytes,
                  "directory-path reask must not publish over the prior diary",
                );
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
              throw new Error(`unexpected diarist round ${round}: ${lastReask ?? "none"}`);
            },
          ),
        }),
      },
    );

    assert.equal(result.exitCode, 0, stdout.join("") || "diarist run failed");
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.equal(result.terminal?.roleOutcome.role, "diarist");
    assert.equal(
      sawDirPathReask,
      true,
      "expected directory session path reask",
    );

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
    assert.equal(
      existsSync(paths.recordFile),
      true,
      "unique diary file must exist",
    );
    // Human view cancelled (#900 / single-volume).
    assert.equal(existsSync(join(paths.volumeDir, "起居录.md")), false);

    assert.ok(volume.header, "legacy snapshot header must remain");
    assert.equal(volume.header.ticket, TICKET);
    assert.equal(volume.appends.length, 1, "one pure-append commit");
    assert.equal(volume.appends[0]?.sessions.length, 1);
    assert.equal(volume.appends[0]?.sessions[0]?.path, fixture.path);
    assert.equal(
      volume.lines.some((line) => line.id === "prior-seed"),
      true,
      "prior snapshot dialogue must survive the append",
    );

    // Speakers + no tool output + raw-byte preservation.
    const byId = new Map(
      volume.lines
        .filter((line) => line.id !== undefined)
        .map((line) => [line.id!, line]),
    );
    // Ordinary owner message coexists with enqueue in the same volume.
    assert.equal(byId.get(fixture.plainOwnerId)?.speaker, "owner");
    assert.equal(byId.get(fixture.plainOwnerId)?.text, fixture.plainOwnerText);
    assert.equal(byId.get(fixture.ownerId)?.speaker, "owner");
    assert.equal(byId.get(fixture.ownerId)?.text, "立文件。送司天台记录。");
    // enqueue has no typed link to its materialized user. Preserve both rather than
    // guessing an identity from position or equal text.
    assert.equal(
      volume.lines.filter((line) => line.text === "立文件。送司天台记录。")
        .length,
      2,
    );
    assert.equal(byId.get("msg-owner-materialized")?.speaker, "owner");
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
    assert.equal(
      byId.get(fixture.interjectionId)?.text,
      "中途插一句：保留原话。",
    );
    // #918: fixed-prefix machine shapes + origin.kind mat skip; human must stay.
    assert.equal(
      volume.lines.some(
        (line) =>
          line.id === fixture.taskNotificationEnqueueId ||
          line.id === "msg-task-notif-mat" ||
          line.text === fixture.taskNotificationText,
      ),
      false,
      "fixed-shape enqueue and typed task materialization must not produce owner lines",
    );
    assert.equal(
      volume.lines.some((line) => line.id === "msg-peer-origin-mat"),
      false,
      "materialized peer user must consume its own typed origin.kind",
    );
    assert.equal(
      byId.get(fixture.peerOriginEnqueueId)?.speaker,
      "owner",
      "unlinked enqueue must retain the approved existing projection",
    );
    assert.equal(byId.get("queue-peer-remove-1")?.speaker, "owner");
    assert.equal(byId.get(fixture.humanOriginEnqueueId)?.speaker, "owner");
    assert.equal(
      byId.get(fixture.humanOriginEnqueueId)?.text,
      fixture.humanOriginText,
    );
    assert.equal(
      volume.lines.filter((line) => line.text === fixture.humanOriginText)
        .length,
      2,
      "human materialization and unlinked enqueue both remain",
    );
    // Non-queue human with origin.kind=human — real discrimination surface (no FIFO reverse-attr).
    assert.equal(byId.get(fixture.humanOriginDirectId)?.speaker, "owner");
    assert.equal(
      byId.get(fixture.humanOriginDirectId)?.text,
      fixture.humanOriginDirectText,
    );
    // Owner quote of peer body must survive (no substring identity suppress).
    assert.equal(
      byId.get(fixture.peerQuoteInterjectionId)?.text,
      fixture.peerQuoteInterjectionText,
      "owner interjection quoting peer body must stay",
    );
    // #918: remove path still classified by fixed prefix on enqueue content.
    assert.equal(
      volume.lines.some(
        (line) =>
          line.id === fixture.removeMachineEnqueueId ||
          line.text === fixture.removeMachineText,
      ),
      false,
      "removed machine queue item must not be owner",
    );
    // Untyped materializations are not classified by wrappers or queue position.
    assert.equal(byId.get(fixture.slashEnqueueId)?.speaker, "owner");
    assert.equal(
      byId.get(fixture.slashEnqueueId)?.text,
      fixture.slashEnqueueText,
    );
    assert.equal(byId.get("msg-slash-mat")?.speaker, "owner");
    // A typed machine materialization is excluded, but its unlinked enqueue remains.
    assert.equal(byId.get("msg-system-reminder-mat"), undefined);
    assert.equal(byId.get("queue-system-reminder-1")?.speaker, "owner");
    // Fixed-prefix authority applies to enqueue only; an untyped user is not reverse-linked.
    assert.equal(byId.get(fixture.bareMachineEnqueueId), undefined);
    assert.equal(byId.get("msg-bare-machine-mat")?.speaker, "owner");
    assert.deepEqual(
      volume.lines.filter((line) => line.id === fixture.duplicateId).map((line) => line.text),
      ["首现正文", "副本正文"],
    );
    // Pure tool result never enters; mixed message keeps speaker text only.
    assert.equal(
      volume.lines.some(
        (line) =>
          line.text.includes("ls -la") || line.text.includes("should not land"),
      ),
      false,
    );
    assert.equal(
      volume.lines.filter((line) => line.text === fixture.mixedOwnerText)
        .length,
      1,
    );
    // Codex desktop: content_item_kinds user.text keeps owner; injection kinds drop.
    assert.equal(
      volume.lines.filter((line) => line.text === fixture.codexOwnerText)
        .length,
      1,
    );
    assert.equal(
      volume.lines.filter((line) => line.text === fixture.codexRunnerText)
        .length,
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
    assert.ok(
      volume.unprojectedRaw.includes(fixture.unparsableRaw),
      "unparsable source bytes must land verbatim without forged dialogue fields",
    );
    assert.equal(volume.lines.every((line) => !("line" in line)), true);
    const appended = volume.records.find((record) =>
      typeof record === "object" && record !== null &&
      "payload" in record &&
      (record as { payload?: { type?: string } }).payload?.type === "ticket-provenance-append"
    ) as { payload: { lines: Array<{ raw?: string; text?: string }> } };
    const rawIndex = appended.payload.lines.findIndex((entry) => entry.raw === fixture.unparsableRaw);
    assert.ok(rawIndex > 0 && rawIndex < appended.payload.lines.length - 1);
    assert.equal(typeof appended.payload.lines[rawIndex - 1]?.text, "string");
    assert.equal(typeof appended.payload.lines[rawIndex + 1]?.text, "string");

    // Codex payload.id landed via public entry (bound by id in turn-2 ranges).
    assert.equal(byId.get("msg-codex-owner")?.text, fixture.codexOwnerText);
    assert.equal(byId.get("msg-codex-runner")?.text, fixture.codexRunnerText);

    // On-disk: legacy snapshot prefix kept; new sitian append commit after it.
    const rawFile = await readFile(paths.recordFile, "utf8");
    const rawLines = rawFile.split("\n").filter((line) => line.trim() !== "");
    assert.equal(JSON.parse(rawLines[0]!).ticket, TICKET);
    assert.equal(typeof JSON.parse(rawLines[1]!).speaker, "string");
    assert.equal(JSON.parse(rawLines[1]!).kind, undefined);
    assert.equal(volume.appends[0]?.raw.trim() !== "", true);
    assert.ok(
      rawFile.includes(volume.appends[0]!.raw),
      "append commit bytes must be present on disk",
    );
    assert.ok(
      rawFile.startsWith(priorBytes),
      "prior snapshot bytes must be prefix-stable after append",
    );
  });
});

test("migrateBookTopology preserves legacy and prior bare under unbound when later bare wins", async () => {
  await withTempRoot("ak-book-topology-mig-", async (home) => {
    const ledgerHome = join(home, ".ak-roles");
    const bookKey = "demo-book";
    const books = join(ledgerHome, "books");
    const legacyDir = join(books, bookKey, "ticket-provenance");
    // Walk order per ticket: partial-nest then ticket root — two bares, second wins.
    const bareFirstDir = join(
      books,
      bookKey,
      String(TICKET),
      "ticket-provenance",
    );
    const bareSecondDir = join(books, bookKey, String(TICKET));
    await mkdir(legacyDir, { recursive: true });
    await mkdir(bareFirstDir, { recursive: true });
    await mkdir(bareSecondDir, { recursive: true });
    const legacyRaw = JSON.stringify({
      kind: "ticket-provenance",
      subject: String(TICKET),
      identity: "legacy-1",
      payload: { note: "old" },
    });
    // Two source rows share identity — second skips physical write but must still
    // claim dest so bare replace flips both outcomes (no phantom placed).
    const legacyRawDup = JSON.stringify({
      kind: "ticket-provenance",
      subject: String(TICKET),
      identity: "legacy-1",
      payload: { note: "old-dup-source" },
    });
    await writeFile(
      join(legacyDir, "records.jsonl"),
      `${legacyRaw}\n${legacyRawDup}\n`,
      "utf8",
    );
    const bareHeaderFirst = JSON.stringify({
      repo: bookKey,
      ticket: TICKET,
      createdAt: "t0",
      updatedAt: "t0",
      sessions: [],
    });
    const bareLineFirst = JSON.stringify({
      speaker: "owner",
      s: 0,
      text: "bare-first",
    });
    await writeFile(
      join(bareFirstDir, "records.jsonl"),
      `${bareHeaderFirst}\n${bareLineFirst}\n`,
      "utf8",
    );
    const bareHeaderSecond = JSON.stringify({
      repo: bookKey,
      ticket: TICKET,
      createdAt: "t1",
      updatedAt: "t1",
      sessions: [],
    });
    const bareLineSecond = JSON.stringify({
      speaker: "owner",
      s: 0,
      text: "bare-second-wins",
    });
    await writeFile(
      join(bareSecondDir, "records.jsonl"),
      `${bareHeaderSecond}\n${bareLineSecond}\n`,
      "utf8",
    );

    const report = await migrateBookTopology({
      ledgerHome,
      migrators: BOOK_TOPOLOGY_PARTITION_MIGRATORS,
      env: {},
      now: new Date("2026-09-14T00:00:00.000Z"),
    });

    const tp = report.partitions.find(
      (p) => p.partition === "ticket-provenance",
    );
    assert.ok(tp, "ticket-provenance partition report present");
    // 2 same-identity legacy + 2 bare volumes × 2 lines each = 6 source lines.
    assert.equal(tp.before, 6);
    assert.equal(tp.placed, 2, "only winning bare header+body stay placed");
    assert.equal(
      tp.unbound,
      4,
      "both legacy claims + first bare header+body rehomed (identity dup still counted)",
    );
    assert.equal(tp.discarded, 0);

    const destVolume = join(
      report.booksDirectory,
      bookKey,
      String(TICKET),
      "records.jsonl",
    );
    const migrated = await readFile(destVolume, "utf8");
    const migratedLines = migrated
      .split("\n")
      .filter((line) => line.trim() !== "");
    assert.equal(JSON.parse(migratedLines[0]!).ticket, TICKET);
    assert.equal(JSON.parse(migratedLines[0]!).updatedAt, "t1");
    assert.equal(JSON.parse(migratedLines[0]!).kind, undefined);
    assert.equal(JSON.parse(migratedLines[1]!).text, "bare-second-wins");
    assert.equal(
      migratedLines.some(
        (line) => line.includes("bare-first") || line.includes("legacy-1"),
      ),
      false,
      "superseded bare/legacy must not remain under winning header",
    );

    const unboundRoot = join(
      report.booksDirectory,
      bookKey,
      "unbound",
      "ticket-provenance",
    );
    async function collectRaw(
      dir: string,
      acc: string[] = [],
    ): Promise<string[]> {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return acc;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await collectRaw(path, acc);
        else if (entry.isFile()) acc.push(await readFile(path, "utf8"));
      }
      return acc;
    }
    const unboundBodies = (await collectRaw(unboundRoot)).join("\n");
    assert.equal(
      unboundBodies.includes(legacyRaw),
      true,
      "legacy bytes in unbound",
    );
    assert.equal(
      unboundBodies.includes("old-dup-source"),
      true,
      "duplicate-identity legacy source row also preserved in unbound",
    );
    assert.equal(
      unboundBodies.includes("bare-first"),
      true,
      "first bare body in unbound",
    );
    assert.equal(
      unboundBodies.includes('"updatedAt":"t0"'),
      true,
      "first bare header in unbound",
    );
  });
});

test("relocateBoardBoundUnboundRunsInBooks moves typed unbound runs under ticket and rewrites peers", async () => {
  // #863 stock batch: same migration-suite entry shape as migrateBookTopology —
  // InBooks is the real flag body; no parallel helper/unit tracer.
  await withTempRoot("ak-book-topology-board-bound-", async (home) => {
    const ledgerHome = join(home, ".ak-roles");
    const booksDirectory = join(ledgerHome, "books");
    const bookDir = join(booksDirectory, "demo-book");
    const boundLeaf = "01a086300-0000-7000-8000-00000000judge@judge";
    const freeLeaf = "01a086300-0000-7000-8000-00000000free@fixer";
    const peerLeaf = "01a086300-0000-7000-8000-0000000peer@coder";
    const boundSource = join(bookDir, "unbound", "runs", boundLeaf);
    const freeSource = join(bookDir, "unbound", "runs", freeLeaf);
    const peerSource = join(bookDir, "unbound", "runs", peerLeaf);

    async function seedRun(
      runDir: string,
      page: Record<string, unknown>,
    ): Promise<void> {
      await mkdir(join(runDir, "session"), { recursive: true });
      await writeFile(
        join(runDir, "admitted-request.json"),
        `${JSON.stringify(page, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        join(runDir, "invocation.json"),
        `${JSON.stringify({ runDirectory: runDir }, null, 2)}\n`,
        "utf8",
      );
    }

    await seedRun(boundSource, {
      runDirectory: boundSource,
      ticketNumber: 863,
    });
    await seedRun(freeSource, { runDirectory: freeSource });
    await seedRun(peerSource, {
      runDirectory: peerSource,
      sourceRun: { runDirectory: boundSource },
    });

    const relocated = await relocateBoardBoundUnboundRunsInBooks(booksDirectory);
    const boundTarget = join(bookDir, "863", "runs", boundLeaf);
    assert.deepEqual(relocated, [
      {
        from: boundSource,
        to: boundTarget,
        ticketNumber: 863,
      },
    ]);
    assert.equal(
      existsSync(boundSource),
      false,
      "stock relocate must remove the unbound leaf",
    );
    assert.equal(existsSync(boundTarget), true);
    assert.deepEqual(
      await findPlacedMigratingRun(
        booksDirectory,
        "demo-book",
        boundLeaf,
        `unbound/runs/${boundLeaf}`,
      ),
      { runDirectory: boundTarget, disposition: "placed" },
      "downstream migrators must reuse T9's board-ticket placement",
    );
    assert.equal(
      existsSync(freeSource),
      true,
      "true-unbound without board ticket stays under unbound",
    );
    assert.equal(existsSync(peerSource), true);

    const boundAdmitted = JSON.parse(
      await readFile(join(boundTarget, "admitted-request.json"), "utf8"),
    ) as { runDirectory?: string; ticketNumber?: number };
    assert.equal(boundAdmitted.ticketNumber, 863);
    assert.equal(boundAdmitted.runDirectory, boundTarget);

    const peerAdmitted = JSON.parse(
      await readFile(join(peerSource, "admitted-request.json"), "utf8"),
    ) as { sourceRun?: { runDirectory?: string } };
    assert.equal(
      peerAdmitted.sourceRun?.runDirectory,
      boundTarget,
      "batch cross-run rewrite must retarget peers before rename",
    );
  });
});


/**
 * #1090：起居录纯追加——同一区间再交新增记录；先前字节不改写；空 sessions 不追加；
 * 不可解析源行原字节留卷；新范围源不可读 reask 且不改卷。
 */
test("ak-role diarist partitions one multi-ticket submission by its submitted bounds and appends on replay", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const source = join(home, ".claude", "projects", "probe", "multi.jsonl");
    await mkdir(join(home, ".claude", "projects", "probe"), { recursive: true });
    await writeFile(source, [
      { type: "user", uuid: "owner-a", message: { role: "user", content: "first ticket" } },
      { type: "assistant", uuid: "runner-a", message: { role: "assistant", content: "first reply" } },
      { type: "assistant", uuid: "shared", message: { role: "assistant", content: "shared reply" } },
      { type: "user", uuid: "owner-b", message: { role: "user", content: "second ticket" } },
      { type: "assistant", uuid: "runner-b", message: { role: "assistant", content: "second reply" } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const secondTicket = 1837;
    const ticketSessions = [
      { ticketNumber: TICKET, sessions: [{ path: source, ranges: [{ from: { line: 1 }, to: { line: 3 } }] }] },
      { ticketNumber: secondTicket, sessions: [{ path: source, ranges: [{ from: { line: 3 }, to: { line: 5 } }] }] },
    ];
    async function run(runId: string, reaskSecondTicket = false) {
      const { io, stdout } = captureIo();
      const result = await runAkRole(
        ["diarist", "--model", "test/caller-seat:high", "--project", project, `整理 #${TICKET} 和 #${secondTicket} 起居录`],
        {
          home, packageRoot, cwd: project, io, createRunId: () => runId,
          principalAuthority: immutablePrincipalAuthority,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot, principalAuthority: immutablePrincipalAuthority,
            piRunner: diaristEnvelopeRunner((round: number, lastReask?: string) => {
              if (reaskSecondTicket && round === 1) {
                return {
                  status: "completed", ticketNumber: TICKET,
                  ticketSessions: [ticketSessions[0], {
                    ticketNumber: secondTicket,
                    sessions: [{ path: join(home, ".claude", "projects", "probe", "missing.jsonl"), ranges: [{ from: { line: 1 }, to: { line: 1 } }] }],
                  }],
                };
              }
              if (reaskSecondTicket) {
                assert.ok(lastReask);
                assert.equal(existsSync(resolveTicketProvenanceVolume(TICKET, project, home).recordFile), false);
              }
              return { status: "completed", ticketNumber: TICKET, ticketSessions };
            }),
          }),
        },
      );
      assert.equal(result.exitCode, 0, stdout.join("") || "multi-ticket diarist failed");
      assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    }
    await run("01a0diar00-0000-7000-8000-000000000111", true);
    const first = await readTicketProvenance(TICKET, project, home);
    const second = await readTicketProvenance(secondTicket, project, home);
    assert.deepEqual(first.lines.map((line) => line.id), ["owner-a", "runner-a", "shared"]);
    assert.deepEqual(second.lines.map((line) => line.id), ["shared", "owner-b", "runner-b"]);
    const firstBytes = await readFile(first.recordFile, "utf8");
    const secondBytes = await readFile(second.recordFile, "utf8");
    await run("01a0diar00-0000-7000-8000-000000000112");
    const repeatedFirst = await readTicketProvenance(TICKET, project, home);
    const repeatedSecond = await readTicketProvenance(secondTicket, project, home);
    assert.deepEqual(repeatedFirst.lines.map((line) => line.id), ["owner-a", "runner-a", "shared", "owner-a", "runner-a", "shared"]);
    assert.deepEqual(repeatedSecond.lines.map((line) => line.id), ["shared", "owner-b", "runner-b", "shared", "owner-b", "runner-b"]);
    assert.ok((await readFile(first.recordFile, "utf8")).startsWith(firstBytes));
    assert.ok((await readFile(second.recordFile, "utf8")).startsWith(secondBytes));
  });
});

test("ak-role diarist append-only resubmit leaves a new record", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const fixture = await writeDialogueSessionFixture(
      join(home, ".claude", "projects", "probe", "session-a.jsonl"),
    );
    const paths = resolveTicketProvenanceVolume(TICKET, project, home);
    const range = {
      path: fixture.path,
      ranges: [{ from: { line: 1 }, to: { line: fixture.lastLine } }],
    };

    async function runDiarist(runId: string, sessions: unknown) {
      const { io, stdout } = captureIo();
      const result = await runAkRole(
        [
          "diarist",
          "--model",
          "test/caller-seat:high",
          "--project",
          project,
          `整理 #${TICKET} 起居录`,
        ],
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
            piRunner: diaristEnvelopeRunner({
              status: "completed",
              ticketNumber: TICKET,
              sessions,
            }),
          }),
        },
      );
      assert.equal(
        result.exitCode,
        0,
        stdout.join("") || `diarist ${runId} failed`,
      );
      assert.equal(result.terminal?.roleOutcome.kind, "accepted");
      return readTicketProvenance(TICKET, project, home);
    }

    const first = await runDiarist("01a0diar00-0000-7000-8000-000000000091", [
      range,
    ]);
    assert.equal(first.appends.length, 1);
    assert.equal(
      first.lines.some((line) => line.id === fixture.plainOwnerId),
      true,
    );
    assert.equal(
      first.lines.some((line) => line.id === fixture.runnerId),
      true,
    );
    assert.ok(
      first.unprojectedRaw.includes(fixture.unparsableRaw),
      "unparsable source bytes must land verbatim",
    );
    const afterFirstBytes = await readFile(paths.recordFile, "utf8");
    const firstAppendRaw = first.appends[0]!.raw;
    assert.ok(afterFirstBytes.includes(firstAppendRaw));

    const second = await runDiarist("01a0diar00-0000-7000-8000-000000000092", [
      range,
    ]);
    assert.equal(second.appends.length, 2, "same range must append again");
    assert.notEqual(second.appends[0]?.identity, second.appends[1]?.identity);
    assert.equal(
      second.appends[0]?.raw,
      firstAppendRaw,
      "prior append bytes must be unchanged",
    );
    const afterSecondBytes = await readFile(paths.recordFile, "utf8");
    assert.ok(
      afterSecondBytes.startsWith(afterFirstBytes),
      "prior volume bytes must be prefix-stable",
    );
    assert.equal(
      second.lines.filter((line) => line.id === fixture.plainOwnerId).length,
      2,
      "dialogue lines accumulate across appends",
    );

    const beforeEmpty = afterSecondBytes;
    const afterEmpty = await runDiarist(
      "01a0diar00-0000-7000-8000-000000000093",
      [],
    );
    assert.equal(await readFile(paths.recordFile, "utf8"), beforeEmpty);
    assert.equal(afterEmpty.appends.length, 2);

    const priorBytes = beforeEmpty;
    const missingPath = join(
      home,
      ".claude",
      "projects",
      "probe",
      "missing-session.jsonl",
    );
    let sawUnreadableReask = false;
    const { io, stdout } = captureIo();
    const failed = await runAkRole(
      [
        "diarist",
        "--model",
        "test/caller-seat:high",
        "--project",
        project,
        `整理 #${TICKET} 起居录`,
      ],
      {
        home,
        packageRoot,
        cwd: project,
        io,
        createRunId: () => "01a0diar00-0000-7000-8000-000000000094",
        principalAuthority: immutablePrincipalAuthority,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: immutablePrincipalAuthority,
          piRunner: diaristEnvelopeRunner(
            (round: number, lastReask?: string) => {
              if (round === 1) {
                return {
                  status: "completed",
                  ticketNumber: TICKET,
                  sessions: [
                    {
                      path: missingPath,
                      ranges: [{ from: { line: 1 }, to: { line: 1 } }],
                    },
                  ],
                };
              }
              assert.ok(lastReask, "expected unreadable-session reask");
              sawUnreadableReask = true;
              assert.equal(
                readFileSync(paths.recordFile, "utf8"),
                priorBytes,
                "unreadable source must not publish over the prior diary",
              );
              return {
                status: "completed",
                ticketNumber: TICKET,
                sessions: [],
              };
            },
          ),
        }),
      },
    );
    assert.equal(failed.exitCode, 0, stdout.join("") || "recovery run failed");
    assert.equal(sawUnreadableReask, true);
    assert.equal(readFileSync(paths.recordFile, "utf8"), priorBytes);
    const still = await readTicketProvenance(TICKET, project, home);
    assert.equal(still.appends.length, 2);
    assert.equal(
      still.lines.filter((line) => line.id === fixture.plainOwnerId).length,
      2,
    );
  });
});



test("ak-role diarist selects user and enqueue boundaries inside their declared ranges", async () => {
  const ownerText = "那就不要行号了嘛。反正全文拿去搜索匹配也很快？";
  for (const source of ["user", "enqueue"] as const) {
    await withTempHome(async (home) => {
      const project = join(home, "project");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const sessionPath = join(home, ".claude", "projects", `probe-${source}`, "session.jsonl");
      await mkdir(join(sessionPath, ".."), { recursive: true });
      const id = `owner-${source}`;
      const target = source === "user"
        ? { type: "user", uuid: id, message: { role: "user", content: ownerText }, origin: { kind: "human" } }
        : { type: "queue-operation", operation: "enqueue", id, content: ownerText };
      const rows = source === "user"
        ? [
            { type: "queue-operation", operation: "enqueue", id: "outside", content: ownerText },
            { type: "queue-operation", operation: "dequeue" },
            target,
          ]
        : [target];
      await writeFile(
        sessionPath,
        rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
        "utf8",
      );

      const { io, stdout } = captureIo();
      const result = await runAkRole(
        ["diarist", "--model", "test/caller-seat:high", "--project", project, `整理 #${TICKET} 起居录`],
        {
          home,
          packageRoot,
          cwd: project,
          io,
          createRunId: () => `01a0diar00-0000-7000-8000-0000000000${source === "user" ? "a1" : "a2"}`,
          principalAuthority: immutablePrincipalAuthority,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot,
            principalAuthority: immutablePrincipalAuthority,
            piRunner: diaristEnvelopeRunner({
              status: "completed",
              ticketNumber: TICKET,
              sessions: [{
                path: sessionPath,
                ranges: [{
                  from: { line: source === "user" ? 3 : 1 },
                  to: { line: source === "user" ? 3 : 1 },
                }],
              }],
            }),
          }),
        },
      );
      assert.equal(result.exitCode, 0, stdout.join(""));

      const volume = await readTicketProvenance(TICKET, project, home);
      assert.deepEqual(
        volume.lines.map(({ speaker, text, id: lineId, s }) => ({ speaker, text, id: lineId, s })),
        [{ speaker: "owner", text: ownerText, id, s: 0 }],
        `${source} selection must happen inside the declared range, not over the whole session`,
      );
    });
  }
});

test("ak-role diarist true-unbound records its dialogue under unbound", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sessionPath = join(home, ".claude", "projects", "unbound", "session.jsonl");
    await mkdir(join(sessionPath, ".."), { recursive: true });
    await writeFile(sessionPath, `${JSON.stringify({ type: "user", uuid: "unbound-owner", message: { role: "user", content: "先拟票" }, origin: { kind: "human" } })}\n`, "utf8");

    const runId = "01a0diar00-0000-7000-8000-000000000002";
    const { io, stdout } = captureIo();
    const result = await runAkRole(
      [
        "diarist",
        "--model",
        "test/caller-seat:high",
        "--project",
        project,
        "整理这份方案的依据",
      ],
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
            sessions: [{ path: sessionPath, ranges: [{ from: { line: 1 }, to: { line: 1 } }] }],
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
    const bookKey = resolveBookKeyFromGit(project);
    const unboundRecord = join(home, ".ak-roles", "books", bookKey, "unbound", "runs", `${runId}@diarist`, "records.jsonl");
    const rows = (await readFile(unboundRecord, "utf8")).trim().split("\n").map((row) => JSON.parse(row));
    assert.equal(rows[0]?.kind, "ticket-provenance");
    assert.equal(rows[0]?.sessionParent, undefined);
    assert.equal(rows[0]?.payload?.lines?.[0]?.speaker, "owner");

    // Ticket dir stays unminted until a typed ticket bind.
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

test("pre-bound diarist preserves its receipt without code-side reassignment", async () => {
  for (const assertedTicket of [null, TICKET + 1]) {
    await withTempHome(async (home) => {
      const project = join(home, "project");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const sessionPath = join(home, ".claude", "projects", "bound-assertion", "session.jsonl");
      await mkdir(join(sessionPath, ".."), { recursive: true });
      await writeFile(sessionPath, `${JSON.stringify({ type: "user", uuid: "bound-assertion-owner", message: { role: "user", content: "续录" }, origin: { kind: "human" } })}\n`, "utf8");
      const result = await runAkRole(["diarist", "--model", "test/caller-seat:high", "--project", project, "续录"], {
        home, packageRoot, cwd: project, io: captureIo().io,
        boundTicketNumber: TICKET,
        createRunId: () => "01a0diar00-0000-7000-8000-0000000000b1",
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: diaristEnvelopeRunner({ status: "completed", ticketNumber: assertedTicket,
            sessions: [{ path: sessionPath, ranges: [{ from: { line: 1 }, to: { line: 1 } }] }],
          }),
        }),
      });
      assert.equal(result.exitCode, 0);
      assert.equal(existsSync(resolveTicketProvenanceVolume(TICKET, project, home).recordFile), false);
      const runDir = join(home, ".ak-roles", "books", resolveBookKeyFromGit(project), String(TICKET), "runs", "01a0diar00-0000-7000-8000-0000000000b1@diarist");
      const submissions = await readRecordedSubmissionRows(project, "01a0diar00-0000-7000-8000-0000000000b1", home);
      assert.equal((submissions.at(-1)?.accepted as { ticketNumber?: unknown })?.ticketNumber, assertedTicket);
      const admitted = JSON.parse(await readFile(join(runDir, "admitted-request.json"), "utf8"));
      assert.equal(admitted.ticketNumber, TICKET);
    });
  }
});

/**
 * Host turn already started + board ticket already written by the accept hook,
 * then the turn fails: the run relocates under the ticket before auto-resume,
 * whose next host request must use that current durable location.
 */
test("ak-role diarist auto-resume uses the relocated board-bound run", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    // Temp-home config only — never the real seat table. One retry crosses the
    // post-turn relocate seam in the same public invocation.
    await mkdir(join(home, ".ak-roles"), { recursive: true });
    await writeFile(
      join(home, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ autoResumeLimit: 1 }, null, 2)}\n`,
    );

    const runId = "01a0diar00-0000-7000-8000-000000000003";
    const { io } = captureIo();
    const submitted = {
      status: "completed",
      ticketNumber: TICKET,
      sessions: [],
    };
    const failAfterBind = diaristEnvelopeRunner(submitted, {
      afterAdmit: "throw",
    });
    const completeAfterResume = diaristEnvelopeRunner(submitted);
    let hostTurns = 0;
    const hostRunDirectories: string[] = [];
    const roleTurnHost = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: immutablePrincipalAuthority,
      piRunner: async (args, options) => {
        hostTurns += 1;
        return hostTurns === 1
          ? failAfterBind(args, options)
          : completeAfterResume(args, options);
      },
    });

    const result = await runAkRole(
      [
        "diarist",
        "--model",
        "test/caller-seat:high",
        "--project",
        project,
        `整理 #${TICKET} 起居录`,
      ],
      {
        home,
        packageRoot,
        cwd: project,
        io,
        createRunId: () => runId,
        principalAuthority: immutablePrincipalAuthority,
        roleTurnHost: {
          executeTurn: async (request) => {
            hostRunDirectories.push(request.runDirectory);
            return roleTurnHost.executeTurn(request);
          },
        },
      },
    );

    const bookKey = resolveBookKeyFromGit(project);
    const ticketPlacement = roleRunPlacement(
      resolveActivationLedgerHome(home),
      {
        bookKey,
        subject: { ticketNumber: TICKET },
        runId,
        role: "diarist",
      },
    );
    const unboundPlacement = roleRunPlacement(
      resolveActivationLedgerHome(home),
      {
        bookKey,
        subject: { unbound: true },
        runId,
        role: "diarist",
      },
    );
    assert.deepEqual(hostRunDirectories, [
      unboundPlacement.runDirectory,
      ticketPlacement.runDirectory,
    ]);
    assert.equal(result.exitCode, 0, "auto-resume should recover the host turn");
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
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

    // Fixture fidelity: same ticket-run session keeps first failure history and
    // appends the accepted resume. Assert structured ak_run_attempt_history only.
    const relocatedSessionFile = join(
      ticketPlacement.runDirectory,
      "session",
      "session.jsonl",
    );
    const attemptHistory = (await readFile(relocatedSessionFile, "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as {
        type?: string;
        customType?: string;
        data?: {
          sequence?: number;
          role?: string;
          runId?: string;
          outcome?: { kind?: string; diagnostic?: string };
        };
      })
      .filter(
        (row) =>
          row.type === "custom" &&
          row.customType === ATTEMPT_HISTORY_ENTRY_TYPE,
      );
    assert.equal(attemptHistory.length, 2);
    assert.equal(attemptHistory[0]?.data?.sequence, 1);
    assert.equal(attemptHistory[0]?.data?.outcome?.kind, "failure");
    // Diagnostic is free text: assert non-empty presence only (ticket AC4 / quality-law).
    assert.equal(typeof attemptHistory[0]?.data?.outcome?.diagnostic, "string");
    assert.ok(
      (attemptHistory[0]?.data?.outcome?.diagnostic as string).length > 0,
    );
    assert.equal(attemptHistory[0]?.data?.role, "diarist");
    assert.equal(attemptHistory[0]?.data?.runId, runId);
    assert.equal(attemptHistory[1]?.data?.sequence, 2);
    assert.equal(attemptHistory[1]?.data?.outcome?.kind, "accepted");
    assert.equal(attemptHistory[1]?.data?.role, "diarist");
    assert.equal(attemptHistory[1]?.data?.runId, runId);
    assert.match(ticketPlacement.runDirectory, new RegExp(`/${TICKET}/runs/`));
  });
});

test("ak-role resume points at an after-dispatch diarist relocation", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    await mkdir(join(home, ".ak-roles"), { recursive: true });
    await writeFile(join(home, ".ak-roles", "public-cli.json"), '{"autoResumeLimit":0}\n');

    const runId = "01a0diar00-0000-7000-8000-000000000005";
    const bookKey = resolveBookKeyFromGit(project);
    const unboundPlacement = roleRunPlacement(resolveActivationLedgerHome(home), {
      bookKey,
      subject: { unbound: true },
      runId,
      role: "diarist",
    });
    const ticketPlacement = roleRunPlacement(resolveActivationLedgerHome(home), {
      bookKey,
      subject: { ticketNumber: TICKET },
      runId,
      role: "diarist",
    });
    const { io, stderr } = captureIo();
    const baseOptions = {
      home,
      packageRoot,
      cwd: project,
      io,
      principalAuthority: immutablePrincipalAuthority,
    };

    const interrupted = await runAkRole(
      ["diarist", "--model", "test/caller-seat:high", "--project", project, "resume fixture"],
      {
        ...baseOptions,
        createRunId: () => runId,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: immutablePrincipalAuthority,
          piRunner: async (args) => {
            const sessionDirectory = args[args.indexOf("--session-dir") + 1]!;
            await mkdir(sessionDirectory, { recursive: true });
            await writeFile(join(sessionDirectory, "session.jsonl"), "\n", "utf8");
            await observeTyped429ViaProductionHandler({
              runDirectory: join(sessionDirectory, ".."),
              provider: "xai",
            });
            return { code: 1, stderr: "", timedOut: false, args: [...args] };
          },
        }),
      },
    );
    assert.equal(interrupted.exitCode, 1);
    assert.ok(interrupted.terminal?.resume, JSON.stringify(interrupted.terminal));
    stderr.length = 0;

    const reaskThen429 = diaristEnvelopeRunner(
      { status: "completed", ticketNumber: TICKET, sessions: [{ path: "x" }] },
      {
        afterReask: async () => {
          await observeTyped429ViaProductionHandler({
            runDirectory: unboundPlacement.runDirectory,
            provider: "xai",
          });
          await writeFile(
            join(unboundPlacement.runDirectory, "session", "session.jsonl"),
            `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "retry" }] } })}\n${JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "upstream declined", provider: "xai", model: "probe", api: "openai-responses" } })}\n`,
            "utf8",
          );
          return true;
        },
      },
    );
    const resumed = await runAkRole(
      ["resume", "--model", "test/caller-seat:high", runId],
      {
        ...baseOptions,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: immutablePrincipalAuthority,
          piRunner: reaskThen429,
        }),
      },
    );
    assert.equal(resumed.exitCode, 1);
    assert.equal(existsSync(unboundPlacement.runDirectory), false);
    const errorPath = join(ticketPlacement.runDirectory, "artifacts", "error.json");
    assert.ok(stderr.join("").includes(errorPath));
    const error = JSON.parse(await readFile(errorPath, "utf8")) as {
      kind?: unknown;
      runId?: unknown;
      diagnostic?: unknown;
    };
    assert.equal(error.kind, "error");
    assert.equal(error.runId, runId);
    assert.equal(typeof error.diagnostic, "string");
  });
});
