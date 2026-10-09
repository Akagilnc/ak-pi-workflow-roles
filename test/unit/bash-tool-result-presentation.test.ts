import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BASH_RECEIPT_THRESHOLD_BYTES,
  presentPiBashToolResult,
} from "../../src/pi/bash-tool-result-presentation.ts";

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

const PASS_TAP = `TAP version 13
# Subtest: a
ok 1 - a
  ---
  duration_ms: 0.1
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5
`;

function asciiPad(prefix: string, totalBytes: number, suffix = ""): string {
  const mid = Math.max(0, totalBytes - Buffer.byteLength(prefix + suffix, "utf8"));
  return prefix + "x".repeat(mid) + suffix;
}

function textOf(mutation: { content: Array<{ type: string; text?: string }> } | undefined): string {
  return mutation?.content.find((part) => part.type === "text")?.text ?? "";
}

function fullPathOf(mutation: { details?: unknown } | undefined): string | undefined {
  const details = mutation?.details;
  if (details === null || typeof details !== "object") return undefined;
  const path = (details as { fullOutputPath?: unknown }).fullOutputPath;
  return typeof path === "string" ? path : undefined;
}

test("#1206 presentPiBashToolResult: small receipt and non-bash stay untouched", async () => {
  assert.equal(
    await presentPiBashToolResult({
      toolName: "bash",
      content: [{ type: "text", text: "hello from bash\n" }],
    }),
    undefined,
  );
  assert.equal(
    await presentPiBashToolResult({
      toolName: "read",
      content: [{ type: "text", text: asciiPad("file\n", BASH_RECEIPT_THRESHOLD_BYTES * 2) }],
    }),
    undefined,
  );
});

test("#1206 presentPiBashToolResult: large ordinary receipt head-tails and spills full text", async () => {
  const large = asciiPad("BEGIN\n", BASH_RECEIPT_THRESHOLD_BYTES * 2, "\nEND");
  const rewritten = await presentPiBashToolResult({
    toolName: "bash",
    content: [{ type: "text", text: large }],
    details: { keep: true },
    structuredContent: { output: large, exit_code: 0 },
  });
  assert.ok(rewritten);
  assert.equal((rewritten!.details as { keep?: boolean }).keep, true);
  const path = fullPathOf(rewritten);
  assert.equal(typeof path, "string");
  assert.equal(await readFile(path!, "utf8"), large);
  assert.deepEqual(rewritten!.structuredContent, { output: large, exit_code: 0 });

  const presented = textOf(rewritten);
  assert.ok(presented.startsWith("BEGIN\n"));
  assert.ok(presented.includes("END"));
  assert.ok(path && presented.includes(path));
  assert.ok(Buffer.byteLength(presented, "utf8") < Buffer.byteLength(large, "utf8"));
});

test("#1206 presentPiBashToolResult: threshold uses receipt; native full path is source of truth", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bash-pres-"));
  const fullPath = join(dir, "pi-native.log");
  const full = asciiPad("FULL_BEGIN\n", BASH_RECEIPT_THRESHOLD_BYTES * 4, "\nFULL_END");
  await writeFile(fullPath, full, "utf8");

  // Native line-truncation leaves a small receipt that must not be rewritten (F4 reverse).
  const smallNativeReceipt = `${full.slice(0, 200)}\n\n[Showing lines 1-10 of 999. Full output: ${fullPath}]`;
  assert.ok(Buffer.byteLength(smallNativeReceipt, "utf8") < BASH_RECEIPT_THRESHOLD_BYTES);
  assert.equal(
    await presentPiBashToolResult({
      toolName: "bash",
      content: [{ type: "text", text: smallNativeReceipt }],
      details: { fullOutputPath: fullPath, truncation: { truncated: true, truncatedBy: "lines" } },
      structuredContent: { output: full.slice(0, 200), truncated: true, full_output_path: fullPath, exit_code: 0 },
    }),
    undefined,
  );

  // Large receipt with native full path reuses the file and head-tails the full source.
  const largeReceipt = asciiPad("TRUNC_VIEW\n", BASH_RECEIPT_THRESHOLD_BYTES + 64, `\n[Full output: ${fullPath}]`);
  const rewritten = await presentPiBashToolResult({
    toolName: "bash",
    content: [{ type: "text", text: largeReceipt }],
    details: { fullOutputPath: fullPath },
    structuredContent: { output: largeReceipt, truncated: true, full_output_path: fullPath, exit_code: 0 },
  });
  assert.ok(rewritten);
  assert.equal(fullPathOf(rewritten), fullPath);
  const presented = textOf(rewritten);
  assert.ok(presented.startsWith("FULL_BEGIN\n"));
  assert.ok(presented.includes("FULL_END"));
  assert.equal(await readFile(fullPath, "utf8"), full);
});

test("#1206 presentPiBashToolResult: missing native full path fails honestly", async () => {
  const missing = join(tmpdir(), `ak-roles-missing-${Date.now()}.log`);
  const receipt = asciiPad("PARTIAL\n", BASH_RECEIPT_THRESHOLD_BYTES + 32, "\nEND");
  await assert.rejects(
    () =>
      presentPiBashToolResult({
        toolName: "bash",
        content: [{ type: "text", text: receipt }],
        details: { fullOutputPath: missing },
        structuredContent: { output: receipt, truncated: true, full_output_path: missing, exit_code: 0 },
      }),
    (error: unknown) => error instanceof Error && "code" in error,
  );
});

test("#1206 presentPiBashToolResult: stdout status-shaped text is not host status identity", async () => {
  // User output ends with the same shape pi uses for failures; exit_code 0 means keep it (F2).
  const body = `${"S".repeat(20_000)}\n\nCommand exited with code 77`;
  assert.equal(Buffer.byteLength(body, "utf8"), 20_029);
  const rewritten = await presentPiBashToolResult({
    toolName: "bash",
    content: [{ type: "text", text: body }],
    structuredContent: { output: body, exit_code: 0 },
  });
  assert.ok(rewritten);
  const path = fullPathOf(rewritten);
  assert.equal(typeof path, "string");
  assert.equal(await readFile(path!, "utf8"), body);
  assert.equal(Buffer.byteLength(await readFile(path!, "utf8"), "utf8"), 20_029);
});

test("#1206 presentPiBashToolResult: receipt threshold includes real exit status bytes", async () => {
  // Body under threshold; receipt with fact-based status suffix crosses it (F4).
  const body = "x".repeat(BASH_RECEIPT_THRESHOLD_BYTES - 20);
  const status = "\n\nCommand exited with code 1";
  const receipt = `${body}${status}`;
  assert.ok(Buffer.byteLength(body, "utf8") < BASH_RECEIPT_THRESHOLD_BYTES);
  assert.ok(Buffer.byteLength(receipt, "utf8") >= BASH_RECEIPT_THRESHOLD_BYTES);

  const rewritten = await presentPiBashToolResult({
    toolName: "bash",
    content: [{ type: "text", text: receipt }],
    structuredContent: { output: body, exit_code: 1 },
    isError: true,
  });
  assert.ok(rewritten);
  const presented = textOf(rewritten);
  assert.ok(presented.includes("Command exited with code 1"));
  const path = fullPathOf(rewritten);
  assert.equal(await readFile(path!, "utf8"), body);
});

test("#1206 presentPiBashToolResult: TAP summary keeps source not-ok blocks and multi-doc counts", async () => {
  const fail = await presentPiBashToolResult({
    toolName: "bash",
    content: [{ type: "text", text: `${FAIL_TAP}\n\nCommand exited with code 1` }],
    structuredContent: { output: FAIL_TAP, exit_code: 1 },
    isError: true,
  });
  assert.ok(fail);
  const failText = textOf(fail);
  assert.ok(failText.startsWith("1 pass／1 fail"));
  assert.ok(failText.includes("not ok 2 - b"));
  assert.ok(failText.includes("1 !== 2"));
  assert.ok(failText.endsWith("Command exited with code 1"));
  assert.equal(await readFile(fullPathOf(fail)!, "utf8"), FAIL_TAP);

  const nested = await presentPiBashToolResult({
    toolName: "bash",
    content: [{ type: "text", text: NESTED_FAIL_TAP }],
    structuredContent: { output: NESTED_FAIL_TAP, exit_code: 1 },
    isError: true,
  });
  assert.ok(nested);
  const nestedText = textOf(nested);
  assert.ok(nestedText.startsWith("1 pass／2 fail"));
  assert.ok(nestedText.includes("inner fail"));
  assert.ok(nestedText.includes("assert.ok(false)"));
  assert.ok(nestedText.includes("not ok 1 - outer"));

  // Two TAP documents in one bash receipt: counts cover the whole output (F3).
  const multi = `${PASS_TAP}${FAIL_TAP}`;
  const multiResult = await presentPiBashToolResult({
    toolName: "bash",
    content: [{ type: "text", text: multi }],
    structuredContent: { output: multi, exit_code: 1 },
    isError: true,
  });
  assert.ok(multiResult);
  const multiText = textOf(multiResult);
  // PASS_TAP (1 pass) + FAIL_TAP (1 pass / 1 fail) over the whole receipt.
  assert.ok(multiText.startsWith("2 pass／1 fail"));
  assert.ok(multiText.includes("not ok 2 - b"));
});
