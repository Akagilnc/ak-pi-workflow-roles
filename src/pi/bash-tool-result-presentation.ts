/**
 * Pi-only bash tool_result presentation (#1206).
 *
 * Ordinary bash receipts at/above 10 KiB keep head 1 KiB + tail to the bound,
 * spill proven full text to a file, and foot the omitted counts + full path.
 * node:test TAP uses `# pass`/`# fail` footer counts + each not-ok block.
 * Without a structured full-text fact, the native receipt is left unchanged.
 * read/grep and non-bash tools are out of scope.
 */
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BASH_RECEIPT_THRESHOLD_BYTES = 10 * 1024;
export const BASH_RECEIPT_HEAD_BYTES = 1024;

const TAP_VERSION_LINE = /^TAP version \d+/m;
const TAP_TESTS_FOOTER = /^# tests \d+/m;
/**
 * node:test root summary block (after the plan, once per document).
 * Full contiguous block only — lone `# pass`/`# fail` lines are stdout/stderr comments
 * (`# ${line}`), not counts (node lib/internal/test_runner/reporter/tap.js).
 */
const NODE_TEST_SUMMARY_BLOCK =
  /^# tests \d+\s*\r?\n# suites \d+\s*\r?\n# pass (\d+)\s*\r?\n# fail (\d+)\s*\r?\n# cancelled \d+\s*\r?\n# skipped \d+\s*\r?\n# todo \d+\s*\r?\n# duration_ms \d+(?:\.\d+)?\s*$/gm;

type StructuredBashContent = {
  output?: unknown;
  truncated?: unknown;
  full_output_path?: unknown;
  exit_code?: unknown;
};

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  if (text.endsWith("\n")) n--;
  return n;
}

function utf8Head(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

function utf8Tail(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let start = buf.length - maxBytes;
  while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString("utf8");
}

function isNodeTestTap(text: string): boolean {
  return TAP_VERSION_LINE.test(text) || TAP_TESTS_FOOTER.test(text);
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

/**
 * Source-original not-ok regions (not-ok line + optional YAML diagnostic).
 * Bounds follow the TAP diagnostic form; counts come from node:test footer lines, not this slice.
 */
function sliceNotOkSourceBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const match = /^( *)not ok\b/.exec(lines[i] ?? "");
    if (match === null) {
      i++;
      continue;
    }
    const indent = match[1]?.length ?? 0;
    const start = i;
    i++;
    while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
    const yamlOpen = /^( *)---\s*$/.exec(lines[i] ?? "");
    if (yamlOpen !== null && (yamlOpen[1]?.length ?? 0) > indent) {
      const yamlIndent = yamlOpen[1]?.length ?? 0;
      i++;
      while (i < lines.length) {
        const closer = /^( *)\.\.\.\s*$/.exec(lines[i] ?? "");
        if (closer !== null && (closer[1]?.length ?? 0) === yamlIndent) {
          i++;
          break;
        }
        const peer = /^( *)(ok|not ok)\b/.exec(lines[i] ?? "");
        if (peer !== null && (peer[1]?.length ?? 0) <= indent) break;
        i++;
      }
    }
    blocks.push(lines.slice(start, i).join("\n"));
  }
  return blocks;
}

/** Sum node:test root summary blocks (`# pass`/`# fail` inside each); multi-doc = one block each. */
function nodeTestFooterPassFail(text: string): { pass: number; fail: number } {
  let pass = 0;
  let fail = 0;
  NODE_TEST_SUMMARY_BLOCK.lastIndex = 0;
  for (const match of text.matchAll(NODE_TEST_SUMMARY_BLOCK)) {
    pass += Number(match[1]);
    fail += Number(match[2]);
  }
  return { pass, fail };
}

function summarizeNodeTestTap(text: string): { pass: number; fail: number; summaryText: string } {
  const { pass, fail } = nodeTestFooterPassFail(text);
  const notOkBlocks = sliceNotOkSourceBlocks(text);
  const lines = [`${pass} pass／${fail} fail`];
  if (notOkBlocks.length > 0) {
    lines.push("");
    lines.push(...notOkBlocks);
  }
  return { pass, fail, summaryText: lines.join("\n") };
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
  const totalChars = [...text].length;
  const totalLines = countLines(text);
  if (totalBytes < thresholdBytes) {
    return {
      body: text,
      omittedChars: 0,
      omittedLines: 0,
      totalChars,
      totalLines,
    };
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
    return {
      body: text,
      omittedChars: 0,
      omittedLines: 0,
      totalChars,
      totalLines,
    };
  }
  const body = `${head}${separator}${tail}`;
  const omittedChars = Math.max(0, totalChars - [...head].length - [...tail].length);
  const omittedLines = Math.max(0, totalLines - countLines(head) - countLines(tail));
  return {
    body,
    omittedChars,
    omittedLines,
    totalChars,
    totalLines,
  };
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
  await writeFile(path, fullText, "utf8");
  return path;
}

/**
 * Only proven full command output. Native abort/timeout wraps a possibly truncated
 * receipt with empty details and no structuredContent — that is not full text (R4).
 */
async function resolveProvenFullCommandOutput(input: {
  existingFullOutputPath?: string;
  structured?: StructuredBashContent;
}): Promise<{ fullText: string; fullOutputPath?: string; usedExisting: boolean } | undefined> {
  const existing = input.existingFullOutputPath;
  if (typeof existing === "string" && existing.trim() !== "") {
    // F1: read failure propagates; pi tool_result runner records it and keeps the original result.
    const fullText = await readFile(existing, "utf8");
    return { fullText, fullOutputPath: existing, usedExisting: true };
  }

  const structured = input.structured;
  const structuredPath = structured?.full_output_path;
  if (typeof structuredPath === "string" && structuredPath.trim() !== "") {
    const fullText = await readFile(structuredPath, "utf8");
    return { fullText, fullOutputPath: structuredPath, usedExisting: true };
  }

  if (typeof structured?.output === "string" && structured.truncated !== true) {
    return { fullText: structured.output, usedExisting: false };
  }

  return undefined;
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

  const resolved = await resolveProvenFullCommandOutput({
    ...(existingFullOutputPath === undefined ? {} : { existingFullOutputPath }),
    ...(structured === undefined ? {} : { structured }),
  });
  // No structured full-text fact (native exception path, etc.): keep the native receipt.
  if (resolved === undefined) return undefined;

  const fullText = resolved.fullText;

  // TAP is an independent approved path: always summarize when the proven full output is TAP.
  if (isNodeTestTap(fullText)) {
    const summarized = summarizeNodeTestTap(fullText);
    const path = resolved.usedExisting && resolved.fullOutputPath
      ? resolved.fullOutputPath
      : await writeFullOutput(fullText);
    const text = `${summarized.summaryText}\n\n${formatTapFooter(path)}${statusSuffix}`;
    return mutationFrom(event, text, path);
  }

  // Ordinary layering decision object = the receipt the model would see (F4).
  if (byteLength(receiptText) < BASH_RECEIPT_THRESHOLD_BYTES) {
    return undefined;
  }

  const sliced = headAndTailReceipt(fullText);
  const path = resolved.usedExisting && resolved.fullOutputPath
    ? resolved.fullOutputPath
    : await writeFullOutput(fullText);
  const footer = formatOmissionFooter({
    omittedChars: sliced.omittedChars,
    omittedLines: sliced.omittedLines,
    totalChars: sliced.totalChars,
    totalLines: sliced.totalLines,
    fullOutputPath: path,
  });
  const text = `${sliced.body}\n\n${footer}${statusSuffix}`;
  return mutationFrom(event, text, path);
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
