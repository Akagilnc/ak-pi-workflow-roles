/**
 * #582 / ADR 0075 — diarist mechanical band + LLM collector reverse-verify.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  seedGitRepository,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";
import {
  dedupeSourceBlocks,
  extractCornerQuotes,
  filterNotifications,
  mechanicalSafeguardPipeline,
  verifyQuotesVerbatim,
  type DiaristSourceBlock,
} from "../../src/diarist-mechanical.ts";
import {
  createScriptedDiaristCollector,
  parseDiaristLlmStdout,
} from "../../src/diarist-llm-collector.ts";
import { runDiarist } from "../../src/diarist.ts";
import { readTicketProvenance } from "../../src/ticket-provenance.ts";

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
  // Splice of two distant spans — words all true, order cut (probe 1/27).
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
      // No ticket/keyword/quote — must still reach LLM (no mechanical prose gate).
      transcript: "自动跑就行",
      sourceRef: { sessionFile: "/s", entryId: "u-ana" },
      isUserTurn: true,
    }),
    block({
      transcript: "立文件。送司天台记录。#582",
      sourceRef: { sessionFile: "/s", entryId: "u1" },
    }),
    // compression replay duplicate
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
    "dedupe collapses compression replay",
  );
  // Prose-free blocks are NOT excluded — semantic selection is LLM-only.
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

test("runDiarist: unselected block is watermarked and not re-offered next court", async () => {
  await withHermeticHome({ prefix: "ak-diarist-unsel-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const selected = block({
      transcript: "立文件。送司天台记录。入选。",
      sourceRef: { sessionFile: "/s.jsonl", entryId: "u-sel" },
    });
    const unselected = block({
      transcript: "这段 LLM 本庭不选，但不应每庭重送。",
      sourceRef: { sessionFile: "/s.jsonl", entryId: "u-skip" },
    });
    const later = block({
      transcript: "第二庭才出现的新块。",
      sourceRef: { sessionFile: "/s.jsonl", entryId: "u-new" },
    });

    const seenIds: string[][] = [];
    let pass = 0;
    const collector = createScriptedDiaristCollector((input) => {
      seenIds.push(
        input.candidates.map((c) => String(c.sourceRef.entryId ?? "")),
      );
      pass += 1;
      if (pass === 1) {
        // Select only the first block — leave u-skip unselected.
        return {
          selections: [
            {
              candidateIndex: 0,
              quotes: [] as string[],
              triage: "relevant" as const,
            },
          ],
          rawStdout: "{}",
          engineArgv: ["scripted"],
        };
      }
      return {
        selections: input.candidates.map((_, i) => ({
          candidateIndex: i,
          quotes: [] as string[],
          triage: "relevant" as const,
        })),
        rawStdout: "{}",
        engineArgv: ["scripted"],
      };
    });

    const first = await runDiarist({
      ticketNumber: 7,
      cwd: project,
      blocks: [selected, unselected],
      collector,
    });
    assert.equal(first.appended, 1);
    assert.deepEqual(seenIds[0]!.sort(), ["u-sel", "u-skip"].sort());

    const second = await runDiarist({
      ticketNumber: 7,
      cwd: project,
      blocks: [selected, unselected, later],
      collector,
    });
    assert.equal(second.freshCount, 1);
    assert.deepEqual(
      seenIds[1],
      ["u-new"],
      "unselected u-skip must not re-enter collector; only later new block",
    );
    assert.equal(second.appended, 1);

    const read = await readTicketProvenance(7, project);
    assert.equal(read.entries.length, 2);
    assert.ok(read.entries.every((e) => e.sourceRef.entryId !== "u-skip"));
  });
});

test("runDiarist second court: collector only receives blocks not yet on the volume", async () => {
  await withHermeticHome({ prefix: "ak-diarist-incr-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const blockA = block({
      transcript: "立文件。送司天台记录。第一庭。",
      sourceRef: { sessionFile: "/s.jsonl", entryId: "u-a" },
    });
    const blockB = block({
      transcript: "起居郎只管如实记录。第二庭新增。",
      sourceRef: { sessionFile: "/s.jsonl", entryId: "u-b" },
    });

    const seenSizes: number[] = [];
    const seenIds: string[][] = [];
    const collector = createScriptedDiaristCollector((input) => {
      seenSizes.push(input.candidates.length);
      seenIds.push(
        input.candidates.map((c) => String(c.sourceRef.entryId ?? "")),
      );
      return {
        selections: input.candidates.map((_, i) => ({
          candidateIndex: i,
          quotes: [] as string[],
          triage: "relevant" as const,
        })),
        rawStdout: "{}",
        engineArgv: ["scripted"],
      };
    });

    const first = await runDiarist({
      ticketNumber: 582,
      cwd: project,
      blocks: [blockA],
      collector,
    });
    assert.equal(first.freshCount, 1);
    assert.equal(first.appended, 1);
    assert.deepEqual(seenIds[0], ["u-a"]);

    const second = await runDiarist({
      ticketNumber: 582,
      cwd: project,
      blocks: [blockA, blockB],
      collector,
    });
    assert.equal(second.freshCount, 1, "only the new block is fresh");
    assert.equal(second.appended, 1);
    assert.deepEqual(seenIds[1], ["u-b"], "collector must not re-see u-a");
    assert.equal(seenSizes[1], 1);

    const third = await runDiarist({
      ticketNumber: 582,
      cwd: project,
      blocks: [blockA, blockB],
      collector,
    });
    assert.equal(third.freshCount, 0);
    assert.equal(third.collectorStatus, "skipped-no-fresh");
    assert.equal(seenSizes.length, 2, "collector not invoked when no fresh");

    const read = await readTicketProvenance(582, project);
    assert.equal(read.entries.length, 2);
  });
});

test("runDiarist: LLM receives blocks without ticket/keyword (no mechanical prose gate)", async () => {
  await withHermeticHome({ prefix: "ak-diarist-fullsrc-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const anaphora = "自动跑就行，先这样。";
    const blocks: DiaristSourceBlock[] = [
      block({
        transcript: anaphora,
        sourceRef: { sessionFile: "/s.jsonl", entryId: "u-ana" },
      }),
    ];

    let seenCount = -1;
    const collector = createScriptedDiaristCollector((input) => {
      seenCount = input.candidates.length;
      return {
        selections: [
          {
            candidateIndex: 0,
            quotes: ["自动跑就行"],
            triage: "relevant" as const,
          },
        ],
        rawStdout: "{}",
        engineArgv: ["scripted"],
      };
    });

    const result = await runDiarist({
      ticketNumber: 582,
      cwd: project,
      blocks,
      collector,
    });
    assert.equal(seenCount, 1, "anaphora-only block must reach LLM");
    assert.equal(result.appended, 1);
    const read = await readTicketProvenance(582, project);
    assert.equal(read.entries[0]!.transcript, anaphora);
  });
});

test("runDiarist: LLM selection reverse-verify + idempotent append + reject splice", async () => {
  await withHermeticHome({ prefix: "ak-diarist-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const good =
      "立文件。送司天台记录。所以每个票都应该有的一份文档。";
    const blocks: DiaristSourceBlock[] = [
      block({
        transcript: good,
        sourceRef: { sessionFile: "/s.jsonl", entryId: "u-good" },
      }),
      block({
        transcript: "起居郎不管票面写不写引语，只负责把这个issue的决策相关抓下来。",
        sourceRef: { sessionFile: "/s.jsonl", entryId: "u-2" },
      }),
    ];

    const collector = createScriptedDiaristCollector({
      selections: [
        {
          candidateIndex: 0,
          quotes: ["立文件。送司天台记录。"],
          triage: "relevant",
          note: "founding",
        },
        {
          candidateIndex: 1,
          // spliced — not contiguous in transcript
          quotes: ["起居郎不管票面写不写引语抓下来"],
          triage: "relevant",
        },
      ],
      rawStdout: "{}",
      engineArgv: ["scripted"],
    });

    const first = await runDiarist({
      ticketNumber: 582,
      cwd: project,
      blocks,
      collector,
      ticketBody: "「立文件。送司天台记录。」",
    });
    assert.equal(first.collectorStatus, "ok");
    assert.equal(first.appended, 1);
    assert.equal(first.rejectedQuotes, 1);
    assert.ok(first.humanViewFile);

    const read1 = await readTicketProvenance(582, project);
    assert.equal(read1.entries.length, 1);
    assert.equal(read1.entries[0]!.basis.method, "llm-semantic");
    assert.equal(read1.entries[0]!.transcript, good);

    // Second court run — no fresh blocks; collector skipped; reader entry unchanged.
    const second = await runDiarist({
      ticketNumber: 582,
      cwd: project,
      blocks,
      collector,
    });
    assert.equal(second.freshCount, 0);
    assert.equal(second.collectorStatus, "skipped-no-fresh");
    assert.equal(second.appended, 0);
    const read2 = await readTicketProvenance(582, project);
    assert.equal(read2.entries.length, 1);
  });
});

test("runDiarist without collector leaves volume empty when llmRequired (default)", async () => {
  await withHermeticHome({ prefix: "ak-diarist-nocoll-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const result = await runDiarist({
      ticketNumber: 1,
      cwd: project,
      blocks: [
        block({
          transcript: "#1 起居录",
          sourceRef: { sessionFile: "/s", entryId: "1" },
        }),
      ],
      collector: null,
    });
    assert.equal(result.collectorStatus, "skipped-no-collector");
    assert.equal(result.appended, 0);
    const read = await readTicketProvenance(1, project);
    assert.equal(read.entries.length, 0);
  });
});

test("runDiarist reads cc session jsonl from projects root", async () => {
  await withHermeticHome({ prefix: "ak-diarist-cc-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const projectsRoot = join(home, "claude-projects");
    // encodeClaudeProjectDir("/work") => "-work"
    const sessionDir = join(projectsRoot, "-work");
    await mkdir(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, "sess.jsonl");
    const rows = [
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-08-31T10:00:00.000Z",
        message: { role: "user", content: "立文件。送司天台记录。#99 起居录" },
      },
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-08-31T10:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      },
    ];
    await writeFile(
      sessionFile,
      rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );

    const collector = createScriptedDiaristCollector((input) => ({
      selections: input.candidates.length > 0
        ? [
            {
              candidateIndex: 0,
              quotes: ["立文件。送司天台记录。"],
              triage: "relevant" as const,
            },
          ]
        : [],
      rawStdout: "{}",
      engineArgv: ["scripted"],
    }));

    const result = await runDiarist({
      ticketNumber: 99,
      cwd: project,
      sessionCwds: ["/work"],
      projectsRoot,
      collector,
    });
    assert.ok(result.candidateCount >= 1);
    assert.equal(result.appended, 1);
    const read = await readTicketProvenance(99, project);
    assert.equal(read.entries.length, 1);
    assert.ok(read.entries[0]!.transcript.includes("立文件"));
  });
});
