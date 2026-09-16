/**
 * #708 / #779 / #901 public 起居郎 seat — `ak-role diarist` is a role like the other seats.
 * LLM submits bounds; mechanical layer reprojects records.jsonl.
 * Single seam: real entry, scripted host, on-disk session fixture, assert the unique diary file.
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
import { roleRunPlacement } from "../../src/role-run-placement.ts";
import { migrateBookTopology } from "../../src/book-topology-migration.ts";
import { BOOK_TOPOLOGY_PARTITION_MIGRATORS } from "../../src/book-topology-partition-migrators.ts";
import {
  readTicketProvenance,
  reprojectTicketProvenance,
  resolveTicketProvenanceVolume,
} from "../../src/ticket-provenance.ts";
import { createDiaristRoleRuntime } from "../../src/role-runtime.ts";
import { ParentQueueReaskError } from "../../src/submission-errors.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
  type LegacyFauxPiRunner,
} from "../helpers/role-turn-host-fixture.ts";
import {
  captureIo,
  seedGitProject,
} from "../helpers/failure-settlement-kit.ts";
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
  behavior?: { readonly afterAdmit?: "throw" },
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
    // 21. duplicate id second occurrence — must not re-enter
    JSON.stringify({
      type: "assistant",
      uuid: duplicateId,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "副本正文（应被首现吞掉）" }],
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

test("ak-role diarist projects dialogue bounds and preserves unparsable source bytes", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    // Path under authorized host session root (ADR 0038 real I/O seam).
    const fixture = await writeDialogueSessionFixture(
      join(home, ".claude", "projects", "probe", "session.jsonl"),
    );

    // Seed an already-accepted archive line. Sessions stay empty so the fixture
    // full-range is still undeclared delta (#918 carry-forward: only new ranges read source).
    // The successful projection adds the fixture bounds to the cumulative header.
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
                assert.match(lastReask, /边界无法使用|session unreadable/);
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

    assert.ok(volume.header, "diary header must be present");
    assert.equal(volume.header.ticket, TICKET);
    assert.equal(volume.header.sessions.length, 1);
    assert.equal(volume.header.sessions[0]?.path, fixture.path);

    // Speakers + first-seen identity + no tool output + raw-byte preservation.
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
    assert.equal(byId.get(fixture.duplicateId)?.text, "首现正文");
    // Duplicate second occurrence must not produce a second line with that id.
    assert.equal(
      volume.lines.filter((line) => line.id === fixture.duplicateId).length,
      1,
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

    // Codex payload.id landed via public entry (bound by id in turn-2 ranges).
    assert.equal(byId.get("msg-codex-owner")?.text, fixture.codexOwnerText);
    assert.equal(byId.get("msg-codex-runner")?.text, fixture.codexRunnerText);

    // On-disk shape: first line header, bare dialogue rows after (no SitianRecord shell).
    const rawFile = await readFile(paths.recordFile, "utf8");
    const rawLines = rawFile.split("\n").filter((line) => line.trim() !== "");
    assert.equal(JSON.parse(rawLines[0]!).ticket, TICKET);
    assert.equal(typeof JSON.parse(rawLines[1]!).speaker, "string");
    assert.equal(JSON.parse(rawLines[1]!).kind, undefined);
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

test("ticket provenance normalizes historical and incoming session index domains", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceDir = join(home, ".claude", "projects", "index-domains");
    await mkdir(sourceDir, { recursive: true });
    const historical = join(sourceDir, "historical.jsonl");
    const incoming = join(sourceDir, "incoming.jsonl");
    await writeFile(historical, "{}\n", "utf8");
    await writeFile(incoming, "not-json\n", "utf8");

    const paths = resolveTicketProvenanceVolume(TICKET, project, home);
    await mkdir(paths.volumeDir, { recursive: true });
    await writeFile(
      paths.recordFile,
      [
        JSON.stringify({
          repo: resolveBookKeyFromGit(project),
          ticket: TICKET,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          sessions: [
            { path: historical, ranges: [{ from: { line: 1 }, to: { line: 1 } }] },
            { path: `${historical}/./`, ranges: [{ from: { line: 2 }, to: { line: 2 } }] },
          ],
        }),
        JSON.stringify({ speaker: "owner", s: 0, text: "first" }),
        JSON.stringify({ speaker: "runner", s: 1, text: "second" }),
      ].join("\n") + "\n",
      "utf8",
    );

    const result = await reprojectTicketProvenance({
      ticketNumber: TICKET,
      cwd: project,
      home,
      sessions: [
        { path: incoming, ranges: [{ from: { line: 1 }, to: { line: 1 } }] },
      ],
    });

    const folded = await readTicketProvenance(TICKET, project, home);
    assert.deepEqual(folded.unprojectedRaw, ["not-json"]);
    assert.equal(result.header.sessions.length, 2);
    assert.deepEqual(result.lines.map((line) => [line.s, line.text]), [
      [0, "first"],
      [0, "second"],
    ]);
  });
});

/**
 * #918 甲案：ranges 累计单调——本轮 sessions 与 prior 取并集；遗漏不删除。
 * 真实 ak-role diarist 入口；变异「仅本轮整卷覆写」时本案报红。
 * 跨 session：第二轮换不同 path，header 序与 lines[].s 同时证明 s=0/s=1。
 */
test("ak-role diarist cumulative ranges keep history and ignore omissions", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const fixtureA = await writeDialogueSessionFixture(
      join(home, ".claude", "projects", "probe", "session-a.jsonl"),
    );
    // Second session path with distinct native ids (seenIds is cross-session).
    // Written inline in this tracer — not a parallel fixture helper.
    const sessionBPath = join(
      home,
      ".claude",
      "projects",
      "probe",
      "session-b.jsonl",
    );
    const sessionBOwnerId = "msg-session-b-owner";
    const sessionBOwnerText = "第二会话的陛下发言";
    await mkdir(join(sessionBPath, ".."), { recursive: true });
    await writeFile(
      sessionBPath,
      `${JSON.stringify({
        type: "user",
        uuid: sessionBOwnerId,
        message: {
          role: "user",
          content: [{ type: "text", text: sessionBOwnerText }],
        },
      })}\n`,
      "utf8",
    );
    const paths = resolveTicketProvenanceVolume(TICKET, project, home);

    const rangeA = {
      path: fixtureA.path,
      ranges: [
        {
          from: { id: fixtureA.plainOwnerId },
          to: { id: fixtureA.plainOwnerId },
        },
      ],
    };
    // Same-path additive range (验收：同卷新增).
    const rangeA2 = {
      path: fixtureA.path,
      ranges: [
        {
          from: { id: fixtureA.ownerId },
          to: { id: fixtureA.ownerId },
        },
      ],
    };
    // Different path (验收：新 session 索引 s=1).
    const rangeB = {
      path: sessionBPath,
      ranges: [{ from: { line: 1 }, to: { line: 1 } }],
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

    // Round 1: record the later range on session-a first.
    const afterA2 = await runDiarist("01a0diar00-0000-7000-8000-000000000091", [
      rangeA2,
    ]);
    assert.equal(afterA2.lines.length, 1);
    assert.equal(afterA2.lines[0]?.id, fixtureA.ownerId);
    assert.equal(afterA2.lines[0]?.text, "立文件。送司天台记录。");
    assert.equal(afterA2.lines[0]?.s, 0);
    assert.equal(afterA2.header?.sessions.length, 1);
    assert.equal(afterA2.header?.sessions[0]?.path, fixtureA.path);
    assert.deepEqual(afterA2.header?.sessions[0]?.ranges, rangeA2.ranges);

    // Round 2: submit only a different session path — A remains; s=0/s=1 both coherent.
    const afterB = await runDiarist("01a0diar00-0000-7000-8000-000000000092", [
      rangeB,
    ]);
    const byIdB = new Map(
      afterB.lines
        .filter((line) => line.id !== undefined)
        .map((line) => [line.id!, line]),
    );
    assert.equal(
      byIdB.get(fixtureA.ownerId)?.text,
      "立文件。送司天台记录。",
      "later range identity/text kept",
    );
    assert.equal(
      byIdB.get(fixtureA.ownerId)?.s,
      0,
      "prior session keeps s=0",
    );
    assert.equal(
      byIdB.get(sessionBOwnerId)?.text,
      sessionBOwnerText,
      "B session line added",
    );
    assert.equal(byIdB.get(sessionBOwnerId)?.s, 1, "new session gets s=1");
    assert.equal(afterB.lines.length, 2);
    // Header: prior path first, new path second.
    assert.equal(afterB.header?.sessions.length, 2);
    assert.equal(afterB.header?.sessions[0]?.path, fixtureA.path);
    assert.deepEqual(afterB.header?.sessions[0]?.ranges, rangeA2.ranges);
    assert.equal(afterB.header?.sessions[1]?.path, sessionBPath);
    assert.deepEqual(afterB.header?.sessions[1]?.ranges, rangeB.ranges);

    // Round 3: the live source acquired a new leading event. Persisted ordinals must
    // be refreshed from replay-stable identities before adding the earlier range.
    const originalA = await readFile(fixtureA.path, "utf8");
    await writeFile(
      fixtureA.path,
      `${JSON.stringify({
        type: "assistant",
        uuid: "msg-leading-insert",
        message: { role: "assistant", content: "later replay inserted this first" },
      })}\n${originalA}`,
      "utf8",
    );
    const afterA = await runDiarist("01a0diar00-0000-7000-8000-000000000093", [
      rangeA,
    ]);
    await writeFile(fixtureA.path, originalA, "utf8");
    const byIdA2 = new Map(
      afterA.lines
        .filter((line) => line.id !== undefined)
        .map((line) => [line.id!, line]),
    );
    assert.equal(
      byIdA2.get(fixtureA.plainOwnerId)?.text,
      fixtureA.plainOwnerText,
    );
    assert.equal(byIdA2.get(fixtureA.plainOwnerId)?.s, 0);
    assert.equal(
      byIdA2.get(fixtureA.ownerId)?.text,
      "立文件。送司天台记录。",
      "same-path B added",
    );
    assert.equal(byIdA2.get(fixtureA.ownerId)?.s, 0);
    assert.equal(byIdA2.get(sessionBOwnerId)?.text, sessionBOwnerText);
    assert.equal(byIdA2.get(sessionBOwnerId)?.s, 1);
    assert.deepEqual(
      afterA.lines.map((line) => line.id),
      [fixtureA.plainOwnerId, fixtureA.ownerId, sessionBOwnerId],
      "cumulative projection refreshes replay-shifted positions before source ordering",
    );
    assert.equal(afterA.lines.length, 3);
    assert.equal(afterA.header?.sessions.length, 2);
    assert.equal(afterA.header?.sessions[0]?.ranges.length, 2);
    assert.deepEqual(afterA.header?.sessions[0]?.ranges[0], rangeA2.ranges[0]);
    assert.deepEqual(afterA.header?.sessions[0]?.ranges[1], rangeA.ranges[0]);

    // Round 4: equivalent path spelling (p/./) + symlink alias must merge via the same
    // physicalPathIdentity as I/O seam; keep first-seen header path; no extra s.
    const rangeAEquiv = {
      path: `${fixtureA.path}/./`,
      ranges: rangeA.ranges,
    };
    const afterEquiv = await runDiarist(
      "01a0diar00-0000-7000-8000-000000000094",
      [rangeAEquiv],
    );
    assert.equal(
      afterEquiv.header?.sessions.length,
      2,
      "equiv path must not mint s=2",
    );
    assert.equal(
      afterEquiv.header?.sessions[0]?.path,
      fixtureA.path,
      "first-seen path spelling retained",
    );
    assert.equal(afterEquiv.header?.sessions[0]?.ranges.length, 2);
    assert.equal(afterEquiv.lines.length, 3);
    assert.equal(
      afterEquiv.lines.filter((line) => line.id === fixtureA.plainOwnerId)
        .length,
      1,
      "no-id-safe: plain owner not duplicated via equiv path",
    );
    assert.equal(
      afterEquiv.lines.filter(
        (line) => line.s === 0 && line.id === fixtureA.plainOwnerId,
      ).length,
      1,
    );
    assert.equal(
      afterEquiv.lines.find((line) => line.id === sessionBOwnerId)?.s,
      1,
    );

    // Symlink alias of the same physical volume must not mint a new s (canonical identity).
    const aliasDir = join(home, ".claude", "projects", "probe-alias");
    await mkdir(join(home, ".claude", "projects"), { recursive: true });
    await symlink(join(home, ".claude", "projects", "probe"), aliasDir);
    const rangeASymlink = {
      path: join(aliasDir, "session-a.jsonl"),
      ranges: rangeA.ranges,
    };
    const afterSymlink = await runDiarist(
      "01a0diar00-0000-7000-8000-000000000094b",
      [rangeASymlink],
    );
    assert.equal(
      afterSymlink.header?.sessions.length,
      2,
      "symlink alias must not mint a third session index",
    );
    assert.equal(
      afterSymlink.header?.sessions[0]?.path,
      fixtureA.path,
      "first-seen path retained under symlink alias",
    );
    assert.equal(
      afterSymlink.lines.filter((line) => line.id === fixtureA.plainOwnerId)
        .length,
      1,
      "symlink alias must not double-project id-bearing owner lines",
    );
    assert.equal(afterSymlink.lines.length, 3);

    // Round 5: resubmit rangeB only — idempotent (验收 2).
    const afterIdem = await runDiarist(
      "01a0diar00-0000-7000-8000-000000000095",
      [rangeB],
    );
    assert.equal(afterIdem.lines.length, 3);
    assert.equal(
      afterIdem.lines.filter((line) => line.id === fixtureA.plainOwnerId)
        .length,
      1,
    );
    assert.equal(
      afterIdem.lines.filter((line) => line.id === fixtureA.ownerId).length,
      1,
    );
    assert.equal(
      afterIdem.lines.filter((line) => line.id === sessionBOwnerId).length,
      1,
    );
    assert.equal(afterIdem.header?.sessions.length, 2);
    assert.equal(afterIdem.header?.sessions[0]?.ranges.length, 2);

    // Round 6: submit only rangeA — later ranges must remain (验收 3b 遗漏不删除).
    const afterOmit = await runDiarist(
      "01a0diar00-0000-7000-8000-000000000096",
      [rangeA],
    );
    const byIdOmit = new Map(
      afterOmit.lines
        .filter((line) => line.id !== undefined)
        .map((line) => [line.id!, line]),
    );
    assert.equal(
      byIdOmit.get(fixtureA.plainOwnerId)?.text,
      fixtureA.plainOwnerText,
    );
    assert.equal(
      byIdOmit.get(fixtureA.ownerId)?.text,
      "立文件。送司天台记录。",
      "omitted same-path range stays",
    );
    assert.equal(
      byIdOmit.get(sessionBOwnerId)?.text,
      sessionBOwnerText,
      "omitted session stays",
    );
    assert.equal(byIdOmit.get(sessionBOwnerId)?.s, 1);
    assert.equal(afterOmit.lines.length, 3);
    assert.equal(afterOmit.header?.sessions.length, 2);
    assert.equal(afterOmit.header?.sessions[0]?.ranges.length, 2);

    // Round 7: pure empty sessions still no-op (验收 3).
    const beforeEmpty = await readFile(paths.recordFile, "utf8");
    const afterEmpty = await runDiarist(
      "01a0diar00-0000-7000-8000-000000000097",
      [],
    );
    assert.equal(await readFile(paths.recordFile, "utf8"), beforeEmpty);
    assert.equal(afterEmpty.lines.length, 3);

    // Overlapping extensions read only their physical delta: id-less dialogue and
    // unreadable source bytes already covered by an earlier range stay unique.
    const idlessBText = "第二会话无原生 id 的陛下发言";
    const rawB = "{second session unreadable";
    const sessionBSecondId = "msg-session-b-second";
    await writeFile(
      sessionBPath,
      [
        JSON.stringify({
          type: "user",
          uuid: sessionBOwnerId,
          message: { role: "user", content: [{ type: "text", text: sessionBOwnerText }] },
        }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "text", text: idlessBText }] },
        }),
        rawB,
        JSON.stringify({
          type: "user",
          uuid: sessionBSecondId,
          message: { role: "user", content: [{ type: "text", text: "第二会话扩展发言" }] },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    await runDiarist("01a0diar00-0000-7000-8000-000000000097a", [{
      path: sessionBPath,
      ranges: [{ from: { line: 1 }, to: { line: 3 } }],
    }]);
    const afterOverlap = await runDiarist(
      "01a0diar00-0000-7000-8000-000000000097b",
      [{ path: sessionBPath, ranges: [{ from: { line: 1 }, to: { line: 4 } }] }],
    );
    assert.equal(afterOverlap.lines.filter((line) => line.text === idlessBText).length, 1);
    assert.equal(afterOverlap.unprojectedRaw.filter((raw) => raw === rawB).length, 1);
    assert.equal(afterOverlap.lines.filter((line) => line.id === sessionBSecondId).length, 1);

    // Id-less entries obey the same reverse-submission source ordering.
    const idlessOrderPath = join(home, ".claude", "projects", "probe", "idless-order.jsonl");
    const earlyIdless = "无 id 前段";
    const lateIdless = "无 id 后段";
    await writeFile(idlessOrderPath, [
      JSON.stringify({ type: "user", message: { role: "user", content: earlyIdless } }),
      JSON.stringify({ type: "user", uuid: "idless-order-anchor", message: { role: "user", content: "锚" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: lateIdless } }),
    ].join("\n") + "\n", "utf8");
    await runDiarist("01a0diar00-0000-7000-8000-000000000097b1", [{
      path: idlessOrderPath,
      ranges: [{ from: { line: 3 }, to: { line: 3 } }],
    }]);
    const afterIdlessOrder = await runDiarist("01a0diar00-0000-7000-8000-000000000097b2", [{
      path: idlessOrderPath,
      ranges: [{ from: { line: 1 }, to: { line: 1 } }],
    }]);
    const idlessOrderSession = afterIdlessOrder.header?.sessions.findIndex(
      (session) => session.path === idlessOrderPath,
    );
    assert.notEqual(idlessOrderSession, undefined);
    assert.deepEqual(
      afterIdlessOrder.lines.filter((line) => line.s === idlessOrderSession).map((line) => line.text),
      [earlyIdless, lateIdless],
    );

    // A partially stale historical range still contributes its surviving overlap.
    // Removing only the old end bound must not replay the id-less/raw prefix.
    const rotatingPath = join(home, ".claude", "projects", "probe", "rotating.jsonl");
    const rotatingPrefixId = "msg-rotating-prefix";
    const rotatingStartId = "msg-rotating-start";
    const rotatingEndId = "msg-rotating-end";
    const middleRotatingId = "msg-rotating-middle";
    const newRotatingId = "msg-rotating-new";
    const rotatingIdlessText = "轮转范围内无原生 id";
    const rotatingRaw = "{rotating unreadable";
    const rotatingStart = JSON.stringify({
      type: "user",
      uuid: rotatingStartId,
      message: { role: "user", content: [{ type: "text", text: "轮转起点" }] },
    });
    const rotatingIdless = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: rotatingIdlessText }] },
    });
    const rotatingEnd = JSON.stringify({
      type: "user",
      uuid: rotatingEndId,
      message: { role: "user", content: [{ type: "text", text: "待删除终点" }] },
    });
    await writeFile(
      rotatingPath,
      [rotatingStart, rotatingIdless, rotatingRaw, rotatingEnd].join("\n") + "\n",
      "utf8",
    );
    await runDiarist("01a0diar00-0000-7000-8000-000000000097c", [{
      path: rotatingPath,
      ranges: [{ from: { id: rotatingStartId }, to: { id: rotatingEndId } }],
    }]);
    const rotatingPrefix = JSON.stringify({
      type: "user",
      uuid: rotatingPrefixId,
      message: { role: "user", content: [{ type: "text", text: "后来插入锚点之前" }] },
    });
    const rotatingMiddle = JSON.stringify({
      type: "user",
      uuid: middleRotatingId,
      message: { role: "user", content: [{ type: "text", text: "轮转后新增中段" }] },
    });
    const rotatingNew = JSON.stringify({
      type: "user",
      uuid: newRotatingId,
      message: { role: "user", content: [{ type: "text", text: "轮转后新增终点" }] },
    });
    await writeFile(
      rotatingPath,
      [rotatingPrefix, rotatingStart, rotatingIdless, rotatingRaw, rotatingMiddle, rotatingNew].join("\n") + "\n",
      "utf8",
    );
    const afterRotation = await runDiarist(
      "01a0diar00-0000-7000-8000-000000000097d",
      [{ path: rotatingPath, ranges: [{ from: { id: rotatingStartId }, to: { id: newRotatingId } }] }],
    );
    assert.equal(afterRotation.lines.filter((line) => line.text === rotatingIdlessText).length, 1);
    assert.equal(afterRotation.unprojectedRaw.filter((raw) => raw === rotatingRaw).length, 1);
    assert.equal(afterRotation.lines.filter((line) => line.id === middleRotatingId).length, 1);
    assert.equal(afterRotation.lines.filter((line) => line.id === newRotatingId).length, 1);

    // 验收 4：历史源 S1 不可达后，只交新范围 B（S2）仍成功；再交已声明 A 为 no-op。
    // 变异面：改回「每轮重读全部历史源」→ 本段报红（S1 不可读会拖死 B）。
    const unreachableDir = join(home, ".claude", "projects", "probe-gone");
    await mkdir(unreachableDir, { recursive: true });
    await rename(fixtureA.path, join(unreachableDir, "session-a.jsonl"));
    // session-a path in header now points at a missing file.
    const afterGoneB = await runDiarist(
      "01a0diar00-0000-7000-8000-000000000098a",
      [
        // Resubmit already-declared rangeB only — must not require S1.
        rangeB,
      ],
    );
    assert.equal(
      afterGoneB.lines.length,
      afterRotation.lines.length,
      "resubmit declared bounds while S1 gone is no-op",
    );
    assert.equal(
      afterGoneB.lines.some((line) => line.id === fixtureA.plainOwnerId),
      true,
      "carried A must survive unreachable S1",
    );

    const sessionCPath = join(
      home,
      ".claude",
      "projects",
      "probe",
      "session-c.jsonl",
    );
    // Same native id as session A: identity is typed (s,id), not global id.
    const sessionCOwnerId = fixtureA.plainOwnerId;
    const sessionCOwnerText = "S1 已不可达后新源的陛下发言";
    await writeFile(
      sessionCPath,
      `${JSON.stringify({
        type: "user",
        uuid: sessionCOwnerId,
        message: {
          role: "user",
          content: [{ type: "text", text: sessionCOwnerText }],
        },
      })}\n`,
      "utf8",
    );
    const rangeC = {
      path: sessionCPath,
      ranges: [{ from: { line: 1 }, to: { line: 1 } }],
    };
    const afterC = await runDiarist("01a0diar00-0000-7000-8000-000000000098b", [
      rangeC,
    ]);
    assert.equal(
      afterC.lines.some((line) => line.id === fixtureA.plainOwnerId),
      true,
      "A carried without re-reading gone S1",
    );
    assert.equal(
      afterC.lines.some((line) => line.id === sessionBOwnerId),
      true,
      "B carried while adding C",
    );
    const sessionCIndex = afterC.header?.sessions.findIndex(
      (session) => session.path === sessionCPath,
    );
    assert.equal(
      afterC.lines.find((line) => line.s === sessionCIndex && line.id === sessionCOwnerId)?.text,
      sessionCOwnerText,
      "same native id in a different session must publish under typed (s,id)",
    );
    assert.deepEqual(
      afterC.lines
        .filter((line) => line.id === sessionCOwnerId)
        .map((line) => line.s),
      [0, sessionCIndex],
    );
    assert.equal(
      afterC.header?.sessions.length,
      5,
      "C adds the next session index",
    );

    // Resubmit declared range A (S1 still gone) → exact no-op, no reask.
    const afterResubmitA = await runDiarist(
      "01a0diar00-0000-7000-8000-000000000098c",
      [rangeA],
    );
    assert.equal(
      afterResubmitA.lines.length,
      afterC.lines.length,
      "resubmit declared A while S1 gone must be no-op",
    );
    assert.equal(
      afterResubmitA.lines.some((line) => line.id === fixtureA.plainOwnerId),
      true,
    );

    // 验收 5：本轮需投影的新范围源不可读 → reask，不部分覆盖旧卷。
    const priorBytes = await readFile(paths.recordFile, "utf8");
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
        createRunId: () => "01a0diar00-0000-7000-8000-000000000098",
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
              assert.match(lastReask, /边界无法使用|session unreadable/);
              sawUnreadableReask = true;
              assert.equal(
                readFileSync(paths.recordFile, "utf8"),
                priorBytes,
                "unreadable source must not publish partial projection over prior diary",
              );
              // Recover with empty sessions no-op so the run can accept without rewriting.
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
    assert.equal(
      still.lines.some((line) => line.id === fixtureA.ownerId),
      true,
      "must not wash old entries by omitting them after source failure",
    );
    assert.equal(
      still.lines.some((line) => line.id === sessionBOwnerId && line.s === 1),
      true,
      "cross-session s=1 entry must survive",
    );
    assert.equal(
      still.lines.some((line) => line.id === sessionCOwnerId),
      true,
      "C must survive failed new-range reask",
    );

    // C4：合法投影的同前缀真人正文在后续非 empty 轮次必须稳定保留（非永久过滤器）。
    const pastePath = join(
      home,
      ".claude",
      "projects",
      "probe",
      "session-paste.jsonl",
    );
    const pasteId = "msg-human-paste-task-notif";
    const pasteText =
      "<task-notification> 这是我贴进来要你解释的东西，别删。</task-notification>";
    await writeFile(
      pastePath,
      `${JSON.stringify({
        type: "user",
        uuid: pasteId,
        message: {
          role: "user",
          content: [{ type: "text", text: pasteText }],
        },
      })}\n`,
      "utf8",
    );
    const rangePaste = {
      path: pastePath,
      ranges: [{ from: { line: 1 }, to: { line: 1 } }],
    };
    const afterPaste = await runDiarist(
      "01a0diar00-0000-7000-8000-00000000009a",
      [rangePaste],
    );
    assert.equal(
      afterPaste.lines.some(
        (line) => line.id === pasteId && line.text === pasteText,
      ),
      true,
      "human paste of task-notification prefix must project as owner",
    );
    // Next round: unrelated new range — paste must survive carry (not permanent body filter).
    const keepPath = join(
      home,
      ".claude",
      "projects",
      "probe",
      "session-keep.jsonl",
    );
    const keepId = "msg-keep-after-paste";
    await writeFile(
      keepPath,
      `${JSON.stringify({
        type: "user",
        uuid: keepId,
        message: {
          role: "user",
          content: [{ type: "text", text: "后一句不相干范围" }],
        },
      })}\n`,
      "utf8",
    );
    const afterKeep = await runDiarist(
      "01a0diar00-0000-7000-8000-00000000009b",
      [{ path: keepPath, ranges: [{ from: { line: 1 }, to: { line: 1 } }] }],
    );
    assert.equal(
      afterKeep.lines.some(
        (line) => line.id === pasteId && line.text === pasteText,
      ),
      true,
      "projected human task-notification paste must survive later non-empty rounds",
    );
    assert.equal(
      afterKeep.lines.some((line) => line.id === keepId),
      true,
      "new range after paste must still land",
    );
    // C4 + 验收 3：header.sessions 已非空时 empty 必须内容 no-op，不得再杀合法同前缀。
    const beforeEmptyPaste = await readFile(paths.recordFile, "utf8");
    const afterEmptyPaste = await runDiarist(
      "01a0diar00-0000-7000-8000-00000000009b2",
      [],
    );
    assert.equal(await readFile(paths.recordFile, "utf8"), beforeEmptyPaste);
    assert.equal(
      afterEmptyPaste.lines.some(
        (line) => line.id === pasteId && line.text === pasteText,
      ),
      true,
      "projected human task-notification paste must survive later empty-sessions no-op",
    );

    // Historical headers may contain the same physical session under aliases with
    // ranges split across entries. Coverage comes from persisted source positions,
    // not whichever alias range happened to overwrite another in a Map.
    const aliasHistoryPath = join(home, ".claude", "projects", "probe", "alias-history.jsonl");
    const aliasIdlessText = "别名历史中的无 id 发言";
    const aliasNewId = "msg-alias-history-new";
    await writeFile(aliasHistoryPath, [
      JSON.stringify({ type: "user", message: { role: "user", content: aliasIdlessText } }),
      JSON.stringify({ type: "assistant", uuid: "alias-runner", message: { role: "assistant", content: "已记录" } }),
      JSON.stringify({ type: "user", uuid: aliasNewId, message: { role: "user", content: "别名历史后的新增发言" } }),
    ].join("\n") + "\n", "utf8");
    await writeFile(paths.recordFile, [
      JSON.stringify({
        repo: resolveBookKeyFromGit(project),
        ticket: TICKET,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        sessions: [
          { path: aliasHistoryPath, ranges: [{ from: { line: 1 }, to: { line: 1 } }] },
          { path: `${aliasHistoryPath}/./`, ranges: [{ from: { line: 2 }, to: { line: 2 } }] },
        ],
      }),
      JSON.stringify({
        speaker: "owner",
        s: 0,
        sourcePosition: 0,
        sourceIdentity: "after\u0000<start>\u00001",
        text: aliasIdlessText,
      }),
    ].join("\n") + "\n", "utf8");
    const afterAliasHistory = await runDiarist(
      "01a0diar00-0000-7000-8000-00000000009c",
      [{ path: aliasHistoryPath, ranges: [{ from: { line: 1 }, to: { line: 3 } }] }],
    );
    assert.equal(afterAliasHistory.lines.filter((line) => line.text === aliasIdlessText).length, 1);
    assert.equal(afterAliasHistory.lines.filter((line) => line.id === aliasNewId).length, 1);
  });
});

test("ticket provenance gives mixed positioned and legacy rows a total order", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const paths = resolveTicketProvenanceVolume(TICKET, project, home);
    await mkdir(paths.volumeDir, { recursive: true });
    const session = {
      path: "/historical/session.jsonl",
      ranges: [{ from: { line: 1 }, to: { line: 1 } }],
    };
    await writeFile(paths.recordFile, [
      JSON.stringify({
        repo: resolveBookKeyFromGit(project),
        ticket: TICKET,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        sessions: [session],
      }),
      JSON.stringify({ speaker: "owner", s: 0, id: "legacy", text: "legacy" }),
      JSON.stringify({
        kind: "ticket-provenance",
        timestamp: "2026-01-02T00:00:00.000Z",
        payload: {
          type: "ticket-provenance-append",
          sessions: [session],
          lines: [{
            speaker: "owner",
            s: 0,
            id: "positioned",
            sourcePosition: 4,
            text: "positioned",
          }],
        },
      }),
    ].join("\n") + "\n", "utf8");

    const result = await readTicketProvenance(TICKET, project, home);
    assert.deepEqual(result.lines.map((line) => line.id), ["positioned", "legacy"]);
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

test("ak-role diarist true-unbound leaves no 起居录", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

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
