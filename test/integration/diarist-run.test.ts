/**
 * #582 / ADR 0075 — diarist runDiarist hermetic cases (fs + git book key).
 * Medium: local resources. Pure mechanical stays in test/unit/diarist.test.ts.
 */
import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  seedGitRepository,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";
import {
  DiaristSourceReadError,
  readAdrDecisionKeyBlocks,
  readCcSessionBlocks,
  type DiaristIssueFace,
  type DiaristSourceBlock,
} from "../../src/diarist-mechanical.ts";
import {
  createHermesDiaristCollector,
  createScriptedDiaristCollector,
  DIARIST_COLLECT_METHOD_RELATIVE,
  resolveDiaristCollectMethodPath,
} from "../../src/diarist-llm-collector.ts";
import { accessSync, constants as fsConstants } from "node:fs";
import { runDiarist } from "../../src/diarist.ts";
import {
  appendTicketProvenanceEntry,
  readTicketProvenance,
  resolveTicketProvenanceVolume,
  TicketProvenanceWatermarkError,
  type TicketProvenanceWatermarkReason,
} from "../../src/ticket-provenance.ts";
import { TICKET_PROVENANCE_RECORD_CLASS_DIAGNOSTIC } from "../../src/ticket-provenance-contracts.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

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
    rawStdout: '{"selections":[]}',
    engineArgv: ["scripted"],
  });

test("runDiarist always establishes volume + md (empty court)", async () => {
  await withDiaristProject("ak-diarist-empty-vol-", async (project) => {
    const result = await runDiarist({
      ticketNumber: 1,
      cwd: project,
      blocks: [],
      collector: emptyCollector(),
    });
    assert.equal(result.collectorStatus, "skipped-no-fresh");
    assert.equal(result.appended, 0);
    await access(result.volumeRecordFile);
    await access(result.humanViewFile);
    const read = await readTicketProvenance(1, project);
    assert.equal(read.entries.length, 0);
  });
});

test("runDiarist: collector failure does not advance watermark; true cause appends as typed diagnostic", async () => {
  await withDiaristProject("ak-diarist-fail-diag-", async (project) => {
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
        rawStdout: '{"selections":[]}',
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
    assert.equal(first.collectorError, "engine down");
    // Typed diagnostic on same partition — not a forged diary entry.
    const diary = await readTicketProvenance(9, project);
    assert.equal(diary.entries.length, 0);
    assert.equal(diary.diagnostics.length, 1);
    assert.equal(diary.diagnostics[0]!.recordClass, TICKET_PROVENANCE_RECORD_CLASS_DIAGNOSTIC);
    assert.equal(diary.diagnostics[0]!.diagnosticKind, "collector-failed");
    assert.equal(diary.diagnostics[0]!.cause, "engine down");
    // Payload must not pretend to be a source entry.
    const rawPayload = diary.records.find(
      (r) =>
        (r.payload as { recordClass?: string } | undefined)?.recordClass ===
        TICKET_PROVENANCE_RECORD_CLASS_DIAGNOSTIC,
    )?.payload as Record<string, unknown>;
    assert.equal(rawPayload.sourceKind, undefined);
    await access(first.humanViewFile);

    const second = await runDiarist({
      ticketNumber: 9,
      cwd: project,
      blocks: [a, b],
      collector,
    });
    assert.equal(second.freshCount, 2);
    assert.deepEqual(seenIds[1]!.sort(), ["u-a", "u-b"].sort());
    assert.equal(second.collectorStatus, "ok");

    // Second court success must not erase the prior failure row (history).
    const afterOk = await readTicketProvenance(9, project);
    assert.equal(afterOk.diagnostics.length, 1);
    assert.equal(afterOk.diagnostics[0]!.diagnosticKind, "collector-failed");
  });
});

test("runDiarist watermark: empty-selection advances; partial/second-court only sees fresh", async () => {
  await withDiaristProject("ak-diarist-wm-", async (project) => {
    const { a, b, later } = watermarkFixtureBlocks();
    const seenIds: string[][] = [];
    let pass = 0;
    const collector = createScriptedDiaristCollector((input) => {
      seenIds.push(input.candidates.map((c) => String(c.sourceRef.entryId ?? "")));
      pass += 1;
      if (pass === 1) {
        // Partial select: unselected still watermarked with selected.
        return {
          selections: [{ candidateIndex: 0, quotes: [] as string[] }],
          rawStdout: "{}",
          engineArgv: ["scripted"],
        };
      }
      // Empty selection must still advance the offered watermark.
      return {
        selections: [],
        rawStdout: '{"selections":[]}',
        engineArgv: ["scripted"],
      };
    });

    const first = await runDiarist({
      ticketNumber: 7,
      cwd: project,
      blocks: [a, b],
      collector,
    });
    assert.deepEqual(seenIds[0]!.sort(), ["u-a", "u-b"].sort());
    assert.equal(first.collectorStatus, "ok");

    // New block only offered; empty selection advances its watermark.
    const second = await runDiarist({
      ticketNumber: 7,
      cwd: project,
      blocks: [a, b, later],
      collector,
    });
    assert.deepEqual(seenIds[1], ["u-later"]);
    assert.equal(second.freshCount, 1);
    assert.equal(second.collectorStatus, "empty-selection");
    assert.equal(second.appended, 0);

    // Same set after empty-selection: no re-offer (watermark advanced).
    const third = await runDiarist({
      ticketNumber: 7,
      cwd: project,
      blocks: [a, b, later],
      collector,
    });
    assert.equal(third.freshCount, 0);
    assert.equal(third.collectorStatus, "skipped-no-fresh");
    assert.equal(seenIds.length, 2, "collector must not be called after empty-selection watermark");
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

    const face: DiaristIssueFace = {
      body: "「立文件。送司天台记录。」",
      bodyUrl: "https://github.com/o/r/issues/582",
      comments: [],
    };

    const first = await runDiarist({
      ticketNumber: 582,
      cwd: project,
      blocks,
      collector,
      issueFace: face,
    });
    assert.equal(first.collectorStatus, "ok");
    assert.equal(first.appended, 1);
    assert.equal(first.rejectedQuotes, 1);
    await access(first.humanViewFile);

    const read1 = await readTicketProvenance(582, project);
    assert.equal(read1.entries.length, 1);
    assert.equal(read1.entries[0]!.basis.method, "llm-semantic");
    assert.equal(read1.entries[0]!.transcript, good);
    // Splice residue stays on the volume but is not a diary body row.
    assert.ok(read1.skipped >= 1);
    assert.equal(
      read1.records.some(
        (r) =>
          (r.payload as { basis?: { method?: string } } | undefined)?.basis
            ?.method === "quote-verify-failed",
      ),
      true,
    );

    // Direct append of the same body entry is identity-idempotent (no second row).
    const beforeRecords = read1.records.length;
    appendTicketProvenanceEntry({
      ticketNumber: 582,
      cwd: project,
      entry: read1.entries[0]!,
    });
    const afterIdem = await readTicketProvenance(582, project);
    assert.equal(afterIdem.records.length, beforeRecords);
    assert.equal(afterIdem.entries.length, 1);

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

test("runDiarist enumerates issue face + comments + ADR + cc into candidate stream", async () => {
  await withDiaristProject("ak-diarist-sources-", async (project) => {
    const adrRel = "docs/adr/0075-ticket-provenance-diarist-pipeline.md";
    await mkdir(join(project, "docs", "adr"), { recursive: true });
    await writeFile(
      join(project, adrRel),
      "# 0075\n\n| `ticket-provenance-file` | 每票一份 |\n",
      "utf8",
    );
    const face: DiaristIssueFace = {
      body: ["「立文件。送司天台记录。」", `see ${adrRel}`].join("\n"),
      bodyUrl: "https://github.com/o/r/issues/99",
      comments: [
        {
          id: 42,
          body: "评论：确认先起居郎。",
          createdAt: "2026-08-31T11:00:00.000Z",
          htmlUrl: "https://github.com/o/r/issues/99#issuecomment-42",
        },
      ],
    };

    const projectsRoot = join(project, "cc-root");
    const sessionDir = join(projectsRoot, "-work");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "sess.jsonl"),
      `${JSON.stringify({
        type: "user",
        uuid: "u-cc",
        timestamp: "2026-08-31T10:00:00.000Z",
        message: { role: "user", content: "cc turn about 起居录" },
      })}\n`,
      "utf8",
    );

    const kindsSeen = new Set<string>();
    const refs: string[] = [];
    const collector = createScriptedDiaristCollector((input) => {
      for (const c of input.candidates) {
        kindsSeen.add(c.sourceKind);
        if (c.sourceRef.url !== undefined) refs.push(c.sourceRef.url);
        if (c.sourceRef.entryId !== undefined) refs.push(String(c.sourceRef.entryId));
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

    const result = await runDiarist({
      ticketNumber: 99,
      cwd: project,
      issueFace: face,
      sessionCwds: ["/work"],
      projectsRoot,
      collector,
    });
    assert.ok(result.candidateCount >= 4);
    assert.ok(kindsSeen.has("cc-session"));
    assert.ok(kindsSeen.has("issue-body-comment"));
    assert.ok(kindsSeen.has("ticket-decree-block"));
    assert.ok(kindsSeen.has("adr-decision-key"));
    assert.ok(refs.includes("https://github.com/o/r/issues/99"));
    assert.ok(refs.includes("42"));
    assert.equal(result.collectorStatus, "ok");
  });
});

test("referenced ADR missing fails typed (not silent skip)", async () => {
  await withHermeticHome({ prefix: "ak-diarist-adr-miss-" }, async ({ home }) => {
    const root = join(home, "src-root");
    mkdirSync(root, { recursive: true });
    assert.throws(
      () =>
        readAdrDecisionKeyBlocks({
          cwd: root,
          adrPaths: ["docs/adr/0075-ticket-provenance-diarist-pipeline.md"],
        }),
      (error: unknown) =>
        error instanceof DiaristSourceReadError &&
        error.reason === "adr-missing" &&
        error.code === "diarist-source-read",
    );
  });
});

const SOURCE_READ_FAILURES: readonly {
  readonly reason: DiaristSourceReadError["reason"];
  readonly run: (root: string) => void;
}[] = [
  {
    reason: "jsonl-line-unparseable",
    run: (root) => {
      const sessionDir = join(root, "-work");
      mkdirSync(sessionDir, { recursive: true });
      // Non-empty line that is not JSON — must not wash into empty blocks.
      writeFileSync(join(sessionDir, "bad.jsonl"), "{not-json\n", "utf8");
      readCcSessionBlocks({ projectsRoot: root, cwds: ["/work"] });
    },
  },
  {
    reason: "file-unreadable",
    run: (root) => {
      const sessionDir = join(root, "-work");
      mkdirSync(sessionDir, { recursive: true });
      const sessionFile = join(sessionDir, "dir-as-file.jsonl");
      mkdirSync(sessionFile);
      readCcSessionBlocks({ projectsRoot: root, cwds: ["/work"] });
    },
  },
  {
    reason: "adr-unreadable",
    run: (root) => {
      const adrRel = "docs/adr/0075-ticket-provenance-diarist-pipeline.md";
      const abs = join(root, adrRel);
      mkdirSync(join(root, "docs", "adr"), { recursive: true });
      mkdirSync(abs); // path exists but is a directory → readFile fails
      readAdrDecisionKeyBlocks({ cwd: root, adrPaths: [adrRel] });
    },
  },
];

for (const failure of SOURCE_READ_FAILURES) {
  test(`source read failure (${failure.reason}) throws typed DiaristSourceReadError`, async () => {
    await withHermeticHome({ prefix: "ak-diarist-src-fail-" }, async ({ home }) => {
      const root = join(home, "src-root");
      mkdirSync(root, { recursive: true });
      assert.throws(
        () => failure.run(root),
        (error: unknown) =>
          error instanceof DiaristSourceReadError &&
          error.reason === failure.reason &&
          error.code === "diarist-source-read",
      );
    });
  });
}

test("hermes collector: real child reads methodPath from structured -z engine payload", async () => {
  await withHermeticHome({ prefix: "ak-diarist-method-z-" }, async ({ home }) => {
    const methodPath = resolveDiaristCollectMethodPath(packageRoot);
    assert.equal(methodPath.endsWith(DIARIST_COLLECT_METHOD_RELATIVE), true);
    accessSync(methodPath, fsConstants.R_OK);

    const capturePath = join(home, "method-payload-capture.json");
    const childScript = join(home, "engine-child.mjs");
    // Real subprocess on the detour seam: parse -z argv JSON payload.methodPath.
    await writeFile(
      childScript,
      [
        "import { writeFileSync } from 'node:fs';",
        "const z = process.argv.indexOf('-z');",
        "const raw = z >= 0 ? process.argv[z + 1] : undefined;",
        "let methodPath = null;",
        "try {",
        "  const payload = JSON.parse(raw);",
        "  methodPath = typeof payload?.methodPath === 'string' ? payload.methodPath : null;",
        "} catch {}",
        "writeFileSync(process.env.AK_CAPTURE_PATH, JSON.stringify({ methodPath }), 'utf8');",
        "process.stdout.write(JSON.stringify({ selections: [] }));",
        "",
      ].join("\n"),
      "utf8",
    );

    const collector = createHermesDiaristCollector({
      packageRoot,
      executable: process.execPath,
      extraArgv: [childScript],
      env: { ...process.env, AK_CAPTURE_PATH: capturePath },
      // Real runEngineDetourOnce — no runDetour inject.
    });
    await collector({
      ticketNumber: 582,
      candidates: [
        block({
          transcript: "立文件",
          sourceRef: { sessionFile: "/s", entryId: "1" },
        }),
      ],
    });
    const captured = JSON.parse(await readFile(capturePath, "utf8")) as {
      methodPath: string | null;
    };
    // External visible: engine child received methodPath on structured -z payload.
    assert.equal(captured.methodPath, methodPath);
  });
});

test("runDiarist without collector still establishes empty volume (no mechanical-only)", async () => {
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
    await access(result.volumeRecordFile);
    await access(result.humanViewFile);
    const read = await readTicketProvenance(1, project);
    assert.equal(read.entries.length, 0);
  });
});
