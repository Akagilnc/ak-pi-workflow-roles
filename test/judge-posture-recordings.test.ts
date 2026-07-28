import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
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
};

const NEUTRAL_INPUT_DENYLIST = [
  /expected\s*[:=]\s*["']?(converged|continue|escalate)/i,
  /you should (continue|converge|escalate)/i,
  /blockerClass/i,
  /allowedStatuses/i,
  /direction\s*[:=]\s*["']?(block|ready)/i,
  /grade\s*this|answer\s*key/i,
];

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function soulDigest(soulText: string): string {
  return createHash("sha256").update(soulText).digest("hex");
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

function extractAcceptedJudgeOutputs(rows: unknown[]): AcceptedOutput[] {
  const accepted: AcceptedOutput[] = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;

    // --mode json stream: tool_execution_end
    if (
      record.type === "tool_execution_end" &&
      record.toolName === "ak_judge_output"
    ) {
      const isError = record.isError === true;
      const result = record.result;
      if (!result || typeof result !== "object") continue;
      const resultRecord = result as Record<string, unknown>;
      const text = contentTextFromUnknown(resultRecord.content);
      if (
        !isError &&
        text.includes("Judge verdict accepted") &&
        resultRecord.details &&
        typeof resultRecord.details === "object"
      ) {
        accepted.push({
          isError: false,
          contentText: text,
          details: resultRecord.details as JudgeDetails,
        });
      }
      continue;
    }

    // session file / message tree: toolResult message
    if (record.type === "message" && record.message && typeof record.message === "object") {
      const message = record.message as Record<string, unknown>;
      if (
        message.role === "toolResult" &&
        message.toolName === "ak_judge_output"
      ) {
        const isError = message.isError === true;
        const text = contentTextFromUnknown(message.content);
        if (
          !isError &&
          text.includes("Judge verdict accepted") &&
          message.details &&
          typeof message.details === "object"
        ) {
          accepted.push({
            isError: false,
            contentText: text,
            details: message.details as JudgeDetails,
          });
        }
      }
    }

    // --mode json also emits message_end for toolResult
    if (record.type === "message_end" && record.message && typeof record.message === "object") {
      const message = record.message as Record<string, unknown>;
      if (
        message.role === "toolResult" &&
        message.toolName === "ak_judge_output"
      ) {
        const isError = message.isError === true;
        const text = contentTextFromUnknown(message.content);
        if (
          !isError &&
          text.includes("Judge verdict accepted") &&
          message.details &&
          typeof message.details === "object"
        ) {
          accepted.push({
            isError: false,
            contentText: text,
            details: message.details as JudgeDetails,
          });
        }
      }
    }
  }

  // Deduplicate identical accepted payloads (stream may repeat tool_execution_end + message_end)
  const unique = new Map<string, AcceptedOutput>();
  for (const item of accepted) {
    unique.set(JSON.stringify(item.details), item);
  }
  return [...unique.values()];
}


function sessionContainsSoul(sessionText: string, soulText: string): boolean {
  const needle = soulText.trim();
  if (needle.length === 0) return false;
  // JSONL escapes newlines; search parsed tool/message text as well as raw.
  if (sessionText.includes(needle)) return true;
  for (const row of parseJsonlLines(sessionText)) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const blobs: unknown[] = [record.result, record.message, record.args];
    for (const blob of blobs) {
      const asText = JSON.stringify(blob ?? "");
      // stringify re-escapes; compare using decoded text fields when present
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

function assertNeutralModelInputs(materials: string, prompt: string): void {
  for (const source of [materials, prompt]) {
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

test("judge posture fixture bundles are present", async () => {
  const entries = await readdir(fixturesRoot);
  assert.ok(entries.includes("r-block"));
  assert.ok(entries.includes("r-ready"));
  assert.ok(entries.includes("README.md"));
});

for (const bundleName of ["r-block", "r-ready"] as const) {
  test(`recorded ${bundleName} accepts via JSONL trust root and matches external expected`, async () => {
    const bundle = await loadBundle(bundleName);
    assertNeutralModelInputs(bundle.materials, bundle.prompt);

    const rows = parseJsonlLines(bundle.sessionText);
    const accepted = extractAcceptedJudgeOutputs(rows);
    assert.equal(
      accepted.length,
      1,
      `${bundleName} must have exactly one unique successful accepted ak_judge_output in JSONL`,
    );
    const sole = accepted[0]!;
    assert.equal(sole.isError, false);
    assert.match(sole.contentText, /Judge verdict accepted/);

    // receipt is cross-check only
    assert.deepEqual(bundle.receipt, sole.details);

    const digest = soulDigest(bundle.soulText);
    assert.equal(bundle.meta.soulDigest, digest);
    assert.ok(
      sessionContainsSoul(bundle.sessionText, bundle.soulText),
      `${bundleName} session must contain current bundled soul body`,
    );

    assertNoPostureFlags(bundle.sessionText, bundle.meta);
    assert.equal(bundle.meta.akRole, "judge");

    assertDirection(sole.details, bundle.expected);

    // packaging: only existing verdict keys
    for (const key of Object.keys(sole.details)) {
      assert.ok(
        ["judgeStatus", "fix", "note", "decisionGate"].includes(key),
        `unexpected verdict key ${key}`,
      );
    }
  });
}

test("posture oracle refuses receipt-only trust without JSONL acceptance", async () => {
  const bundle = await loadBundle("r-ready");
  // Simulate a self-asserted receipt with no JSONL acceptance markers
  const forgedSession = [
    JSON.stringify({ type: "session", version: 3, id: "forged" }),
    JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "ak_judge_output",
        isError: false,
        content: [{ type: "text", text: "self-asserted ok" }],
        details: bundle.receipt,
      },
    }),
  ].join("\n");
  const accepted = extractAcceptedJudgeOutputs(parseJsonlLines(forgedSession));
  assert.equal(accepted.length, 0);
});
