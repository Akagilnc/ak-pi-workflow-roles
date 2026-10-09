import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BASH_RECEIPT_HEAD_BYTES,
  BASH_RECEIPT_THRESHOLD_BYTES,
  extractTapNotOkBlocks,
  headAndTailReceipt,
  isNodeTestTap,
  presentBashToolResultText,
  presentPiBashToolResult,
  summarizeNodeTestTap,
} from "../../src/pi/bash-tool-result-presentation.ts";

const PASS_TAP = `TAP version 13
# Subtest: a
ok 1 - a
  ---
  duration_ms: 0.3
  type: 'test'
  ...
# Subtest: b
ok 2 - b
  ---
  duration_ms: 0.1
  type: 'test'
  ...
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 10
`;

const FAIL_TAP = `TAP version 13
# Subtest: a
ok 1 - a
  ---
  duration_ms: 0.3
  type: 'test'
  ...
# Subtest: b
not ok 2 - b
  ---
  duration_ms: 0.3
  type: 'test'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    1 !== 2
  code: 'ERR_ASSERTION'
  ...
1..2
# tests 2
# suites 0
# pass 1
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 10
`;

const NESTED_FAIL_TAP = `TAP version 13
# Subtest: outer
    # Subtest: inner fail
    not ok 1 - inner fail
      ---
      duration_ms: 1
      type: 'test'
      failureType: 'testCodeFailure'
      error: |-
        The expression evaluated to a falsy value:

          assert.ok(false)
      ...
    # Subtest: inner ok
    ok 2 - inner ok
      ---
      duration_ms: 0.1
      type: 'test'
      ...
    1..2
not ok 1 - outer
  ---
  duration_ms: 2
  type: 'test'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..1
# tests 3
# suites 0
# pass 1
# fail 2
# cancelled 0
# skipped 0
# todo 0
# duration_ms 10
`;

function asciiPad(prefix: string, totalBytes: number, suffix = ""): string {
  const mid = Math.max(0, totalBytes - Buffer.byteLength(prefix + suffix, "utf8"));
  return prefix + "x".repeat(mid) + suffix;
}

test("isNodeTestTap recognizes version and # tests markers only", () => {
  assert.equal(isNodeTestTap(PASS_TAP), true);
  assert.equal(isNodeTestTap("# tests 3\n# pass 3\n"), true);
  assert.equal(isNodeTestTap("hello\nworld\n"), false);
  assert.equal(isNodeTestTap("not a tap report, just words about tests 3"), false);
});

test("summarizeNodeTestTap keeps pass/fail counts and every not-ok block", () => {
  const pass = summarizeNodeTestTap(PASS_TAP);
  assert.equal(pass.pass, 2);
  assert.equal(pass.fail, 0);
  assert.deepEqual(pass.notOkBlocks, []);
  assert.equal(pass.summaryText, "2 pass／0 fail");

  const fail = summarizeNodeTestTap(FAIL_TAP);
  assert.equal(fail.pass, 1);
  assert.equal(fail.fail, 1);
  assert.equal(fail.notOkBlocks.length, 1);
  assert.match(fail.notOkBlocks[0]!, /^not ok 2 - b/);
  assert.match(fail.notOkBlocks[0]!, /1 !== 2/);
  assert.match(fail.summaryText, /^1 pass／1 fail\n\nnot ok 2 - b/);

  const nested = summarizeNodeTestTap(NESTED_FAIL_TAP);
  assert.equal(nested.pass, 1);
  assert.equal(nested.fail, 2);
  assert.equal(nested.notOkBlocks.length, 2);
  assert.match(nested.notOkBlocks[0]!, /inner fail/);
  assert.match(nested.notOkBlocks[0]!, /assert\.ok\(false\)/);
  assert.match(nested.notOkBlocks[1]!, /^not ok 1 - outer/);
});

test("extractTapNotOkBlocks does not swallow following ok peers", () => {
  const blocks = extractTapNotOkBlocks(NESTED_FAIL_TAP);
  assert.equal(blocks.length, 2);
  assert.equal(blocks.some((b) => b.includes("inner ok")), false);
});

test("headAndTailReceipt leaves sub-threshold text untouched", () => {
  const text = "small output\n";
  const result = headAndTailReceipt(text);
  assert.equal(result.body, text);
  assert.equal(result.omittedChars, 0);
});

test("headAndTailReceipt keeps head 1KiB and fills to 10KiB with tail", () => {
  const headMarker = "HEAD_MARKER_START\n";
  const tailMarker = "\nTAIL_MARKER_END";
  const text = asciiPad(headMarker, BASH_RECEIPT_THRESHOLD_BYTES * 3, tailMarker);
  const result = headAndTailReceipt(text);
  assert.ok(Buffer.byteLength(result.body, "utf8") <= BASH_RECEIPT_THRESHOLD_BYTES);
  assert.ok(result.body.startsWith(headMarker));
  assert.ok(result.body.endsWith(tailMarker));
  assert.ok(Buffer.byteLength(result.body.slice(0, result.body.indexOf("\n\n")), "utf8") <= BASH_RECEIPT_HEAD_BYTES);
  assert.ok(result.omittedChars > 0);
  assert.ok(result.totalChars > result.omittedChars);
});

test("presentBashToolResultText leaves small non-TAP bash output unchanged", async () => {
  const presented = await presentBashToolResultText({ text: "hello from bash\n" });
  assert.equal(presented, null);
});

test("presentBashToolResultText spills full text and head-tails large non-TAP output", async () => {
  const files: string[] = [];
  const text = asciiPad("BEGIN\n", BASH_RECEIPT_THRESHOLD_BYTES * 2, "\nEND");
  const presented = await presentBashToolResultText({
    text,
    writeFullOutput: async (full) => {
      const dir = await mkdtemp(join(tmpdir(), "bash-pres-"));
      const path = join(dir, "full.log");
      await writeFile(path, full, "utf8");
      files.push(path);
      return path;
    },
  });
  assert.ok(presented);
  assert.equal(files.length, 1);
  assert.equal(await readFile(files[0]!, "utf8"), text);
  assert.ok(presented!.text.startsWith("BEGIN\n"));
  assert.match(presented!.text, /END/);
  assert.ok(presented!.text.includes(presented!.fullOutputPath));
  // Body before the footer stays within the 10 KiB bound.
  const footerAt = presented!.text.lastIndexOf("\n\n[");
  assert.ok(footerAt > 0);
  assert.ok(Buffer.byteLength(presented!.text.slice(0, footerAt), "utf8") <= BASH_RECEIPT_THRESHOLD_BYTES);
});

test("presentBashToolResultText uses existing fullOutputPath and does not re-spill", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bash-pres-existing-"));
  const fullPath = join(dir, "pi-native.log");
  const full = asciiPad("FULL_BEGIN\n", BASH_RECEIPT_THRESHOLD_BYTES * 4, "\nFULL_END");
  await writeFile(fullPath, full, "utf8");
  // Display text is the already-truncated pi view, not the full file.
  const truncatedView = `${full.slice(0, 200)}\n\n[Showing lines 1-10 of 999 (50.0KB limit). Full output: ${fullPath}]`;
  let writes = 0;
  const presented = await presentBashToolResultText({
    text: truncatedView,
    existingFullOutputPath: fullPath,
    writeFullOutput: async () => {
      writes++;
      return join(dir, "should-not-write.log");
    },
  });
  assert.ok(presented);
  assert.equal(writes, 0);
  assert.equal(presented!.fullOutputPath, fullPath);
  assert.ok(presented!.text.startsWith("FULL_BEGIN\n"));
  assert.match(presented!.text, /FULL_END/);
  assert.ok(presented!.text.includes(fullPath));
});

test("presentBashToolResultText summarizes TAP and keeps failure blocks + exit status", async () => {
  const files: string[] = [];
  const presented = await presentBashToolResultText({
    text: `${FAIL_TAP}\n\nCommand exited with code 1`,
    writeFullOutput: async (full) => {
      const dir = await mkdtemp(join(tmpdir(), "bash-pres-tap-"));
      const path = join(dir, "full.log");
      await writeFile(path, full, "utf8");
      files.push(path);
      return path;
    },
  });
  assert.ok(presented);
  assert.equal(await readFile(files[0]!, "utf8"), FAIL_TAP);
  assert.match(presented!.text, /^1 pass／1 fail/);
  assert.match(presented!.text, /not ok 2 - b/);
  assert.match(presented!.text, /1 !== 2/);
  assert.match(presented!.text, /Command exited with code 1$/);
  assert.ok(!presented!.text.includes("ok 1 - a\n"));
});

test("presentBashToolResultText summarizes nested TAP failures without dropping inner blocks", async () => {
  const presented = await presentBashToolResultText({
    text: NESTED_FAIL_TAP,
    writeFullOutput: async () => "/tmp/fake-tap.log",
  });
  assert.ok(presented);
  assert.match(presented!.text, /^1 pass／2 fail/);
  assert.match(presented!.text, /inner fail/);
  assert.match(presented!.text, /assert\.ok\(false\)/);
  assert.match(presented!.text, /not ok 1 - outer/);
});

test("presentPiBashToolResult ignores non-bash tools and preserves structuredContent on rewrite", async () => {
  const readResult = await presentPiBashToolResult({
    toolName: "read",
    content: [{ type: "text", text: asciiPad("file\n", BASH_RECEIPT_THRESHOLD_BYTES * 2) }],
  });
  assert.equal(readResult, undefined);

  const large = asciiPad("BASH\n", BASH_RECEIPT_THRESHOLD_BYTES * 2, "\nDONE");
  const rewritten = await presentPiBashToolResult(
    {
      toolName: "bash",
      content: [{ type: "text", text: large }],
      details: { keep: true },
      structuredContent: { output: large, exit_code: 0 },
      isError: false,
    },
    {
      writeFullOutput: async (full) => {
        const dir = await mkdtemp(join(tmpdir(), "bash-pres-pi-"));
        const path = join(dir, "full.log");
        await writeFile(path, full, "utf8");
        return path;
      },
    },
  );
  assert.ok(rewritten);
  assert.equal((rewritten!.details as { keep?: boolean }).keep, true);
  assert.equal(typeof (rewritten!.details as { fullOutputPath?: string }).fullOutputPath, "string");
  assert.deepEqual(rewritten!.structuredContent, { output: large, exit_code: 0 });
  const textPart = rewritten!.content.find((p) => p.type === "text");
  assert.ok(textPart && "text" in textPart);
  assert.ok((textPart as { text: string }).text.startsWith("BASH\n"));
});
