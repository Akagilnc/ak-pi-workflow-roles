/**
 * #582 / ADR 0075 — diarist pure mechanical + collector parse (no fs/git).
 * runDiarist hermetic cases live in test/integration/diarist-run.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  dedupeSourceBlocks,
  extractCornerQuotes,
  filterNotifications,
  mechanicalSafeguardPipeline,
  verifyQuotesVerbatim,
  type DiaristSourceBlock,
} from "../../src/diarist-mechanical.ts";
import { parseDiaristLlmStdout } from "../../src/diarist-llm-collector.ts";

function block(
  partial: Partial<DiaristSourceBlock> &
    Pick<DiaristSourceBlock, "transcript" | "sourceRef">,
): DiaristSourceBlock {
  return {
    sourceKind: "cc-session",
    timestamp: "2026-08-31T00:00:00.000Z",
    isUserTurn: true,
    isNotification: false,
    ...partial,
  };
}

test("extractCornerQuotes keeps only 「」 spans meeting min length", () => {
  const text = '短「ab」长「立文件。送司天台记录。」尾「xy」';
  assert.deepEqual(extractCornerQuotes(text, 6), ["立文件。送司天台记录。"]);
  assert.deepEqual(extractCornerQuotes(text, 2), [
    "ab",
    "立文件。送司天台记录。",
    "xy",
  ]);
});

test("verifyQuotesVerbatim accepts contiguous quotes and rejects splices", () => {
  const source =
    "立文件。送司天台记录。所以每个票都应该有的一份文档。免得后续还要去session大海里翻对话。";
  assert.equal(
    verifyQuotesVerbatim(source, ["立文件。送司天台记录。"]).ok,
    true,
  );
  const spliced = "立文件。免得到session大海里翻对话。";
  const failed = verifyQuotesVerbatim(source, [spliced]);
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.deepEqual(failed.failedQuotes, [spliced]);
});

test("mechanical safeguard: typed notify filter + dedupe; no prose exclusion", () => {
  const blocks: DiaristSourceBlock[] = [
    block({
      transcript: "<command-name>/compact</command-name>",
      sourceRef: { sessionFile: "/s", entryId: "n1" },
      isNotification: true,
    }),
    block({
      transcript: "assistant chatter about design",
      sourceRef: { sessionFile: "/s", entryId: "a1" },
      isUserTurn: false,
    }),
    block({
      transcript: "自动跑就行",
      sourceRef: { sessionFile: "/s", entryId: "u-ana" },
      isUserTurn: true,
    }),
    block({
      transcript: "立文件。送司天台记录。#582",
      sourceRef: { sessionFile: "/s", entryId: "u1" },
    }),
    block({
      transcript: "立文件。送司天台记录。#582",
      sourceRef: { sessionFile: "/s", entryId: "u1" },
    }),
    block({
      transcript: "unrelated gardening notes",
      sourceRef: { sessionFile: "/s", entryId: "u2" },
    }),
  ];

  const cleaned = filterNotifications(blocks);
  assert.equal(cleaned.some((b) => b.isNotification), false);
  assert.equal(cleaned.length, 5);

  const pipeline = mechanicalSafeguardPipeline(blocks);
  assert.ok(pipeline.every((b) => !b.isNotification));
  assert.equal(
    pipeline.filter((b) => b.sourceRef.entryId === "u1").length,
    1,
  );
  assert.ok(pipeline.some((b) => b.sourceRef.entryId === "u-ana"));
  assert.ok(pipeline.some((b) => b.sourceRef.entryId === "u2"));
  assert.equal(dedupeSourceBlocks(cleaned).length, pipeline.length);
});

test("parseDiaristLlmStdout projects selections and drops OOB indexes", () => {
  const stdout = JSON.stringify({
    selections: [
      { candidateIndex: 0, quotes: ["hello"], triage: "relevant" },
      { candidateIndex: 99, quotes: ["nope"] },
      { index: 1, quote: "world", triage: "context" },
    ],
  });
  const parsed = parseDiaristLlmStdout(stdout, 2);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]!.candidateIndex, 0);
  assert.deepEqual(parsed[0]!.quotes, ["hello"]);
  assert.equal(parsed[1]!.candidateIndex, 1);
  assert.deepEqual(parsed[1]!.quotes, ["world"]);
});
