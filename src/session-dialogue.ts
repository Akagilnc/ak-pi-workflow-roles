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

/** 原生 id：宿主各自的消息主键（Pi `id` / Claude Code `uuid`）。 */
export function nativeEventId(row: Record<string, unknown>): string | undefined {
  for (const key of ["uuid", "id"]) {
    const value = row[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/** 文本块串接：content 为字符串即其本身，为数组则取其文本片段。 */
function textParts(content: unknown, partType: string): string[] {
  if (typeof content === "string") return content === "" ? [] : [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || part.type !== partType) continue;
    const text = part.text;
    if (typeof text === "string" && text !== "") out.push(text);
  }
  return out;
}

/** 该行是否携带工具结果载荷（外层类型可能与人类输入同名）。 */
function carriesToolResult(message: Record<string, unknown>): boolean {
  if (message.role === "toolResult") return true;
  const content = message.content;
  if (!Array.isArray(content)) return false;
  return content.some((part) => isRecord(part) && part.type === "tool_result");
}

/**
 * 入队事件适配：人类这次输入的唯一来源。
 * 配对的出队事件不另取，也不做正文比对去重——被吸收的插话正是靠入队事件入录
 * （它没有独立的消息记录，#901 用户故事 11）。
 */
function fromQueueEvent(row: Record<string, unknown>): DialogueEvent[] {
  if (row.type !== "queue-operation" || row.operation !== "enqueue") return [];
  const content = row.content;
  if (typeof content !== "string" || content === "") return [];
  const id = nativeEventId(row);
  return [{ speaker: "owner", text: content, ...(id === undefined ? {} : { id }) }];
}

/**
 * 消息事件适配：助手回话，以及未经入队事件记录的人类输入。
 * 思考块与工具调用块不是回话正文；工具结果载荷整行不取。
 */
function fromMessageEvent(row: Record<string, unknown>): DialogueEvent[] {
  const message = isRecord(row.message) ? row.message : undefined;
  if (message === undefined) return [];
  if (carriesToolResult(message)) return [];
  const speaker: DialogueSpeaker | undefined =
    message.role === "assistant" ? "runner" : message.role === "user" ? "owner" : undefined;
  if (speaker === undefined) return [];
  const id = nativeEventId(row);
  return textParts(message.content, "text").map((text) => ({
    speaker,
    text,
    ...(id === undefined ? {} : { id }),
  }));
}

/** 已有入队事件的宿主：人类输入只从入队事件取，消息侧不重复取。 */
function hostRecordsQueuedInput(rows: readonly Record<string, unknown>[]): boolean {
  return rows.some((row) => row.type === "queue-operation" && row.operation === "enqueue");
}

/**
 * 整卷适配：返回与入参行等长的对话事实数组（该行不是对话则为空数组）。
 * 需要整卷视野是因为「人类输入的唯一来源」取决于本卷宿主是否记录入队事件。
 */
export function adaptSessionDialogue(
  rows: readonly (Record<string, unknown> | undefined)[],
): DialogueEvent[][] {
  const present = rows.filter((row): row is Record<string, unknown> => row !== undefined);
  const queuedInput = hostRecordsQueuedInput(present);
  return rows.map((row) => {
    if (row === undefined) return [];
    const queued = fromQueueEvent(row);
    if (queued.length > 0) return queued;
    const message = fromMessageEvent(row);
    if (queuedInput) return message.filter((event) => event.speaker !== "owner");
    return message;
  });
}
