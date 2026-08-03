import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
const fixturesRoot = resolve(root, "test/fixtures/judge-postures");
const soulPath = resolve(root, "souls/judge.md");

type ExpectedMeta = {
  direction: "block" | "ready";
  blockerClass?: "contract" | "seam" | "oracle";
  allowedStatuses: readonly string[];
};

type JudgeDetails = {
  judgeStatus: string;
  fix?: { summary?: string };
  note?: string;
  decisionGate?: unknown;
};

type AcceptedOutput = {
  details: JudgeDetails;
  contentText: string;
  isError: false;
  toolCallId: string;
};

const NEUTRAL_INPUT_DENYLIST = [
  /expected\s*[:=]\s*["']?(converged|continue|escalate)/i,
  /you should (continue|converge|escalate)/i,
  /blockerClass/i,
  /allowedStatuses/i,
  /direction\s*[:=]\s*["']?(block|ready)/i,
  /grade\s*this|answer\s*key/i,
  /\/r-block\//i,
  /\/r-ready\//i,
  /expected\.json/i,
  /meta\.json/i,
  /\br-block\b/i,
  /\br-ready\b/i,
];

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function soulDigest(soulText: string): string {
  return createHash("sha256").update(soulText).digest("hex");
}

function gitEnvironmentFailure(bundleName: string, operation: string, error: unknown): never {
  throw new Error(
    `${bundleName} git environment failure during ${operation}`,
    { cause: error },
  );
}

function readPackagedJudgeSoulAt(packageSha: string, bundleName: string): string {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: root,
      stdio: "ignore",
    });
  } catch (error) {
    gitEnvironmentFailure(bundleName, "repository discovery", error);
  }
  let objectProbe: string;
  try {
    objectProbe = execFileSync(
      "git",
      ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
      { cwd: root, input: `${packageSha}\n`, encoding: "utf8" },
    ).trim();
  } catch (error) {
    gitEnvironmentFailure(bundleName, "packageSha object lookup", error);
  }
  if (objectProbe.endsWith(" missing")) {
    throw new Error(`${bundleName} metadata packageSha object is absent`);
  }
  if (!objectProbe.endsWith(" commit")) {
    throw new Error(`${bundleName} metadata packageSha is not a commit`);
  }
  let packagedPath: string;
  try {
    packagedPath = execFileSync(
      "git",
      ["ls-tree", "-r", "--name-only", packageSha, "--", "souls/judge.md"],
      { cwd: root, encoding: "utf8" },
    ).trim();
  } catch (error) {
    gitEnvironmentFailure(bundleName, "packaged Soul path lookup", error);
  }
  if (packagedPath !== "souls/judge.md") {
    throw new Error(
      `${bundleName} metadata packageSha does not contain souls/judge.md`,
    );
  }
  try {
    return execFileSync(
      "git",
      ["show", `${packageSha}:souls/judge.md`],
      { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
  } catch (error) {
    gitEnvironmentFailure(bundleName, "packaged Soul read", error);
  }
}

function assertPackagedSoulMatchesMeta(
  meta: Record<string, unknown>,
  bundleName: string,
  readPackagedSoul: (packageSha: string, bundleName: string) => string = readPackagedJudgeSoulAt,
): void {
  assert.equal(typeof meta.packageSha, "string");
  assert.equal(typeof meta.soulDigest, "string");
  const packageSha = meta.packageSha as string;
  const packagedSoul = readPackagedSoul(packageSha, bundleName);
  assert.equal(
    soulDigest(packagedSoul),
    meta.soulDigest,
    `${bundleName} metadata soulDigest must match the Judge Soul packaged at packageSha`,
  );
}

function parseJsonlLines(text: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

function contentTextFromUnknown(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (
        part &&
        typeof part === "object" &&
        "type" in part &&
        (part as { type?: string }).type === "text" &&
        "text" in part &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }
      return "";
    })
    .join("\n");
}

function extractUserPromptText(rows: unknown[]): string {
  // Authoritative user prompt is the first completed user message_end (not stream deltas).
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (record.type !== "message_end" || !record.message || typeof record.message !== "object") {
      continue;
    }
    const message = record.message as Record<string, unknown>;
    if (message.role !== "user") continue;
    const text = contentTextFromUnknown(message.content).trim();
    if (text.length > 0) return text;
  }
  return "";
}

function extractUniqueAssistantProvenance(
  rows: unknown[],
): { provider: string; model: string } {
  // Completed assistant message_end only — stream deltas / message_update are not trust root.
  const pairs = new Map<string, { provider: string; model: string }>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (record.type !== "message_end" || !record.message || typeof record.message !== "object") {
      continue;
    }
    const message = record.message as Record<string, unknown>;
    if (message.role !== "assistant") continue;
    const provider = message.provider;
    const model = message.model;
    if (typeof provider !== "string" || provider.trim().length === 0) continue;
    if (typeof model !== "string" || model.trim().length === 0) continue;
    pairs.set(`${provider}\0${model}`, { provider, model });
  }
  assert.ok(pairs.size > 0, "JSONL must expose at least one completed assistant provider/model pair");
  assert.equal(
    pairs.size,
    1,
    `JSONL must expose exactly one distinct assistant provider/model pair, found ${pairs.size}`,
  );
  return [...pairs.values()][0]!;
}

function extractMaterialsPathFromPrompt(promptText: string): string | undefined {
  const patterns = [
    /Materials path[^:\n]*:\s*(\S+)/i,
    /sole case materials\)?:\s*(\S+)/i,
    /materials(?:\s+file)?(?:\s+path)?[^:\n]*:\s*(\S+\.md)/i,
  ];
  for (const pattern of patterns) {
    const match = promptText.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function pathFromReadArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  if (typeof record.path === "string" && record.path.length > 0) return record.path;
  if (typeof record.file_path === "string" && record.file_path.length > 0) {
    return record.file_path;
  }
  if (typeof record.filePath === "string" && record.filePath.length > 0) {
    return record.filePath;
  }
  return undefined;
}

function extractMaterialsReadText(
  rows: unknown[],
  materialsPath: string,
): { path: string; text: string } | undefined {
  const pathByToolCallId = new Map<string, string>();

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;

    if (
      record.type === "tool_execution_start" &&
      record.toolName === "read" &&
      typeof record.toolCallId === "string"
    ) {
      const path = pathFromReadArgs(record.args);
      if (path) pathByToolCallId.set(record.toolCallId, path);
      continue;
    }

    if (
      record.type === "message_end" &&
      record.message &&
      typeof record.message === "object"
    ) {
      const message = record.message as Record<string, unknown>;
      if (
        message.role === "assistant" &&
        Array.isArray(message.content)
      ) {
        for (const part of message.content) {
          if (
            part &&
            typeof part === "object" &&
            (part as { type?: string }).type === "toolCall" &&
            (part as { name?: string }).name === "read" &&
            typeof (part as { id?: unknown }).id === "string"
          ) {
            const path = pathFromReadArgs((part as { arguments?: unknown }).arguments);
            if (path) pathByToolCallId.set((part as { id: string }).id, path);
          }
        }
      }
    }
  }

  const matchesPath = (candidate: string | undefined): boolean => {
    if (!candidate) return false;
    if (candidate === materialsPath) return true;
    // Tolerate equivalent absolute/relative expansions of the same leaf path.
    return (
      candidate.endsWith(materialsPath) ||
      materialsPath.endsWith(candidate) ||
      candidate.split(/[/\\]/).join("/") === materialsPath.split(/[/\\]/).join("/")
    );
  };

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;

    // Prefer tool_execution_end (explicit isError + result content)
    if (
      record.type === "tool_execution_end" &&
      record.toolName === "read" &&
      record.isError === false &&
      typeof record.toolCallId === "string"
    ) {
      const path = pathByToolCallId.get(record.toolCallId);
      if (!matchesPath(path)) continue;
      const result = record.result;
      let text = "";
      if (typeof result === "string") text = result;
      else if (result && typeof result === "object") {
        const resultRecord = result as Record<string, unknown>;
        text =
          contentTextFromUnknown(resultRecord.content) ||
          (typeof resultRecord.text === "string" ? resultRecord.text : "") ||
          (typeof resultRecord.output === "string" ? resultRecord.output : "");
      }
      if (text.length > 0 && path) return { path, text };
    }

    if (
      record.type === "message_end" &&
      record.message &&
      typeof record.message === "object"
    ) {
      const message = record.message as Record<string, unknown>;
      if (
        message.role === "toolResult" &&
        message.toolName === "read" &&
        message.isError === false &&
        typeof message.toolCallId === "string"
      ) {
        const path = pathByToolCallId.get(message.toolCallId);
        if (!matchesPath(path)) continue;
        const text = contentTextFromUnknown(message.content);
        if (text.length > 0 && path) return { path, text };
      }
    }
  }

  return undefined;
}

function extractAcceptedJudgeOutputs(rows: unknown[]): AcceptedOutput[] {
  // Accept only an unambiguous ordered lifecycle per non-empty toolCallId:
  // exactly one assistant-issued toolCall → exactly one matching start →
  // ≥1 agreeing terminal(s), with strict row order call < start < terminals.
  // Same-id replay/conflict (multiple calls or starts) rejects; no last-write.
  type IssuedEvent = { index: number; args: unknown };
  type StartEvent = { index: number; args: unknown };
  type TerminalEvent = {
    index: number;
    contentText: string;
    details: JudgeDetails;
  };
  type IdLifecycle = {
    issued: IssuedEvent[];
    starts: StartEvent[];
    terminals: TerminalEvent[];
  };

  const byId = new Map<string, IdLifecycle>();
  const lifecycleFor = (toolCallId: string): IdLifecycle => {
    const existing = byId.get(toolCallId);
    if (existing) return existing;
    const created: IdLifecycle = { issued: [], starts: [], terminals: [] };
    byId.set(toolCallId, created);
    return created;
  };

  const pushTerminal = (
    index: number,
    toolCallId: unknown,
    isError: unknown,
    content: unknown,
    details: unknown,
  ): void => {
    // Explicit success only — missing/undefined isError does not count.
    if (isError !== false) return;
    if (typeof toolCallId !== "string" || toolCallId.trim().length === 0) return;
    const text = contentTextFromUnknown(content);
    if (!text.includes("Judge verdict accepted")) return;
    if (!details || typeof details !== "object" || Array.isArray(details)) return;
    lifecycleFor(toolCallId).terminals.push({
      index,
      contentText: text,
      details: details as JudgeDetails,
    });
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;

    if (
      record.type === "message_end" &&
      record.message &&
      typeof record.message === "object"
    ) {
      const message = record.message as Record<string, unknown>;
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (
            !part ||
            typeof part !== "object" ||
            (part as { type?: string }).type !== "toolCall" ||
            (part as { name?: string }).name !== "ak_judge_output"
          ) {
            continue;
          }
          const id = (part as { id?: unknown }).id;
          const args = (part as { arguments?: unknown }).arguments;
          if (typeof id !== "string" || id.trim().length === 0) continue;
          if (!args || typeof args !== "object" || Array.isArray(args)) continue;
          lifecycleFor(id).issued.push({ index: i, args });
        }
      }
    }

    if (
      record.type === "tool_execution_start" &&
      record.toolName === "ak_judge_output" &&
      typeof record.toolCallId === "string" &&
      record.toolCallId.trim().length > 0 &&
      record.args &&
      typeof record.args === "object" &&
      !Array.isArray(record.args)
    ) {
      lifecycleFor(record.toolCallId).starts.push({
        index: i,
        args: record.args,
      });
      continue;
    }

    if (
      record.type === "tool_execution_end" &&
      record.toolName === "ak_judge_output"
    ) {
      const result = record.result;
      if (!result || typeof result !== "object") continue;
      const resultRecord = result as Record<string, unknown>;
      pushTerminal(
        i,
        record.toolCallId,
        record.isError,
        resultRecord.content,
        resultRecord.details,
      );
      continue;
    }

    if (
      (record.type === "message" || record.type === "message_end") &&
      record.message &&
      typeof record.message === "object"
    ) {
      const message = record.message as Record<string, unknown>;
      if (
        message.role === "toolResult" &&
        message.toolName === "ak_judge_output"
      ) {
        pushTerminal(
          i,
          message.toolCallId,
          message.isError,
          message.content,
          message.details,
        );
      }
    }
  }

  const accepted: AcceptedOutput[] = [];
  for (const [toolCallId, lifecycle] of byId) {
    const { issued, starts, terminals } = lifecycle;
    // Exactly one issuance and one start; reject same-id replay/conflict.
    if (issued.length !== 1 || starts.length !== 1 || terminals.length === 0) {
      continue;
    }

    const soleIssued = issued[0]!;
    const soleStart = starts[0]!;
    if (!(soleIssued.index < soleStart.index)) continue;
    if (!terminals.every((terminal) => terminal.index > soleStart.index)) {
      continue;
    }

    if (!isDeepStrictEqual(soleIssued.args, soleStart.args)) continue;

    // All terminal representations for one id must agree; disagreement rejects.
    const [first, ...rest] = terminals;
    if (
      rest.some(
        (terminal) =>
          !isDeepStrictEqual(terminal.details, first!.details) ||
          terminal.contentText !== first!.contentText,
      )
    ) {
      continue;
    }

    if (!isDeepStrictEqual(first!.details, soleIssued.args)) continue;

    accepted.push({
      toolCallId,
      isError: false,
      contentText: first!.contentText,
      details: first!.details,
    });
  }

  return accepted;
}

function sessionContainsSoul(sessionText: string, soulText: string): boolean {
  const needle = soulText.trim();
  if (needle.length === 0) return false;
  if (sessionText.includes(needle)) return true;
  for (const row of parseJsonlLines(sessionText)) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const blobs: unknown[] = [record.result, record.message, record.args];
    for (const blob of blobs) {
      const asText = JSON.stringify(blob ?? "");
      if (typeof blob === "object" && blob !== null) {
        const text = contentTextFromUnknown((blob as { content?: unknown }).content);
        if (text.includes(needle)) return true;
      }
      if (asText.includes(JSON.stringify(needle).slice(1, -1))) return true;
    }
  }
  return false;
}

function assertNoPostureFlags(sessionText: string, meta: Record<string, unknown>): void {
  assert.doesNotMatch(sessionText, /--ak-judge-posture|ak-judge-posture/);
  assert.doesNotMatch(sessionText, /--ak-judge-phase|ak-judge-phase/);
  const flags = meta.roleFlags;
  if (Array.isArray(flags)) {
    for (const flag of flags) {
      assert.equal(typeof flag, "string");
      assert.doesNotMatch(String(flag), /posture|history|next-role/i);
    }
  }
}

function assertNeutralModelInputs(...sources: string[]): void {
  for (const source of sources) {
    for (const pattern of NEUTRAL_INPUT_DENYLIST) {
      assert.doesNotMatch(source, pattern);
    }
  }
}

function assertDirection(
  details: JudgeDetails,
  expected: ExpectedMeta,
): void {
  assert.ok(
    expected.allowedStatuses.includes(details.judgeStatus),
    `status ${details.judgeStatus} not in ${expected.allowedStatuses.join(",")}`,
  );
  if (expected.direction === "block") {
    assert.notEqual(details.judgeStatus, "converged");
    if (details.judgeStatus === "continue") {
      assert.equal(typeof details.fix?.summary, "string");
      assert.ok((details.fix?.summary ?? "").trim().length > 0);
      if (expected.blockerClass === "oracle") {
        assert.match(
          details.fix?.summary ?? "",
          /red|green|oracle|反例|可观察|验证|Behavior|Owner|Scope/i,
        );
      }
    }
  } else {
    assert.equal(details.judgeStatus, "converged");
  }
}

function assertJsonlBoundNeutralInputs(
  rows: unknown[],
  staticPrompt: string,
  staticMaterials: string,
): { userPrompt: string; materialsRead: { path: string; text: string } } {
  const userPrompt = extractUserPromptText(rows);
  assert.ok(userPrompt.length > 0, "JSONL must contain a completed user prompt");

  // Static prompt is the adjudication instruction body; JSONL user text may append
  // an opaque materials path line after it.
  const promptBody = staticPrompt.trim();
  assert.ok(
    userPrompt === promptBody || userPrompt.startsWith(promptBody),
    "static input/prompt.md must equal or be a prefix of JSONL user prompt instructions",
  );

  const materialsPath = extractMaterialsPathFromPrompt(userPrompt);
  assert.ok(
    materialsPath && materialsPath.length > 0,
    "JSONL user prompt must cite an opaque materials path",
  );

  const materialsRead = extractMaterialsReadText(rows, materialsPath!);
  assert.ok(
    materialsRead,
    `JSONL must contain a successful read of materials path ${materialsPath}`,
  );

  // Bind static offline input bytes to the actual model-read materials body.
  assert.equal(
    materialsRead!.text,
    staticMaterials,
    "static input/materials.md must byte-equal JSONL materials-read content",
  );

  assertNeutralModelInputs(
    userPrompt,
    materialsRead!.path,
    materialsRead!.text,
    staticPrompt,
    staticMaterials,
  );

  return { userPrompt, materialsRead: materialsRead! };
}

async function loadBundle(name: string) {
  const dir = join(fixturesRoot, name);
  const inputDir = join(dir, "input");
  const [
    materials,
    prompt,
    expected,
    meta,
    receipt,
    sessionText,
    soulText,
  ] = await Promise.all([
    readFile(join(inputDir, "materials.md"), "utf8"),
    readFile(join(inputDir, "prompt.md"), "utf8"),
    readJson<ExpectedMeta>(join(dir, "expected.json")),
    readJson<Record<string, unknown>>(join(dir, "meta.json")),
    readJson<JudgeDetails>(join(dir, "receipt.json")),
    readFile(join(dir, "session.jsonl"), "utf8"),
    readFile(soulPath, "utf8"),
  ]);
  return { dir, materials, prompt, expected, meta, receipt, sessionText, soulText };
}

function acceptedDetails(status: string = "converged"): JudgeDetails {
  return {
    judgeStatus: status,
    note: "synthetic",
  };
}

function syntheticAssistantCall(
  toolCallId: string,
  details: JudgeDetails = acceptedDetails(),
): unknown {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: toolCallId,
          name: "ak_judge_output",
          arguments: details,
        },
      ],
    },
  };
}

function syntheticExecutionStart(
  toolCallId: string,
  details: JudgeDetails = acceptedDetails(),
): unknown {
  return {
    type: "tool_execution_start",
    toolName: "ak_judge_output",
    toolCallId,
    args: details,
  };
}

function syntheticAcceptedEnd(
  toolCallId: string,
  isError: unknown,
  details: JudgeDetails = acceptedDetails(),
): unknown {
  return {
    type: "tool_execution_end",
    toolName: "ak_judge_output",
    toolCallId,
    isError,
    result: {
      content: [{ type: "text", text: "Judge verdict accepted" }],
      details,
    },
  };
}

function syntheticAcceptedMessageEnd(
  toolCallId: string,
  details: JudgeDetails = acceptedDetails(),
): unknown {
  return {
    type: "message_end",
    message: {
      role: "toolResult",
      toolName: "ak_judge_output",
      toolCallId,
      isError: false,
      content: [{ type: "text", text: "Judge verdict accepted" }],
      details,
    },
  };
}

function syntheticBoundAcceptedChain(
  toolCallId: string,
  details: JudgeDetails = acceptedDetails(),
): unknown[] {
  return [
    syntheticAssistantCall(toolCallId, details),
    syntheticExecutionStart(toolCallId, details),
    syntheticAcceptedEnd(toolCallId, false, details),
    syntheticAcceptedMessageEnd(toolCallId, details),
  ];
}

for (const bundleName of ["r-block", "r-ready"] as const) {
  test(`recorded ${bundleName} accepts via JSONL trust root and matches external expected`, async () => {
    const bundle = await loadBundle(bundleName);
    const rows = parseJsonlLines(bundle.sessionText);

    assertJsonlBoundNeutralInputs(rows, bundle.prompt, bundle.materials);

    const accepted = extractAcceptedJudgeOutputs(rows);
    assert.equal(
      accepted.length,
      1,
      `${bundleName} must have exactly one distinct successful accepted ak_judge_output in JSONL`,
    );
    const sole = accepted[0]!;
    assert.equal(sole.isError, false);
    assert.equal(typeof sole.toolCallId, "string");
    assert.ok(sole.toolCallId.trim().length > 0);
    assert.match(sole.contentText, /Judge verdict accepted/);

    // receipt is cross-check only
    assert.deepEqual(bundle.receipt, sole.details);

    const digest = soulDigest(bundle.soulText);
    assert.equal(bundle.meta.soulDigest, digest);
    assertPackagedSoulMatchesMeta(bundle.meta, bundleName);
    assert.ok(
      sessionContainsSoul(bundle.sessionText, bundle.soulText),
      `${bundleName} session must contain current bundled soul body`,
    );

    assertNoPostureFlags(bundle.sessionText, bundle.meta);
    assert.equal(bundle.meta.akRole, "judge");

    const provenance = extractUniqueAssistantProvenance(rows);
    assert.equal(bundle.meta.provider, provenance.provider);
    assert.equal(bundle.meta.model, provenance.model);

    assertDirection(sole.details, bundle.expected);

    // packaging: only existing verdict keys
    for (const key of Object.keys(sole.details)) {
      assert.ok(
        ["judgeStatus", "fix", "classes", "note", "evidence", "decisionGate"].includes(key),
        `unexpected verdict key ${key}`,
      );
    }
  });
}

test("posture oracle rejects metadata package SHA with mismatched packaged Judge Soul", () => {
  // Positive git path stays on the shared family fixture (recorded bundle loads).
  // Negative is pure digest compare — inject a packaged-soul reader, zero subprocesses.
  assert.throws(
    () =>
      assertPackagedSoulMatchesMeta(
        { packageSha: "deadbeef", soulDigest: "0".repeat(64) },
        "r-ready",
        () => "packaged soul body",
      ),
    /r-ready metadata soulDigest must match the Judge Soul packaged at packageSha/,
  );
});

test("acceptance parser rejects orphan terminal without assistant call and start", () => {
  const rows = [syntheticAcceptedEnd("orphan-end", false)];
  const accepted = extractAcceptedJudgeOutputs(rows);
  assert.equal(accepted.length, 0);
});

test("acceptance parser rejects orphan toolResult message without call chain", () => {
  const rows = [syntheticAcceptedMessageEnd("orphan-message")];
  const accepted = extractAcceptedJudgeOutputs(rows);
  assert.equal(accepted.length, 0);
});

test("acceptance parser rejects missing isError even with full bind chain", () => {
  const details = acceptedDetails();
  const rows = [
    syntheticAssistantCall("call-missing-flag", details),
    syntheticExecutionStart("call-missing-flag", details),
    syntheticAcceptedEnd("call-missing-flag", undefined, details),
  ];
  const accepted = extractAcceptedJudgeOutputs(rows);
  assert.equal(accepted.length, 0);
});

test("acceptance parser rejects same-id terminals with conflicting details", () => {
  const early = acceptedDetails("continue");
  const late = acceptedDetails("converged");
  const rows = [
    syntheticAssistantCall("call-conflict", early),
    syntheticExecutionStart("call-conflict", early),
    syntheticAcceptedEnd("call-conflict", false, early),
    syntheticAcceptedMessageEnd("call-conflict", late),
  ];
  const accepted = extractAcceptedJudgeOutputs(rows);
  assert.equal(accepted.length, 0);
});

test("acceptance parser rejects call/start argument mismatch", () => {
  const issued = acceptedDetails("continue");
  const started = acceptedDetails("converged");
  const rows = [
    syntheticAssistantCall("call-mismatch", issued),
    syntheticExecutionStart("call-mismatch", started),
    syntheticAcceptedEnd("call-mismatch", false, issued),
    syntheticAcceptedMessageEnd("call-mismatch", issued),
  ];
  const accepted = extractAcceptedJudgeOutputs(rows);
  assert.equal(accepted.length, 0);
});

test("acceptance parser rejects terminal details that diverge from issued arguments", () => {
  const issued = acceptedDetails("continue");
  const terminal = acceptedDetails("converged");
  const rows = [
    syntheticAssistantCall("call-details-drift", issued),
    syntheticExecutionStart("call-details-drift", issued),
    syntheticAcceptedEnd("call-details-drift", false, terminal),
  ];
  const accepted = extractAcceptedJudgeOutputs(rows);
  assert.equal(accepted.length, 0);
});

test("acceptance parser rejects out-of-order terminal before call and start", () => {
  const details = acceptedDetails();
  const rows = [
    syntheticAcceptedEnd("call-order-terminal-first", false, details),
    syntheticAssistantCall("call-order-terminal-first", details),
    syntheticExecutionStart("call-order-terminal-first", details),
  ];
  const accepted = extractAcceptedJudgeOutputs(rows);
  assert.equal(accepted.length, 0);
});

test("acceptance parser rejects out-of-order start before call", () => {
  const details = acceptedDetails();
  const rows = [
    syntheticExecutionStart("call-order-start-first", details),
    syntheticAssistantCall("call-order-start-first", details),
    syntheticAcceptedEnd("call-order-start-first", false, details),
  ];
  const accepted = extractAcceptedJudgeOutputs(rows);
  assert.equal(accepted.length, 0);
});

test("acceptance parser rejects conflicting or replayed assistant calls for one id", () => {
  const first = acceptedDetails("continue");
  const second = acceptedDetails("converged");
  const rows = [
    syntheticAssistantCall("call-replayed", first),
    syntheticAssistantCall("call-replayed", second),
    syntheticExecutionStart("call-replayed", second),
    syntheticAcceptedEnd("call-replayed", false, second),
  ];
  const accepted = extractAcceptedJudgeOutputs(rows);
  assert.equal(accepted.length, 0);
});

test("acceptance parser rejects conflicting or replayed starts for one id", () => {
  const first = acceptedDetails("continue");
  const second = acceptedDetails("converged");
  const rows = [
    syntheticAssistantCall("start-replayed", second),
    syntheticExecutionStart("start-replayed", first),
    syntheticExecutionStart("start-replayed", second),
    syntheticAcceptedEnd("start-replayed", false, second),
  ];
  const accepted = extractAcceptedJudgeOutputs(rows);
  assert.equal(accepted.length, 0);
});

test("acceptance parser keeps two distinct fully-bound ids with identical details", () => {
  const details = acceptedDetails();
  const rows = [
    ...syntheticBoundAcceptedChain("call-a", details),
    ...syntheticBoundAcceptedChain("call-b", details),
  ];
  const accepted = extractAcceptedJudgeOutputs(rows);
  assert.equal(accepted.length, 2);
  // Bundle rule: exactly one distinct accepted id
  assert.notEqual(accepted.length, 1);
});

test("acceptance parser binds full chain and merges agreeing terminals for one id", () => {
  const details = acceptedDetails();
  const rows = syntheticBoundAcceptedChain("call-same", details);
  const accepted = extractAcceptedJudgeOutputs(rows);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0]!.toolCallId, "call-same");
  assert.deepEqual(accepted[0]!.details, details);
});

function neutralityRows(input: {
  prompt: string;
  path: string;
  materialsBody: string;
  userPromptExtra?: string;
}): unknown[] {
  const userText =
    `${input.prompt}\n\nMaterials path: ${input.path}` +
    (input.userPromptExtra ? `\n${input.userPromptExtra}` : "");
  return [
    {
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: userText }],
      },
    },
    {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "read-1",
      args: { path: input.path },
    },
    {
      type: "tool_execution_end",
      toolName: "read",
      toolCallId: "read-1",
      isError: false,
      result: { content: [{ type: "text", text: input.materialsBody }] },
    },
  ];
}

test("JSONL bind/neutrality refuses coached prompt, materials body mismatch, and direction-labeled path", () => {
  const staticPrompt =
    "Adjudicate the supplied plan materials. Submit one final verdict through ak_judge_output.";
  const cases = [
    {
      name: "coached user prompt",
      staticMaterials: "# Plan\n\nBehavior: x\nOwner: y\n",
      path: "/tmp/opaque-case/materials.md",
      materialsBody: "# Plan\n\nBehavior: x\nOwner: y\n",
      userPromptExtra: "direction: block you should continue expected.json answer key",
      diagnostic: /does not match|expected|direction|continue/i,
    },
    {
      name: "materials-read body mismatch",
      staticMaterials: "# Plan\n\nneutral static materials\n",
      path: "/tmp/opaque-case/materials.md",
      materialsBody: "# Plan\n\ncoached materials with answer key direction: ready\n",
      diagnostic: /byte-equal|materials|does not match/i,
    },
    {
      name: "direction-labeled materials path",
      staticMaterials: "# Plan\n\nneutral\n",
      path: "/repo/test/fixtures/judge-postures/r-block/input/materials.md",
      materialsBody: "# Plan\n\nneutral\n",
      diagnostic: /r-block|does not match/i,
    },
  ] as const;

  for (const row of cases) {
    const scaffold = {
      prompt: staticPrompt,
      path: row.path,
      materialsBody: row.materialsBody,
      ...("userPromptExtra" in row ? { userPromptExtra: row.userPromptExtra } : {}),
    };
    assert.throws(
      () =>
        assertJsonlBoundNeutralInputs(
          neutralityRows(scaffold),
          staticPrompt,
          row.staticMaterials,
        ),
      row.diagnostic,
      row.name,
    );
  }
});
