/**
 * 对话事实适配（ADR 0075 `dialogue-only` / `no-tool-output` / `speaker-required`）。
 *
 * 「对话」＝人类输入内容 + 助手回话内容，由各宿主的**结构化会话事件**适配而来。
 * 排除按来源、不按正文：说话人自己写下的文字一律原样保留，其中引用了 ADR 段落
 * 或工具结果也不删（#901 Out of Scope「不做正文过滤」）。
 *
 * 不入录的是工具结果载荷、附件记录与注入块——它们是独立的机器事件，不是谁说的话。
 *
 * 适配规则按宿主并列，不硬套某一宿主的类型名；一行产出 0..n 条对话事实。
 */

/** 说话人：陛下 / runner。每条必标（`speaker-required`）。 */
export type DialogueSpeaker = "owner" | "runner";

/** 一条对话事实。`id` 是源事件的原生 id——不存在则不编。 */
export type DialogueEvent = {
  readonly speaker: DialogueSpeaker;
  readonly text: string;
  readonly id?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 原生 id：行级或消息体级主键的单一实现（bound 解析与落盘共用）。
 * Pi/CC：行上 `uuid`/`id`；Codex：`response_item.payload.id`（或 `message.id`）。
 */
export function nativeEventId(row: Record<string, unknown>): string | undefined {
  for (const key of ["uuid", "id"]) {
    const value = row[key];
    if (typeof value === "string" && value !== "") return value;
  }
  for (const nestKey of ["message", "payload"] as const) {
    const nested = row[nestKey];
    if (!isRecord(nested)) continue;
    for (const key of ["uuid", "id"]) {
      const value = nested[key];
      if (typeof value === "string" && value !== "") return value;
    }
  }
  return undefined;
}

/** 说话人文本块类型：Pi/CC `text`；Codex rollout `input_text` / `output_text`。 */
const SPEAKER_TEXT_PART_TYPES = new Set(["text", "input_text", "output_text"]);

/** 文本块串接：content 为字符串即其本身，为数组则只取说话人文本片段（逐块过滤）。 */
function textParts(content: unknown): string[] {
  if (typeof content === "string") return content === "" ? [] : [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || !SPEAKER_TEXT_PART_TYPES.has(String(part.type))) continue;
    const text = part.text;
    if (typeof text === "string" && text !== "") out.push(text);
  }
  return out;
}

/**
 * 取出 Pi/CC 消息体，或 Codex `response_item.payload.type=message`。
 * developer 与注入用的 user 不在此层用正文识别——见整卷 Codex 规则。
 */
function responseItemMessage(
  row: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (row.type !== "response_item" || !isRecord(row.payload)) return undefined;
  if (row.payload.type !== "message") return undefined;
  return row.payload;
}

function messageBody(row: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(row.message)) return row.message;
  return responseItemMessage(row);
}

function speakerOf(message: Record<string, unknown>): DialogueSpeaker | undefined {
  if (message.role === "assistant") return "runner";
  if (message.role === "user") return "owner";
  // developer / toolResult 等不是说话人回话。
  return undefined;
}

/**
 * Codex `content_item_kinds`：行上结构化来源种类（不读正文）。
 * 真 user 带 `user.text` / `user.image`；注入为 `agents_md.instructions`、
 * `environments.environment_context`、`plugins.recommendations` 等。
 */
function codexContentItemKinds(
  message: Record<string, unknown>,
): readonly string[] | undefined {
  const pass = message.internal_chat_message_metadata_passthrough;
  if (!isRecord(pass) || !Array.isArray(pass.content_item_kinds)) return undefined;
  const kinds: string[] = [];
  for (const kind of pass.content_item_kinds) {
    if (typeof kind === "string" && kind !== "") kinds.push(kind);
  }
  return kinds;
}

/** response_item role=user 是否为真说话人输入（kinds 含 user.*）。 */
function isCodexOwnerResponseItemUser(message: Record<string, unknown>): boolean {
  if (message.role !== "user") return false;
  const kinds = codexContentItemKinds(message);
  // 无 kinds 的旧卷：不能结构化分辨注入与真 user，宁缺勿把注入当陛下。
  if (kinds === undefined) return false;
  return kinds.some((kind) => kind.startsWith("user."));
}

/**
 * 入队事件适配：人类这次输入经队列的来源。
 * 被吸收的插话靠入队事件入录（无独立消息记录，#901 用户故事 11）。
 * 机器入队由整卷适配层排除（#918）；本函数不读正文、不自判机器。
 */
function fromQueueEvent(row: Record<string, unknown>): DialogueEvent[] {
  if (row.type !== "queue-operation" || row.operation !== "enqueue") return [];
  const content = row.content;
  if (typeof content !== "string" || content === "") return [];
  const id = nativeEventId(row);
  return [{ speaker: "owner", text: content, ...(id === undefined ? {} : { id }) }];
}

/**
 * 陛下 2026-09-15 拍定（decision key `queue-source-fixed-shape-prefix=lawful`）：
 * 冻结卷宗上的固定起始形状，不是自由文本。只认这两个御批元素开标签；
 * 不得按内部正文语义或措辞变体扩表。开标签后可直接 `>`（无属性）或空白再接属性。
 *
 * 用固定前缀判「是不是机器 enqueue」合法；用可变载荷/说话人正文（全等或子串）
 * 决定「属于哪一条 enqueue」仍为锚定宪法所禁。
 */
const FIXED_NON_OWNER_ENQUEUE_TAGS = [
  "<task-notification",
  "<cross-session-message",
] as const;

/** enqueue.content 是否以御批固定机器开标签起头。 */
function isFixedNonOwnerEnqueueShape(content: string): boolean {
  for (const tag of FIXED_NON_OWNER_ENQUEUE_TAGS) {
    if (!content.startsWith(tag)) continue;
    const next = content.charAt(tag.length);
    // 元素开标签终止符：`>` 或空白（其后为属性）；其他字符不是这两个形状。
    if (next === "" || next === ">" || next === " " || next === "\t" || next === "\n" || next === "\r") {
      return true;
    }
  }
  return false;
}

/**
 * 物化 user 行上的结构化来源 kind（CC top-level `origin.kind`）。不读正文。
 * 活体取值含 human / task-notification / peer；缺字段＝旧形无 provenance。
 */
function materializationOriginKind(
  row: Record<string, unknown>,
): string | undefined {
  if (!isRecord(row.origin)) return undefined;
  const kind = row.origin.kind;
  return typeof kind === "string" && kind !== "" ? kind : undefined;
}

/**
 * origin.kind 取值是否为非陛下来源（#918 第二类）。
 * - 缺 origin 或 kind=human → 真人路（经队列的真人输入必须保留）
 * - task-notification / peer / 其他具名非 human → 机器或跨会话投递，不得署 owner
 * 判别落在 kind 取值上，不落在字段是否存在。
 */
function isNonOwnerOriginKind(kind: string | undefined): boolean {
  if (kind === undefined) return false;
  return kind !== "human";
}

/**
 * 消息事件适配：助手回话，以及未经入队事件记录的人类输入。
 * 思考块、工具调用块、工具结果块按块排除；同消息的说话人 text 保留
 * （#901 排除按来源不按正文；混合块不得整条丢弃）。
 * Codex response_item user：仅 `content_item_kinds` 含 `user.*` 时入录。
 */
function fromMessageEvent(row: Record<string, unknown>): DialogueEvent[] {
  const message = messageBody(row);
  if (message === undefined) return [];
  if (message.role === "toolResult") return [];
  const speaker = speakerOf(message);
  if (speaker === undefined) return [];
  // Codex response_item user：按行上 kinds 结构化判定，不咬正文、不靠 turn 序。
  if (row.type === "response_item" && speaker === "owner") {
    if (!isCodexOwnerResponseItemUser(message)) return [];
  }
  const parts = textParts(message.content);
  if (parts.length === 0) return [];
  const text = parts.join("");
  if (text === "") return [];
  // 与 bound lookup 同源：nativeEventId 已含 payload/message id。
  const id = nativeEventId(row);
  return [{ speaker, text, ...(id === undefined ? {} : { id }) }];
}

/** 该行是否为可产出 owner 对话正文的消息（工具结果块不算；旁路 text 算）。 */
function isOwnerDialogueMessage(row: Record<string, unknown>): boolean {
  // CC/Pi queue pairing only — Codex owner path is separate.
  if (row.type === "response_item" || row.type === "event_msg") return false;
  return fromMessageEvent(row).some((event) => event.speaker === "owner");
}

/** 该行是否为 runner 回话事件（用于解除未物化的 dequeue 配对）。 */
function isRunnerMessage(row: Record<string, unknown>): boolean {
  const message = messageBody(row);
  return message !== undefined && message.role === "assistant";
}

type QueuePairing = {
  /** 物化 user 行下标：真人副本跳过，或机器 origin 行排除。 */
  readonly skipMaterializations: ReadonlySet<number>;
  /** 经固定形状前缀证实为非陛下的 enqueue 下标——不得署 owner（#918）。 */
  readonly suppressEnqueues: ReadonlySet<number>;
};

/**
 * 整卷队列来源分类（#918 / 给事中署词）：
 * 「利用配对 materialized user 的结构化来源事实排除机器 enqueue；不得匹配正文；
 *  同时必须保住经队列到达的真人输入。」
 *
 * 机器 enqueue 分类（decision key `queue-source-fixed-shape-prefix=lawful`）：
 * - content 以 `<task-notification` / `<cross-session-message` 开头 → 非 owner
 *   覆盖无物化、remove、重渲染 task、hostInjected peer；不据内部正文或变体扩表
 * - 不靠物化反扣 enqueue（避免 FIFO 漂移把机器 origin 扣到真人 enqueue）
 *
 * 物化分类：
 * - `origin.kind` 非 human → 跳过该物化（自身；不反扣 enqueue）
 * - 位置配对（enqueue→dequeue→下一 owner 物化）：有正文 enqueue 的副本物化跳过，
 *   避免双计；配对只消费因果位置，**不**用正文全等/子串做 identity join
 * - 斜杠命令展开等「包装正文 ≠ enqueue」且无 origin 的物化：靠位置配对跳过副本，
 *   enqueue 侧若非固定机器形状则保留为真人输入
 *
 * 无正文 enqueue 的 sole 物化、被吸收插话（enqueue 无物化）照常保留。
 * 不用可变载荷做 identity join；不恢复「以物化 origin 反扣 enqueue」的全局 FIFO 归因。
 */
function ownerMessagesMaterializingQueue(
  rows: readonly (Record<string, unknown> | undefined)[],
): QueuePairing {
  const skipMaterializations = new Set<number>();
  const suppressEnqueues = new Set<number>();

  /** 各 enqueue：下标 + 是否有可投影正文，按入队顺序等 dequeue/remove 消费。 */
  type EnqueueSlot = { readonly index: number; readonly hasContent: boolean };
  const enqueueQueue: EnqueueSlot[] = [];
  let pending: EnqueueSlot[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;

    if (row.type === "queue-operation") {
      if (row.operation === "enqueue") {
        const content = row.content;
        const hasContent =
          typeof content === "string" &&
          content !== "" &&
          fromQueueEvent(row).length > 0;
        if (hasContent && typeof content === "string" && isFixedNonOwnerEnqueueShape(content)) {
          suppressEnqueues.add(index);
        }
        enqueueQueue.push({ index, hasContent });
        continue;
      }
      if (row.operation === "dequeue" || row.operation === "remove") {
        const enqueued = enqueueQueue.shift();
        // remove 只消费队列槽，不制造物化配对（机器项已由固定前缀在入队侧分类）。
        if (row.operation === "dequeue" && enqueued !== undefined) {
          pending.push(enqueued);
        }
        continue;
      }
    }

    if (isRunnerMessage(row)) {
      pending = [];
      continue;
    }

    if (pending.length > 0 && isOwnerDialogueMessage(row)) {
      const paired = pending.shift()!;
      const originKind = materializationOriginKind(row);
      if (isNonOwnerOriginKind(originKind)) {
        // 非陛下物化：自身不入录。不把来源倒扣到任何 enqueue。
        skipMaterializations.add(index);
      } else if (paired.hasContent) {
        // 有正文 enqueue 的物化副本（含包装正文 ≠ enqueue、无 origin 的斜杠展开）：
        // 留 enqueue（若未被固定前缀抑制），跳过物化避免双计。不读正文做 join。
        skipMaterializations.add(index);
      }
      // 无正文 enqueue 的真人物化：不 skip，sole materialization 保留。
    }
  }

  return { skipMaterializations, suppressEnqueues };
}

/**
 * 整卷适配：返回与入参行等长的对话事实数组（该行不是对话则为空数组）。
 * 需要整卷视野：队列项 ↔ 物化的位置配对与固定形状分类跨行。
 */
export function adaptSessionDialogue(
  rows: readonly (Record<string, unknown> | undefined)[],
): DialogueEvent[][] {
  const pairing = ownerMessagesMaterializingQueue(rows);
  return rows.map((row, index) => {
    if (row === undefined) return [];
    if (pairing.suppressEnqueues.has(index)) return [];
    // 非陛下 origin 物化（含未走队列的同形）不得入 owner；kind=human 放行。
    if (isNonOwnerOriginKind(materializationOriginKind(row))) return [];
    const queued = fromQueueEvent(row);
    if (queued.length > 0) return queued;
    // Codex event_msg.user_message 无 content_item_kinds 等 provenance，旧 exec
    // 卷中与 worker entrypoint 注入同形——无法证明为 owner 则不取（不猜、不咬正文）。
    if (pairing.skipMaterializations.has(index)) return [];
    return fromMessageEvent(row);
  });
}
