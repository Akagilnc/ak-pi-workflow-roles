/**
 * #582 / ADR 0075 — diarist pure mechanical band (no fs/git).
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
import { extractReferencedAdrPaths } from "../../src/adr-path-refs.ts";

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

test("extractReferencedAdrPaths keeps docs/adr shapes; drops traversal claims", () => {
  assert.deepEqual(
    extractReferencedAdrPaths(
      "see docs/adr/0075-ticket-provenance-diarist-pipeline.md and docs/adr/sub/a.md",
    ),
    [
      "docs/adr/0075-ticket-provenance-diarist-pipeline.md",
      "docs/adr/sub/a.md",
    ],
  );
  // Traversal / non-ADR claims are not path references (shape, not IO confinement).
  assert.deepEqual(
    extractReferencedAdrPaths(
      "docs/adr/x/../../README.md docs/adr/../secrets.md docs/other/x.md",
    ),
    [],
  );
});
