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
 * 机器入队由整卷适配层按宿主结构化来源排除（#918）；本函数不读正文、不自判机器。
 */
function fromQueueEvent(row: Record<string, unknown>): DialogueEvent[] {
  if (row.type !== "queue-operation" || row.operation !== "enqueue") return [];
  const content = row.content;
  if (typeof content !== "string" || content === "") return [];
  const id = nativeEventId(row);
  return [{ speaker: "owner", text: content, ...(id === undefined ? {} : { id }) }];
}

/** 物化 user 行上的 origin 对象（CC top-level）。 */
function materializationOrigin(
  row: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return isRecord(row.origin) ? row.origin : undefined;
}

/**
 * 物化 user 行上的结构化来源 kind（CC top-level `origin.kind`）。不读正文。
 * 活体取值含 human / task-notification / peer；缺字段＝旧形无 provenance。
 */
function materializationOriginKind(
  row: Record<string, unknown>,
): string | undefined {
  const origin = materializationOrigin(row);
  if (origin === undefined) return undefined;
  const kind = origin.kind;
  return typeof kind === "string" && kind !== "" ? kind : undefined;
}

/**
 * peer 等物化 origin 上的结构化 payload 体（`origin.body`）。
 * 活体 enqueue.content 为 XML 壳，物化 text 另有 wrap 前缀；body 才是两侧共有的宿主标识。
 */
function materializationOriginBody(
  row: Record<string, unknown>,
): string | undefined {
  const origin = materializationOrigin(row);
  if (origin === undefined) return undefined;
  const body = origin.body;
  return typeof body === "string" && body !== "" ? body : undefined;
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
 * 队列项是否由宿主结构化字段标明非陛下来源。
 * - `attachment.origin.kind`：human / peer / …（peer 活体常伴随 commandMode=prompt）
 * - 否则 `attachment.commandMode`：prompt＝真人路；task-notification 等＝机器
 * 缺字段不判。不按正文形态猜。
 */
function isNonOwnerQueuedCommandSource(input: {
  readonly commandMode?: string;
  readonly originKind?: string;
}): boolean {
  if (input.originKind !== undefined) {
    return isNonOwnerOriginKind(input.originKind);
  }
  if (input.commandMode === undefined) return false;
  return input.commandMode !== "prompt" && input.commandMode !== "human";
}

type QueuedCommandSource = {
  readonly commandMode?: string;
  readonly originKind?: string;
};

/**
 * 宿主用 `attachment.queued_command.prompt` 标识同一队列项（enqueue 常无 uuid）。
 * 收集 prompt → {commandMode, origin.kind}，供 enqueue/remove 按关联键取结构化来源。
 */
function queuedCommandSourceByIdentity(
  rows: readonly (Record<string, unknown> | undefined)[],
): ReadonlyMap<string, QueuedCommandSource> {
  const sources = new Map<string, QueuedCommandSource>();
  for (const row of rows) {
    if (row === undefined || row.type !== "attachment") continue;
    if (!isRecord(row.attachment)) continue;
    if (row.attachment.type !== "queued_command") continue;
    const prompt = row.attachment.prompt;
    if (typeof prompt !== "string" || prompt === "") continue;
    const source: {
      commandMode?: string;
      originKind?: string;
    } = {};
    if (
      typeof row.attachment.commandMode === "string" &&
      row.attachment.commandMode !== ""
    ) {
      source.commandMode = row.attachment.commandMode;
    }
    if (isRecord(row.attachment.origin)) {
      const kind = row.attachment.origin.kind;
      if (typeof kind === "string" && kind !== "") source.originKind = kind;
    }
    if (source.commandMode === undefined && source.originKind === undefined) {
      continue;
    }
    sources.set(prompt, source);
  }
  return sources;
}

/** 物化 user 行的说话人正文（与 fromMessageEvent 同源切片；无说话人 text 则无）。 */
function ownerMaterializationText(
  row: Record<string, unknown>,
): string | undefined {
  const events = fromMessageEvent(row);
  if (events.length === 0 || events[0]?.speaker !== "owner") return undefined;
  const text = events[0]?.text;
  return text === undefined || text === "" ? undefined : text;
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

type QueuePairing = {
  /** 物化 user 行下标：真人副本跳过，或机器 origin 行排除。 */
  readonly skipMaterializations: ReadonlySet<number>;
  /** 经结构化来源证实为非陛下的 enqueue 下标——不得署 owner（#918）。 */
  readonly suppressEnqueues: ReadonlySet<number>;
};

/**
 * 整卷队列来源关联（#918）：不靠全局 FIFO，不按正文形态猜来源。
 *
 * 来源真值（宿主结构化字段）：
 * - 物化 user 的 `origin.kind`（human / task-notification / peer / …）
 * - `attachment.queued_command.origin.kind`（peer 活体常 commandMode=prompt 仍标 peer）
 * - `attachment.queued_command.commandMode`（无 origin 时：prompt＝真人；task-notification 等＝机器）
 *
 * 关联键（宿主标识同一队列项；enqueue 常无 uuid）：
 * - enqueue.content ↔ attachment.prompt ↔ remove.content ↔ 物化说话人 text（等文）
 * - peer 等：`origin.body` 落入 enqueue.content（物化 text 可有 wrap 前缀，不等于 enqueue）
 * 关联键只把结构化来源接到对应 enqueue，不按正文形态猜「像机器」。
 *
 * 规则：
 * - attachment 结构化来源非陛下 → 抑制同键 enqueue
 * - origin.kind 非 human → 跳过该物化；经等文或 origin.body 关联抑制对应 enqueue
 * - 真人/旧形物化与同键 enqueue 并存 → 留 enqueue、跳过物化副本（避免双计）
 * - 无正文 enqueue 的 sole 物化、被吸收插话（enqueue 无物化）照常保留
 * - 来源不足时不倒扣：无关联结构化证据，不得因 FIFO 漂移把机器来源扣到另一条真人 enqueue
 */
function ownerMessagesMaterializingQueue(
  rows: readonly (Record<string, unknown> | undefined)[],
): QueuePairing {
  const skipMaterializations = new Set<number>();
  const suppressEnqueues = new Set<number>();
  const queuedSources = queuedCommandSourceByIdentity(rows);
  /** attachment.prompt 与 enqueue 可能属性序不同；origin.body 是更稳的共有标识。 */
  const nonOwnerBodies: string[] = [];
  for (const row of rows) {
    if (row === undefined || row.type !== "attachment") continue;
    if (!isRecord(row.attachment) || row.attachment.type !== "queued_command") {
      continue;
    }
    if (!isRecord(row.attachment.origin)) continue;
    const kind = row.attachment.origin.kind;
    if (typeof kind !== "string" || !isNonOwnerOriginKind(kind)) continue;
    const body = row.attachment.origin.body;
    if (typeof body === "string" && body !== "") nonOwnerBodies.push(body);
  }

  /** content 键 → 同键 enqueue 下标（可多条同文）。 */
  const enqueuesByContent = new Map<string, number[]>();
  /** 有正文的 enqueue：下标 + content，供 origin.body 关联（peer wrap 形）。 */
  const contentEnqueues: { readonly index: number; readonly content: string }[] =
    [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    if (row.type !== "queue-operation" || row.operation !== "enqueue") continue;
    const content = row.content;
    if (typeof content !== "string" || content === "") continue;
    const list = enqueuesByContent.get(content);
    if (list === undefined) enqueuesByContent.set(content, [index]);
    else list.push(index);
    contentEnqueues.push({ index, content });
    const source = queuedSources.get(content);
    if (source !== undefined && isNonOwnerQueuedCommandSource(source)) {
      suppressEnqueues.add(index);
      continue;
    }
    // prompt 与 enqueue 属性差导致等文未命中时，用 attachment.origin.body 关联。
    if (nonOwnerBodies.some((body) => content.includes(body))) {
      suppressEnqueues.add(index);
    }
  }

  const suppressByContent = (content: string): void => {
    const list = enqueuesByContent.get(content);
    if (list === undefined) return;
    for (const index of list) suppressEnqueues.add(index);
  };

  /** origin.body 是 peer 等物化上的结构化 payload；落入 enqueue.content 即同一队列项。 */
  const suppressByOriginBody = (body: string): void => {
    for (const entry of contentEnqueues) {
      if (entry.content.includes(body)) suppressEnqueues.add(entry.index);
    }
  };

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;

    // remove.content：等文接 attachment 来源；属性差时 body 已在 enqueue 扫描阶段抑制。
    if (row.type === "queue-operation" && row.operation === "remove") {
      const content = row.content;
      if (typeof content === "string" && content !== "") {
        const source = queuedSources.get(content);
        if (source !== undefined && isNonOwnerQueuedCommandSource(source)) {
          suppressByContent(content);
        } else if (nonOwnerBodies.some((body) => content.includes(body))) {
          suppressByContent(content);
        }
      }
      continue;
    }

    const originKind = materializationOriginKind(row);
    const text = ownerMaterializationText(row);
    if (text === undefined) continue;

    if (isNonOwnerOriginKind(originKind)) {
      // 非陛下物化：自身不入录；来源在 origin.kind，经关联键接回 enqueue。
      skipMaterializations.add(index);
      // task-notification 等：物化 text 与 enqueue.content 等文。
      suppressByContent(text);
      // peer 等：物化 text 有 wrap，enqueue 为 XML 壳；origin.body 才是共有标识。
      const body = materializationOriginBody(row);
      if (body !== undefined) suppressByOriginBody(body);
      continue;
    }

    // 真人/旧形物化：若同键 enqueue 仍将入录，则本行是副本。
    const matched = enqueuesByContent.get(text);
    if (matched !== undefined && matched.some((i) => !suppressEnqueues.has(i))) {
      skipMaterializations.add(index);
    }
  }

  return { skipMaterializations, suppressEnqueues };
}

/**
 * 整卷适配：返回与入参行等长的对话事实数组（该行不是对话则为空数组）。
 * 需要整卷视野：队列项 ↔ 物化/attachment 的结构化来源关联跨行。
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
