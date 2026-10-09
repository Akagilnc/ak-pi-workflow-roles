/**
 * Pi-only bash tool_result presentation (#1206).
 *
 * Ordinary bash receipts at/above 10 KiB keep head 1 KiB + tail to the bound,
 * spill proven full text to a file, and foot the omitted counts + full path.
 * node:test TAP uses runner root `# pass`/`# fail` counts + each not-ok block.
 * Without a structured full-text fact, the native receipt is left unchanged.
 * Without an authoritative node:test root summary, TAP is not invented as 0/0.
 * read/grep and non-bash tools are out of scope.
 */
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const BASH_RECEIPT_THRESHOLD_BYTES = 10 * 1024;
export const BASH_RECEIPT_HEAD_BYTES = 1024;

/** Match pi native spill mode (OUTPUT_FILE_MODE); owner-only read. */
const FULL_OUTPUT_FILE_MODE = 0o600;

const TAP_VERSION_LINE = /^TAP version \d+\s*$/;
const TAP_VERSION_LINE_SEARCH = /^TAP version \d+/m;
const TAP_TESTS_FOOTER_SEARCH = /^# tests \d+/m;
const ROOT_PLAN_LINE = /^1\.\.\d+\s*$/;
const SUMMARY_LINE = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /;
/**
 * node:test root summary block (after the root plan, once per document).
 * Full contiguous block only — lone `# pass`/`# fail` lines are stdout/stderr comments
 * (`# ${line}`), not counts (node lib/internal/test_runner/reporter/tap.js).
 */
const NODE_TEST_SUMMARY_BLOCK =
  /^# tests \d+\s*\r?\n# suites \d+\s*\r?\n# pass (\d+)\s*\r?\n# fail (\d+)\s*\r?\n# cancelled \d+\s*\r?\n# skipped \d+\s*\r?\n# todo \d+\s*\r?\n# duration_ms \d+(?:\.\d+)?\s*$/m;

type StructuredBashContent = {
  output?: unknown;
  truncated?: unknown;
  full_output_path?: unknown;
  exit_code?: unknown;
};

type FullOutputSource =
  | { kind: "path"; path: string; usedExisting: boolean }
  | { kind: "memory"; text: string };

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Code-point length without allocating a full character array (B1). */
function countChars(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let newlines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) newlines++;
  }
  return text.endsWith("\n") ? newlines : newlines + 1;
}

/** UTF-8 head bound without Buffer.copy of the entire string. */
function utf8Head(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const b = byteLength(ch);
    if (bytes + b > maxBytes) break;
    bytes += b;
    end += ch.length;
  }
  return text.slice(0, end);
}

/** UTF-8 tail bound without Buffer.copy of the entire string. */
function utf8Tail(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let i = text.length;
  while (i > 0) {
    let start = i - 1;
    const c = text.charCodeAt(start);
    if (c >= 0xdc00 && c <= 0xdfff && start > 0) {
      const hi = text.charCodeAt(start - 1);
      if (hi >= 0xd800 && hi <= 0xdbff) start = i - 2;
    }
    const ch = text.slice(start, i);
    const b = byteLength(ch);
    if (bytes + b > maxBytes) break;
    bytes += b;
    i = start;
  }
  return text.slice(i);
}

function asStructuredBash(value: unknown): StructuredBashContent | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as StructuredBashContent;
}

function statusSuffixFromFacts(structured: StructuredBashContent | undefined): string {
  const code = structured?.exit_code;
  if (typeof code === "number" && code !== 0) {
    return `\n\nCommand exited with code ${code}`;
  }
  return "";
}

function matchOneSummary(text: string): { pass: number; fail: number } | undefined {
  const match = NODE_TEST_SUMMARY_BLOCK.exec(text);
  if (match === null) return undefined;
  return { pass: Number(match[1]), fail: Number(match[2]) };
}

function* iterateTextLines(text: string): Generator<string> {
  let offset = 0;
  while (offset <= text.length) {
    if (offset === text.length) {
      if (text.length === 0 || text.endsWith("\n")) return;
      return;
    }
    const next = text.indexOf("\n", offset);
    if (next === -1) {
      yield text.slice(offset);
      return;
    }
    yield text.slice(offset, next);
    offset = next + 1;
    if (offset === text.length) return;
  }
}

/**
 * Single consumer: runner root summary after unindented plan (B3), else missing (B2).
 * Multi-doc sums each root; any doc without a root summary → undefined.
 * Footer-only (no TAP version) accepts one whole-text summary block.
 * not-ok blocks collected with source bounds for the approved failure presentation.
 */
async function summarizeNodeTestTap(
  lines: AsyncIterable<string> | Iterable<string>,
): Promise<{ pass: number; fail: number; summaryText: string } | undefined> {
  let docsStarted = 0;
  let docsWithSummary = 0;
  let pass = 0;
  let fail = 0;
  let anyVersion = false;
  let anyTestsFooter = false;
  let afterRootPlan = false;
  let summaryLines: string[] = [];
  const notOkBlocks: string[] = [];
  let notOk: { indent: number; lines: string[]; yamlIndent: number | undefined } | null = null;

  const finishSummaryAttempt = (): void => {
    if (summaryLines.length === 0) return;
    const matched = matchOneSummary(summaryLines.join("\n"));
    summaryLines = [];
    if (matched === undefined) return;
    if (anyVersion && !afterRootPlan) return;
    pass += matched.pass;
    fail += matched.fail;
    docsWithSummary++;
    if (anyVersion) afterRootPlan = false;
  };

  const closeNotOk = (): void => {
    if (notOk === null) return;
    notOkBlocks.push(notOk.lines.join("\n"));
    notOk = null;
  };

  const queue: string[] = [];
  const pushLines = async (): Promise<void> => {
    for await (const line of lines as AsyncIterable<string>) {
      queue.push(line);
      while (queue.length > 0) {
        const line = queue.shift()!;

        if (TAP_VERSION_LINE.test(line)) {
          finishSummaryAttempt();
          closeNotOk();
          anyVersion = true;
          docsStarted++;
          afterRootPlan = false;
          summaryLines = [];
          continue;
        }

        if (ROOT_PLAN_LINE.test(line)) {
          finishSummaryAttempt();
          closeNotOk();
          afterRootPlan = true;
          summaryLines = [];
          continue;
        }

        if (/^# tests \d+/.test(line)) anyTestsFooter = true;

        if (notOk !== null) {
          if (notOk.yamlIndent === undefined) {
            if (line.trim() === "") {
              notOk.lines.push(line);
              continue;
            }
            const yamlOpen = /^( *)---\s*$/.exec(line);
            if (yamlOpen !== null && (yamlOpen[1]?.length ?? 0) > notOk.indent) {
              notOk.yamlIndent = yamlOpen[1]?.length ?? 0;
              notOk.lines.push(line);
              continue;
            }
            closeNotOk();
            queue.unshift(line);
            continue;
          }
          const closer = /^( *)\.\.\.\s*$/.exec(line);
          if (closer !== null && (closer[1]?.length ?? 0) === notOk.yamlIndent) {
            notOk.lines.push(line);
            closeNotOk();
            continue;
          }
          const peer = /^( *)(ok|not ok)\b/.exec(line);
          if (peer !== null && (peer[1]?.length ?? 0) <= notOk.indent) {
            closeNotOk();
            queue.unshift(line);
            continue;
          }
          notOk.lines.push(line);
          continue;
        }

        const notOkMatch = /^( *)not ok\b/.exec(line);
        if (notOkMatch !== null) {
          finishSummaryAttempt();
          notOk = { indent: notOkMatch[1]?.length ?? 0, lines: [line], yamlIndent: undefined };
          continue;
        }

        const acceptWindow = anyVersion ? afterRootPlan : true;
        if (!acceptWindow) {
          summaryLines = [];
          continue;
        }
        if (SUMMARY_LINE.test(line)) {
          if (summaryLines.length === 0 && !line.startsWith("# tests ")) continue;
          summaryLines.push(line);
          if (summaryLines.length >= 8) finishSummaryAttempt();
          continue;
        }
        if (summaryLines.length > 0) summaryLines = [];
      }
    }
  };

  await pushLines();
  finishSummaryAttempt();
  closeNotOk();

  if (anyVersion) {
    if (docsStarted === 0 || docsWithSummary !== docsStarted) return undefined;
  } else if (!anyTestsFooter || docsWithSummary !== 1) {
    return undefined;
  }

  const out = [`${pass} pass／${fail} fail`];
  if (notOkBlocks.length > 0) {
    out.push("");
    out.push(...notOkBlocks);
  }
  return { pass, fail, summaryText: out.join("\n") };
}

function headAndTailReceipt(text: string): {
  body: string;
  omittedChars: number;
  omittedLines: number;
  totalChars: number;
  totalLines: number;
} {
  const thresholdBytes = BASH_RECEIPT_THRESHOLD_BYTES;
  const headBytes = BASH_RECEIPT_HEAD_BYTES;
  const totalBytes = byteLength(text);
  const totalChars = countChars(text);
  const totalLines = countLines(text);
  if (totalBytes < thresholdBytes) {
    return { body: text, omittedChars: 0, omittedLines: 0, totalChars, totalLines };
  }
  const separator = "\n\n";
  const separatorBytes = byteLength(separator);
  const headBudget = Math.min(headBytes, thresholdBytes);
  let head = utf8Head(text, headBudget);
  let headLen = byteLength(head);
  let tailBudget = thresholdBytes - headLen - separatorBytes;
  if (tailBudget < 0) {
    head = utf8Head(text, Math.max(0, thresholdBytes - separatorBytes));
    headLen = byteLength(head);
    tailBudget = Math.max(0, thresholdBytes - headLen - separatorBytes);
  }
  const tail = utf8Tail(text, tailBudget);
  if (head.length + tail.length >= text.length && text.startsWith(head) && text.endsWith(tail)) {
    return { body: text, omittedChars: 0, omittedLines: 0, totalChars, totalLines };
  }
  const body = `${head}${separator}${tail}`;
  const omittedChars = Math.max(0, totalChars - countChars(head) - countChars(tail));
  const omittedLines = Math.max(0, totalLines - countLines(head) - countLines(tail));
  return { body, omittedChars, omittedLines, totalChars, totalLines };
}

function decodeUtf8Window(buf: Buffer, role: "head" | "tail"): string {
  if (buf.length === 0) return "";
  let start = 0;
  let end = buf.length;
  if (role === "tail") {
    while (start < end && (buf[start]! & 0xc0) === 0x80) start++;
  }
  if (role === "head") {
    let i = end - 1;
    if (i >= start && (buf[i]! & 0x80) !== 0) {
      while (i > start && (buf[i]! & 0xc0) === 0x80) i--;
      const lead = buf[i]!;
      const need =
        (lead & 0xf8) === 0xf0 ? 4 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xe0) === 0xc0 ? 2 : 1;
      if (end - i < need) end = i;
    }
  }
  if (start >= end) return "";
  return buf.subarray(start, end).toString("utf8");
}

async function streamFileCharLineCounts(
  path: string,
): Promise<{ chars: number; lines: number; bytes: number }> {
  const stream = createReadStream(path);
  const decoder = new TextDecoder("utf8");
  let chars = 0;
  let newlines = 0;
  let bytes = 0;
  let lastChar = "";
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    bytes += buf.length;
    const s = decoder.decode(buf, { stream: true });
    for (const ch of s) {
      chars++;
      if (ch === "\n") newlines++;
      lastChar = ch;
    }
  }
  const rest = decoder.decode();
  for (const ch of rest) {
    chars++;
    if (ch === "\n") newlines++;
    lastChar = ch;
  }
  const lines = chars === 0 ? 0 : newlines + (lastChar === "\n" ? 0 : 1);
  return { chars, lines, bytes };
}

/** Head/tail + totals from a spill path without loading the whole file (B1). */
async function headAndTailFromPath(path: string): Promise<{
  body: string;
  omittedChars: number;
  omittedLines: number;
  totalChars: number;
  totalLines: number;
}> {
  const fh = await open(path, "r");
  try {
    const st = await fh.stat();
    const totalBytes = st.size;
    if (totalBytes < BASH_RECEIPT_THRESHOLD_BYTES) {
      return headAndTailReceipt(await readFile(path, "utf8"));
    }

    const separator = "\n\n";
    const separatorBytes = byteLength(separator);
    const headBudget = Math.min(BASH_RECEIPT_HEAD_BYTES, BASH_RECEIPT_THRESHOLD_BYTES);
    const headRaw = Buffer.alloc(Math.min(headBudget + 4, totalBytes));
    const headRead = await fh.read(headRaw, 0, headRaw.length, 0);
    let head = decodeUtf8Window(headRaw.subarray(0, headRead.bytesRead), "head");
    head = utf8Head(head, headBudget);
    let headLen = byteLength(head);
    let tailBudget = BASH_RECEIPT_THRESHOLD_BYTES - headLen - separatorBytes;
    if (tailBudget < 0) {
      head = utf8Head(head, Math.max(0, BASH_RECEIPT_THRESHOLD_BYTES - separatorBytes));
      headLen = byteLength(head);
      tailBudget = Math.max(0, BASH_RECEIPT_THRESHOLD_BYTES - headLen - separatorBytes);
    }

    const tailReadLen = Math.min(tailBudget + 4, totalBytes);
    const tailPos = Math.max(0, totalBytes - tailReadLen);
    const tailRaw = Buffer.alloc(tailReadLen);
    const tailRead = await fh.read(tailRaw, 0, tailRaw.length, tailPos);
    let tail = decodeUtf8Window(tailRaw.subarray(0, tailRead.bytesRead), "tail");
    tail = utf8Tail(tail, Math.max(0, tailBudget));

    const metrics = await streamFileCharLineCounts(path);
    const body = `${head}${separator}${tail}`;
    return {
      body,
      omittedChars: Math.max(0, metrics.chars - countChars(head) - countChars(tail)),
      omittedLines: Math.max(0, metrics.lines - countLines(head) - countLines(tail)),
      totalChars: metrics.chars,
      totalLines: metrics.lines,
    };
  } finally {
    await fh.close();
  }
}

function formatOmissionFooter(input: {
  omittedChars: number;
  omittedLines: number;
  totalChars: number;
  totalLines: number;
  fullOutputPath: string;
}): string {
  return `[Showing head+tail; omitted ${input.omittedChars} chars / ${input.omittedLines} lines of ${input.totalLines} lines, ${input.totalChars} chars total. Full output: ${input.fullOutputPath}]`;
}

function formatTapFooter(fullOutputPath: string): string {
  return `[Full output: ${fullOutputPath}]`;
}

async function writeFullOutput(fullText: string): Promise<string> {
  const path = join(tmpdir(), `ak-roles-bash-${randomBytes(8).toString("hex")}.log`);
  await writeFile(path, fullText, { encoding: "utf8", mode: FULL_OUTPUT_FILE_MODE });
  return path;
}

/**
 * Proven full-output source only. Paths are not read here (B1).
 * Native abort/timeout without structured full text is not full output (R4).
 */
function resolveProvenFullOutputSource(input: {
  existingFullOutputPath?: string;
  structured?: StructuredBashContent;
}): FullOutputSource | undefined {
  const existing = input.existingFullOutputPath;
  if (typeof existing === "string" && existing.trim() !== "") {
    return { kind: "path", path: existing, usedExisting: true };
  }
  const structured = input.structured;
  const structuredPath = structured?.full_output_path;
  if (typeof structuredPath === "string" && structuredPath.trim() !== "") {
    return { kind: "path", path: structuredPath, usedExisting: true };
  }
  if (typeof structured?.output === "string" && structured.truncated !== true) {
    return { kind: "memory", text: structured.output };
  }
  return undefined;
}

async function ensureFullOutputPath(source: FullOutputSource): Promise<string> {
  if (source.kind === "path") return source.path;
  return writeFullOutput(source.text);
}

async function looksLikeNodeTestTap(source: FullOutputSource): Promise<boolean> {
  if (source.kind === "memory") {
    return TAP_VERSION_LINE_SEARCH.test(source.text) || TAP_TESTS_FOOTER_SEARCH.test(source.text);
  }
  const fh = await open(source.path, "r");
  try {
    const st = await fh.stat();
    if (st.size === 0) return false;
    const headLen = Math.min(256, st.size);
    const headBuf = Buffer.alloc(headLen);
    await fh.read(headBuf, 0, headLen, 0);
    const head = headBuf.toString("utf8");
    if (TAP_VERSION_LINE_SEARCH.test(head) || TAP_TESTS_FOOTER_SEARCH.test(head)) return true;
    if (st.size <= headLen) return false;
    const tailLen = Math.min(4096, st.size);
    const tailBuf = Buffer.alloc(tailLen);
    await fh.read(tailBuf, 0, tailLen, st.size - tailLen);
    const tail = decodeUtf8Window(tailBuf, "tail");
    return TAP_VERSION_LINE_SEARCH.test(tail) || TAP_TESTS_FOOTER_SEARCH.test(tail);
  } finally {
    await fh.close();
  }
}

async function trySummarizeNodeTestTap(
  source: FullOutputSource,
): Promise<{ pass: number; fail: number; summaryText: string } | undefined> {
  // One consumer for path and memory (B3 authority + B2 missing).
  if (source.kind === "memory") {
    return summarizeNodeTestTap(iterateTextLines(source.text));
  }
  const rl = createInterface({
    input: createReadStream(source.path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    return await summarizeNodeTestTap(rl);
  } finally {
    rl.close();
  }
}

export type PiBashToolResultContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type PiBashToolResultEvent = {
  toolName: string;
  content: readonly PiBashToolResultContentPart[];
  details?: unknown;
  structuredContent?: null | boolean | number | string | object | unknown[];
  isError?: boolean;
};

function existingFullOutputPathFromDetails(details: unknown): string | undefined {
  if (details === null || typeof details !== "object") return undefined;
  const path = (details as { fullOutputPath?: unknown }).fullOutputPath;
  return typeof path === "string" && path.trim() !== "" ? path : undefined;
}

function joinTextContent(content: readonly PiBashToolResultContentPart[]): string {
  let out = "";
  for (const part of content) {
    if (part.type === "text") out += part.text;
  }
  return out;
}

export type PiBashToolResultMutation = {
  content: PiBashToolResultContentPart[];
  details: unknown;
  structuredContent?: PiBashToolResultEvent["structuredContent"];
};

/**
 * Pi `tool_result` handler face for bash only. Returns a mutation object or undefined.
 */
export async function presentPiBashToolResult(
  event: PiBashToolResultEvent,
): Promise<PiBashToolResultMutation | undefined> {
  if (event.toolName !== "bash") return undefined;

  const receiptText = joinTextContent(event.content);
  const existingFullOutputPath = existingFullOutputPathFromDetails(event.details);
  const structured = asStructuredBash(event.structuredContent);
  const statusSuffix = statusSuffixFromFacts(structured);

  const source = resolveProvenFullOutputSource({
    ...(existingFullOutputPath === undefined ? {} : { existingFullOutputPath }),
    ...(structured === undefined ? {} : { structured }),
  });
  if (source === undefined) return undefined;

  // TAP branch only when an authoritative root summary is consumable (B2/B3).
  if (await looksLikeNodeTestTap(source)) {
    const summarized = await trySummarizeNodeTestTap(source);
    if (summarized !== undefined) {
      const path = await ensureFullOutputPath(source);
      const text = `${summarized.summaryText}\n\n${formatTapFooter(path)}${statusSuffix}`;
      return mutationFrom(event, text, path);
    }
  }

  if (byteLength(receiptText) < BASH_RECEIPT_THRESHOLD_BYTES) {
    return undefined;
  }

  const path = await ensureFullOutputPath(source);
  const sliced =
    source.kind === "path"
      ? await headAndTailFromPath(source.path)
      : headAndTailReceipt(source.text);
  const footer = formatOmissionFooter({
    omittedChars: sliced.omittedChars,
    omittedLines: sliced.omittedLines,
    totalChars: sliced.totalChars,
    totalLines: sliced.totalLines,
    fullOutputPath: path,
  });
  return mutationFrom(event, `${sliced.body}\n\n${footer}${statusSuffix}`, path);
}

function mutationFrom(
  event: PiBashToolResultEvent,
  text: string,
  fullOutputPath: string,
): PiBashToolResultMutation {
  const images = event.content.filter(
    (part): part is { type: "image"; data: string; mimeType: string } => part.type === "image",
  );
  const detailsBase =
    event.details !== null && typeof event.details === "object"
      ? { ...(event.details as Record<string, unknown>) }
      : {};
  return {
    content: [{ type: "text" as const, text }, ...images],
    details: {
      ...detailsBase,
      fullOutputPath,
    },
    ...(event.structuredContent !== undefined
      ? { structuredContent: event.structuredContent }
      : {}),
  };
}
