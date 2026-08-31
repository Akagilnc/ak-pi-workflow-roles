/**
 * #582 / ADR 0075 — diarist runDiarist hermetic cases (fs + git book key).
 * Medium: local resources. Pure mechanical stays in test/unit/diarist.test.ts.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  seedGitRepository,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";
import type { DiaristSourceBlock } from "../../src/diarist-mechanical.ts";
import { createScriptedDiaristCollector } from "../../src/diarist-llm-collector.ts";
import { runDiarist } from "../../src/diarist.ts";
import {
  readTicketProvenance,
  resolveTicketProvenanceVolume,
  TicketProvenanceWatermarkError,
  type TicketProvenanceWatermarkReason,
} from "../../src/ticket-provenance.ts";

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

function watermarkFixtureBlocks() {
  return {
    a: block({
      transcript: "块 A。",
      sourceRef: { sessionFile: "/s.jsonl", entryId: "u-a" },
    }),
    b: block({
      transcript: "块 B。",
      sourceRef: { sessionFile: "/s.jsonl", entryId: "u-b" },
    }),
    later: block({
      transcript: "块 later。",
      sourceRef: { sessionFile: "/s.jsonl", entryId: "u-later" },
    }),
  };
}

async function withDiaristProject<T>(
  prefix: string,
  run: (project: string) => Promise<T>,
): Promise<T> {
  return withHermeticHome({ prefix }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);
    return run(project);
  });
}

const emptyCollector = () =>
  createScriptedDiaristCollector({
    selections: [],
    rawStdout: "{}",
    engineArgv: ["scripted"],
  });

test("runDiarist watermark: partial select advances unselected", async () => {
  await withDiaristProject("ak-diarist-wm-partial-", async (project) => {
    const { a, b, later } = watermarkFixtureBlocks();
    const seenIds: string[][] = [];
    let pass = 0;
    const collector = createScriptedDiaristCollector((input) => {
      seenIds.push(input.candidates.map((c) => String(c.sourceRef.entryId ?? "")));
      pass += 1;
      if (pass === 1) {
        return {
          selections: [{ candidateIndex: 0, quotes: [] as string[] }],
          rawStdout: "{}",
          engineArgv: ["scripted"],
        };
      }
      return {
        selections: input.candidates.map((_, i) => ({
          candidateIndex: i,
          quotes: [] as string[],
        })),
        rawStdout: "{}",
        engineArgv: ["scripted"],
      };
    });
    await runDiarist({ ticketNumber: 7, cwd: project, blocks: [a, b], collector });
    assert.deepEqual(seenIds[0]!.sort(), ["u-a", "u-b"].sort());
    const second = await runDiarist({
      ticketNumber: 7,
      cwd: project,
      blocks: [a, b, later],
      collector,
    });
    assert.deepEqual(seenIds[1], ["u-later"]);
    assert.equal(second.freshCount, 1);
  });
});

test("runDiarist watermark: empty-selection advances", async () => {
  await withDiaristProject("ak-diarist-wm-empty-", async (project) => {
    const { a, b, later } = watermarkFixtureBlocks();
    const seenIds: string[][] = [];
    const collector = createScriptedDiaristCollector((input) => {
      seenIds.push(input.candidates.map((c) => String(c.sourceRef.entryId ?? "")));
      return { selections: [], rawStdout: "{}", engineArgv: ["scripted"] };
    });
    const first = await runDiarist({
      ticketNumber: 8,
      cwd: project,
      blocks: [a, b],
      collector,
    });
    assert.equal(first.collectorStatus, "empty-selection");
    assert.equal(first.appended, 0);
    const second = await runDiarist({
      ticketNumber: 8,
      cwd: project,
      blocks: [a, b, later],
      collector,
    });
    assert.equal(second.freshCount, 1);
    assert.deepEqual(seenIds[1], ["u-later"]);
  });
});

test("runDiarist watermark: collector failure does not advance", async () => {
  await withDiaristProject("ak-diarist-wm-fail-", async (project) => {
    const { a, b } = watermarkFixtureBlocks();
    const seenIds: string[][] = [];
    let pass = 0;
    const collector = createScriptedDiaristCollector((input) => {
      seenIds.push(input.candidates.map((c) => String(c.sourceRef.entryId ?? "")));
      pass += 1;
      if (pass === 1) throw new Error("engine down");
      return {
        selections: input.candidates.map((_, i) => ({
          candidateIndex: i,
          quotes: [] as string[],
        })),
        rawStdout: "{}",
        engineArgv: ["scripted"],
      };
    });
    const first = await runDiarist({
      ticketNumber: 9,
      cwd: project,
      blocks: [a, b],
      collector,
    });
    assert.equal(first.collectorStatus, "failed");
    assert.equal(typeof first.collectorError, "string");
    assert.ok((first.collectorError?.length ?? 0) > 0);
    const second = await runDiarist({
      ticketNumber: 9,
      cwd: project,
      blocks: [a, b],
      collector,
    });
    assert.equal(second.freshCount, 2);
    assert.deepEqual(seenIds[1]!.sort(), ["u-a", "u-b"].sort());
    assert.equal(second.collectorStatus, "ok");
  });
});

const WATERMARK_CORRUPTIONS: readonly {
  readonly reason: TicketProvenanceWatermarkReason;
  readonly prepare: (path: string) => Promise<void>;
}[] = [
  {
    reason: "malformed-json",
    prepare: async (path) => {
      await writeFile(path, "{not-json\n", "utf8");
    },
  },
  {
    reason: "bad-shape",
    prepare: async (path) => {
      await writeFile(path, `${JSON.stringify({ identity: 42 })}\n`, "utf8");
    },
  },
  {
    reason: "unreadable",
    prepare: async (path) => {
      rmSync(path, { force: true });
      mkdirSync(path);
    },
  },
];

for (const corruption of WATERMARK_CORRUPTIONS) {
  test(`runDiarist watermark corrupt (${corruption.reason}) fails honestly`, async () => {
    await withDiaristProject("ak-diarist-wm-corrupt-", async (project) => {
      const { a, b } = watermarkFixtureBlocks();
      await runDiarist({
        ticketNumber: 10,
        cwd: project,
        blocks: [a],
        collector: emptyCollector(),
      });
      const { offeredWatermarkFile } = resolveTicketProvenanceVolume(10, project);
      await corruption.prepare(offeredWatermarkFile);
      await assert.rejects(
        () =>
          runDiarist({
            ticketNumber: 10,
            cwd: project,
            blocks: [a, b],
            collector: emptyCollector(),
          }),
        (error: unknown) =>
          error instanceof TicketProvenanceWatermarkError &&
          error.reason === corruption.reason &&
          error.code === "ticket-provenance-watermark",
      );
    });
  });
}

test("runDiarist second court: collector only receives blocks not yet on the volume", async () => {
  await withDiaristProject("ak-diarist-incr-", async (project) => {
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
    assert.equal(second.freshCount, 1);
    assert.equal(second.appended, 1);
    assert.deepEqual(seenIds[1], ["u-b"]);
    assert.equal(seenSizes[1], 1);

    const third = await runDiarist({
      ticketNumber: 582,
      cwd: project,
      blocks: [blockA, blockB],
      collector,
    });
    assert.equal(third.freshCount, 0);
    assert.equal(third.collectorStatus, "skipped-no-fresh");
    assert.equal(seenSizes.length, 2);

    const read = await readTicketProvenance(582, project);
    assert.equal(read.entries.length, 2);
  });
});

test("runDiarist: LLM receives blocks without ticket/keyword (no mechanical prose gate)", async () => {
  await withDiaristProject("ak-diarist-fullsrc-", async (project) => {
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
    assert.equal(seenCount, 1);
    assert.equal(result.appended, 1);
    const read = await readTicketProvenance(582, project);
    assert.equal(read.entries[0]!.transcript, anaphora);
  });
});

test("runDiarist: LLM selection reverse-verify + idempotent append + reject splice", async () => {
  await withDiaristProject("ak-diarist-", async (project) => {
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
          note: "founding",
        },
        {
          candidateIndex: 1,
          quotes: ["起居郎不管票面写不写引语抓下来"],
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
  await withDiaristProject("ak-diarist-nocoll-", async (project) => {
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
      selections:
        input.candidates.length > 0
          ? [
              {
                candidateIndex: 0,
                quotes: ["立文件。送司天台记录。"],
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
