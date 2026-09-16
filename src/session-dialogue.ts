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
 * 票面 #918 准许的唯一固定起始形状：`<task-notification`。
 * 其它标签不在御裁射程内——不得扩表，不得伪造 decision key / 「陛下拍定」。
 * 开标签后可直接 `>`（无属性）、EOF 或空白再接属性；其它字符不成立。
 *
 * 机器 enqueue 的完整判据＝结构化来源（origin.kind）／本固定形状／真实因果与位置；
 * 用可变载荷正文（全等或子串）做 identity join 仍为锚定宪法所禁。
 */
const TASK_NOTIFICATION_OPEN_TAG = "<task-notification";

function hasFixedOpenTagPrefix(content: string, tag: string): boolean {
  if (!content.startsWith(tag)) return false;
  const next = content.charAt(tag.length);
  return (
    next === "" ||
    next === ">" ||
    next === " " ||
    next === "\t" ||
    next === "\n" ||
    next === "\r"
  );
}

/** enqueue.content 是否以票面准许的 `<task-notification` 固定开标签起头。 */
function isFixedNonOwnerEnqueueShape(content: string): boolean {
  return hasFixedOpenTagPrefix(content, TASK_NOTIFICATION_OPEN_TAG);
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

/**
 * 整卷适配：返回与入参行等长的对话事实数组（该行不是对话则为空数组）。
 *
 * 物化 user 只消费自身的 typed `origin.kind`：human 保留，具名非 human 排除。
 * enqueue 没有与物化 user 的 typed 关联，故不得以位置把某个 user 来源反扣给它；
 * 仅票面准许的 `<task-notification` 固定形状可直接排除，其余维持既有投影。
 */
export function adaptSessionDialogue(
  rows: readonly (Record<string, unknown> | undefined)[],
): DialogueEvent[][] {
  return rows.map((row) => {
    if (row === undefined) return [];
    const originKind = materializationOriginKind(row);
    if (isNonOwnerOriginKind(originKind)) return [];
    if (
      row.type === "queue-operation" &&
      row.operation === "enqueue" &&
      typeof row.content === "string" &&
      isFixedNonOwnerEnqueueShape(row.content)
    ) {
      return [];
    }
    const queued = fromQueueEvent(row);
    if (queued.length > 0) return queued;
    return fromMessageEvent(row);
  });
}
