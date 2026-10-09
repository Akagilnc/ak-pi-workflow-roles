/**
 * Pi-only bash tool_result presentation (#1206).
 *
 * Ordinary bash receipts at/above 10 KiB keep head 1 KiB + tail to the bound,
 * spill full text to a file, and foot the omitted counts + full path.
 * node:test TAP is summarized to pass/fail counts and each not-ok block.
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
const TAP_PASS_FOOTER = /^# pass (\d+)\s*$/m;
const TAP_FAIL_FOOTER = /^# fail (\d+)\s*$/m;
const NOT_OK_LINE = /^( *)not ok\b/;
const OK_OR_NOT_OK_LINE = /^( *)(ok|not ok)\b/;
const COMMAND_STATUS_SUFFIX =
  /\n\n(Command exited with code \d+|Command aborted|Command timed out after [^\n]+|Command terminated without an exit code)$/;

export type BashToolResultPresentation = {
  text: string;
  fullOutputPath: string;
  /** True when the path was newly written by this presentation. */
  wroteFullOutput: boolean;
};

export type BashToolResultPresentationInput = {
  text: string;
  /** Existing pi-native full output path, when the bash tool already spilled. */
  existingFullOutputPath?: string;
  /** Override full-output writer (tests). Default: temp file under os.tmpdir(). */
  writeFullOutput?: (fullText: string) => Promise<string>;
  /** Override full-output reader (tests). Default: readFile utf8. */
  readFullOutput?: (path: string) => Promise<string>;
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
  // Trailing newline does not add an extra empty line for omission accounting.
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

/** Form-language markers for node:test TAP (not free prose). */
export function isNodeTestTap(text: string): boolean {
  return TAP_VERSION_LINE.test(text) || TAP_TESTS_FOOTER.test(text);
}

function readFooterCount(text: string, re: RegExp): number | undefined {
  const m = re.exec(text);
  if (m === null) return undefined;
  return Number(m[1]);
}

/** Each `not ok` line plus its YAML diagnostic (through closing `...`), if any. */
export function extractTapNotOkBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const match = NOT_OK_LINE.exec(lines[i] ?? "");
    if (match === null) {
      i++;
      continue;
    }
    const indent = match[1]?.length ?? 0;
    const start = i;
    i++;
    // Optional YAML diagnostic block opened by `---` and closed by `...`.
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
        const peer = OK_OR_NOT_OK_LINE.exec(lines[i] ?? "");
        if (peer !== null && (peer[1]?.length ?? 0) <= indent) break;
        i++;
      }
    }
    // Without YAML, the block is just the not-ok line. After YAML, stop at closer.
    blocks.push(lines.slice(start, i).join("\n"));
  }
  return blocks;
}

export function summarizeNodeTestTap(text: string): {
  pass: number;
  fail: number;
  notOkBlocks: string[];
  summaryText: string;
} {
  const notOkBlocks = extractTapNotOkBlocks(text);
  const pass = readFooterCount(text, TAP_PASS_FOOTER) ?? 0;
  const fail = readFooterCount(text, TAP_FAIL_FOOTER) ?? notOkBlocks.length;
  const lines = [`${pass} pass／${fail} fail`];
  if (notOkBlocks.length > 0) {
    lines.push("");
    lines.push(...notOkBlocks);
  }
  return { pass, fail, notOkBlocks, summaryText: lines.join("\n") };
}

export function headAndTailReceipt(
  text: string,
  options: {
    thresholdBytes?: number;
    headBytes?: number;
  } = {},
): {
  body: string;
  omittedChars: number;
  omittedLines: number;
  totalChars: number;
  totalLines: number;
  outputBytes: number;
} {
  const thresholdBytes = options.thresholdBytes ?? BASH_RECEIPT_THRESHOLD_BYTES;
  const headBytes = options.headBytes ?? BASH_RECEIPT_HEAD_BYTES;
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
      outputBytes: totalBytes,
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
  // Avoid duplicating the whole string when head+tail cover it with overlap.
  if (head.length + tail.length >= text.length && text.startsWith(head) && text.endsWith(tail)) {
    return {
      body: text,
      omittedChars: 0,
      omittedLines: 0,
      totalChars,
      totalLines,
      outputBytes: totalBytes,
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
    outputBytes: byteLength(body),
  };
}

function formatOmissionFooter(input: {
  omittedChars: number;
  omittedLines: number;
  totalChars: number;
  totalLines: number;
  fullOutputPath: string;
}): string {
  // Phrasing follows pi's `[Showing last … Full output: …]` bracket form.
  return `[Showing head+tail; omitted ${input.omittedChars} chars / ${input.omittedLines} lines of ${input.totalLines} lines, ${input.totalChars} chars total. Full output: ${input.fullOutputPath}]`;
}

function formatTapFooter(fullOutputPath: string): string {
  return `[Full output: ${fullOutputPath}]`;
}

async function defaultWriteFullOutput(fullText: string): Promise<string> {
  const path = join(tmpdir(), `ak-roles-bash-${randomBytes(8).toString("hex")}.log`);
  await writeFile(path, fullText, "utf8");
  return path;
}

async function defaultReadFullOutput(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function splitCommandStatus(text: string): { body: string; statusSuffix: string } {
  const match = COMMAND_STATUS_SUFFIX.exec(text);
  if (match === null || match.index === undefined) {
    return { body: text, statusSuffix: "" };
  }
  return {
    body: text.slice(0, match.index),
    statusSuffix: text.slice(match.index),
  };
}

/**
 * Present one bash tool_result text. Returns null when the receipt should stay as-is.
 */
export async function presentBashToolResultText(
  input: BashToolResultPresentationInput,
): Promise<BashToolResultPresentation | null> {
  const writeFullOutput = input.writeFullOutput ?? defaultWriteFullOutput;
  const readFullOutput = input.readFullOutput ?? defaultReadFullOutput;
  const { body: displayBody, statusSuffix } = splitCommandStatus(input.text);

  let fullText = displayBody;
  let fullOutputPath = input.existingFullOutputPath;
  let wroteFullOutput = false;
  let usedExistingFull = false;

  if (typeof fullOutputPath === "string" && fullOutputPath.trim() !== "") {
    try {
      fullText = await readFullOutput(fullOutputPath);
      usedExistingFull = true;
      // Full file is the raw command output; status suffix stays on the receipt only.
    } catch {
      // Keep display body; do not pretend the truncated view is the full output.
      fullText = displayBody;
      fullOutputPath = undefined;
      usedExistingFull = false;
    }
  }

  if (isNodeTestTap(fullText)) {
    const summarized = summarizeNodeTestTap(fullText);
    if (!usedExistingFull) {
      fullOutputPath = await writeFullOutput(fullText);
      wroteFullOutput = true;
    }
    const path = fullOutputPath!;
    const text = `${summarized.summaryText}\n\n${formatTapFooter(path)}${statusSuffix}`;
    return { text, fullOutputPath: path, wroteFullOutput };
  }

  const totalBytes = byteLength(fullText);
  if (totalBytes < BASH_RECEIPT_THRESHOLD_BYTES) {
    return null;
  }

  const sliced = headAndTailReceipt(fullText);
  if (!usedExistingFull) {
    fullOutputPath = await writeFullOutput(fullText);
    wroteFullOutput = true;
  }
  const path = fullOutputPath!;
  const footer = formatOmissionFooter({
    omittedChars: sliced.omittedChars,
    omittedLines: sliced.omittedLines,
    totalChars: sliced.totalChars,
    totalLines: sliced.totalLines,
    fullOutputPath: path,
  });
  const text = `${sliced.body}\n\n${footer}${statusSuffix}`;
  return { text, fullOutputPath: path, wroteFullOutput };
}

export type PiBashToolResultContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type PiBashToolResultEvent = {
  toolName: string;
  content: readonly PiBashToolResultContentPart[];
  details?: unknown;
  /** Opaque JSON-shaped tool output; passed through when content is replaced. */
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
  options: Pick<BashToolResultPresentationInput, "writeFullOutput" | "readFullOutput"> = {},
): Promise<PiBashToolResultMutation | undefined> {
  if (event.toolName !== "bash") return undefined;
  const text = joinTextContent(event.content);
  const existingFullOutputPath = existingFullOutputPathFromDetails(event.details);
  const presented = await presentBashToolResultText({
    text,
    ...(existingFullOutputPath === undefined ? {} : { existingFullOutputPath }),
    ...options,
  });
  if (presented === null) return undefined;

  const images = event.content.filter(
    (part): part is { type: "image"; data: string; mimeType: string } => part.type === "image",
  );
  const detailsBase =
    event.details !== null && typeof event.details === "object"
      ? { ...(event.details as Record<string, unknown>) }
      : {};
  const details = {
    ...detailsBase,
    fullOutputPath: presented.fullOutputPath,
  };
  return {
    content: [{ type: "text" as const, text: presented.text }, ...images],
    details,
    // Replacing content alone drops structuredContent in pi; keep the original.
    ...(event.structuredContent !== undefined
      ? { structuredContent: event.structuredContent }
      : {}),
  };
}
