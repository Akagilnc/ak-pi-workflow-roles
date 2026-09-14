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
  // payload 上的 id（Codex msg_…）优先于行级 id。
  const id =
    (typeof message.id === "string" && message.id !== "" ? message.id : undefined) ??
    nativeEventId(row);
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

/**
 * 逐次来源配对：仅当对应 enqueue 已由 fromQueueEvent 实际形成 retained owner
 * 对话时，才把随后的物化 user 当副本跳过。FIFO 对齐 enqueue→dequeue/remove。
 * 无正文 enqueue、旧宿主或其他不可投影形状：dequeue 不产生 skip，后续真人
 * user 原样保留。未物化的 retained dequeue（被吸收插话）遇 runner 解除。
 * 不用「卷内曾出现 enqueue」整卷布尔，也不按正文过滤。
 */
function ownerMessagesMaterializingQueue(
  rows: readonly (Record<string, unknown> | undefined)[],
): ReadonlySet<number> {
  const skip = new Set<number>();
  /** 各 enqueue 是否已留下 owner 对话，按入队顺序等 dequeue/remove 消费。 */
  const retainedByEnqueue: boolean[] = [];
  let pendingSkips = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    if (row.type === "queue-operation") {
      if (row.operation === "enqueue") {
        retainedByEnqueue.push(fromQueueEvent(row).length > 0);
        continue;
      }
      if (row.operation === "dequeue" || row.operation === "remove") {
        const retained = retainedByEnqueue.shift();
        // 只在 enqueue 真留下对话且本事件是 dequeue 物化时才跳过后续 user。
        // remove 只消费队列槽，不制造 skip（无物化消息）。
        if (row.operation === "dequeue" && retained === true) {
          pendingSkips += 1;
        }
        continue;
      }
    }
    if (isRunnerMessage(row)) {
      pendingSkips = 0;
      continue;
    }
    if (pendingSkips > 0 && isOwnerDialogueMessage(row)) {
      skip.add(index);
      pendingSkips -= 1;
    }
  }
  return skip;
}

/**
 * 整卷适配：返回与入参行等长的对话事实数组（该行不是对话则为空数组）。
 * 需要整卷视野：enqueue/dequeue 配对跨行。
 */
export function adaptSessionDialogue(
  rows: readonly (Record<string, unknown> | undefined)[],
): DialogueEvent[][] {
  const skipOwner = ownerMessagesMaterializingQueue(rows);
  return rows.map((row, index) => {
    if (row === undefined) return [];
    const queued = fromQueueEvent(row);
    if (queued.length > 0) return queued;
    // Codex event_msg.user_message 无 content_item_kinds 等 provenance，旧 exec
    // 卷中与 worker entrypoint 注入同形——无法证明为 owner 则不取（不猜、不咬正文）。
    if (skipOwner.has(index)) return [];
    return fromMessageEvent(row);
  });
}
