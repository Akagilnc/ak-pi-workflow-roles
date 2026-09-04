/**
 * #582 / ADR 0075 — diarist runDiarist hermetic cases (fs + git book key).
 * Medium: local resources. Pure mechanical stays in test/unit/diarist.test.ts.
 * runDiarist enters production composition only: real cc/issue/ADR files + PATH hermes.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  packageRoot,
  seedGitRepository,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";
import {
  withPrimaryAwareCleanup,
} from "../helpers/primary-aware-cleanup.ts";
import {
  installHermesFixture,
  type HermesFixtureOptions,
} from "../helpers/hermes-fixture.ts";
import {
  DiaristSourceReadError,
  encodeClaudeProjectDir,
  readAdrDecisionKeyBlocks,
  readCcSessionBlocks,
  type DiaristIssueFace,
  type DiaristSourceBlock,
} from "../../src/diarist-mechanical.ts";
import {
  createHermesDiaristCollector,
  DIARIST_COLLECT_METHOD_RELATIVE,
  resolveDiaristCollectMethodPath,
} from "../../src/diarist-llm-collector.ts";
import { ENGINE_DETOUR_STAGED_PROMPT_TOKEN } from "../../src/engine-detour.ts";
import { runDiarist } from "../../src/diarist.ts";
import {
  appendTicketProvenanceEntry,
  readOfferedIdentities,
  readTicketProvenance,
  resolveTicketProvenanceVolume,
  TicketProvenanceWatermarkError,
  type TicketProvenanceWatermarkReason,
} from "../../src/ticket-provenance.ts";
import { TICKET_PROVENANCE_RECORD_CLASS_DIAGNOSTIC } from "../../src/ticket-provenance-contracts.ts";

function runConcurrentAppender(
  project: string,
  home: string,
  barrier: string,
): {
  readonly ready: Promise<void>;
  readonly done: Promise<void>;
  /** Own failure-path cleanup: cooperative SIGTERM, then wait for exit (no hard kill). */
  readonly settle: () => Promise<void>;
} {
  const script = `
    import { existsSync } from "node:fs";
    import { appendTicketProvenanceEntry } from ${JSON.stringify(join(packageRoot, "src/ticket-provenance.ts"))};
    process.stdout.write("ready\\n");
    while (!existsSync(${JSON.stringify(barrier)})) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
    appendTicketProvenanceEntry({
      ticketNumber: 582,
      cwd: ${JSON.stringify(project)},
      home: ${JSON.stringify(home)},
      entry: {
        sourceKind: "cc-session",
        sourceRef: { path: "same-source" },
        transcript: "same transcript",
        timestamp: "2026-08-31T00:00:00.000Z",
        basis: { method: "llm-semantic" },
      },
    });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: packageRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`concurrent appender exited ${String(code)}: ${stderr}`));
    });
  });
  const settle = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // already exiting
      }
    }
    await exited.then(
      () => undefined,
      () => undefined,
    );
  };
  return { ready, done, settle };
}

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

async function withDiaristProject<T>(
  prefix: string,
  run: (ctx: { project: string; home: string; binDir: string }) => Promise<T>,
  hermesOptions?: HermesFixtureOptions,
): Promise<T> {
  return withHermeticHome({ prefix }, async ({ home }) => {
    const binDir = join(home, "bin");
    await installHermesFixture(binDir, hermesOptions);
    const priorPath = process.env.PATH;
    process.env.PATH = `${binDir}:${priorPath ?? ""}`;
    try {
      const project = join(home, "proj");
      await mkdir(project, { recursive: true });
      seedGitRepository(project);
      return await run({ project, home, binDir });
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
    }
  });
}

/** Real cc session under hermetic ~/.claude/projects (production enum path). */
async function seedCcSession(
  home: string,
  projectCwd: string,
  entries: readonly {
    readonly uuid: string;
    readonly content: string;
    readonly timestamp?: string;
  }[],
  fileName = "sess.jsonl",
): Promise<string> {
  const sessionDir = join(
    home,
    ".claude",
    "projects",
    encodeClaudeProjectDir(projectCwd),
  );
  await mkdir(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, fileName);
  const lines = entries.map((entry) =>
    JSON.stringify({
      type: "user",
      uuid: entry.uuid,
      timestamp: entry.timestamp ?? "2026-08-31T00:00:00.000Z",
      message: { role: "user", content: entry.content },
    }),
  );
  await writeFile(sessionFile, `${lines.join("\n")}\n`, "utf8");
  return sessionFile;
}

test("shared Sitian volume commits one row for concurrent identical identities", async () => {
  await withDiaristProject("diarist-concurrent-", async ({ project, home }) => {
    const barrier = join(home, "append.barrier");
    const children: Array<ReturnType<typeof runConcurrentAppender>> = [];
    await withPrimaryAwareCleanup(
      async () => {
        for (let i = 0; i < 8; i += 1) {
          children.push(runConcurrentAppender(project, home, barrier));
        }
        await Promise.all(children.map(({ ready }) => ready));
        await writeFile(barrier, "go\n", "utf8");
        await Promise.all(children.map(({ done }) => done));

        const volume = await readTicketProvenance(582, project, home);
        assert.equal(volume.entries.length, 1);
      },
      async () => {
        // Fixture owns every child it created — barrier/setup failure must not strand them.
        await Promise.all(children.map(({ settle }) => settle()));
      },
    );
  });
});

test("runDiarist always establishes volume + md (empty court)", async () => {
  await withDiaristProject("ak-diarist-empty-vol-", async ({ project, home }) => {
    const result = await runDiarist({
      ticketNumber: 1,
      cwd: project,
          home,
      packageRoot,
    });
    assert.equal(result.collectorStatus, "skipped-no-fresh");
    assert.equal(result.appended, 0);
    await access(result.volumeRecordFile);
    await access(result.humanViewFile);
    const read = await readTicketProvenance(1, project, home);
    assert.equal(read.entries.length, 0);
  });
});

test("runDiarist: collector failure does not advance watermark; true cause appends as typed diagnostic", async () => {
  await withDiaristProject(
    "ak-diarist-fail-diag-",
    async ({ project, home, binDir }) => {
      await seedCcSession(home, project, [
        { uuid: "u-a", content: "块 A。" },
        { uuid: "u-b", content: "块 B。" },
      ]);

      const first = await runDiarist({
        ticketNumber: 9,
        cwd: project,
          home,
        packageRoot,
      });
      assert.equal(first.collectorStatus, "failed");
      assert.ok(
        first.collectorError !== undefined && first.collectorError.length > 0,
      );
      const diary = await readTicketProvenance(9, project, home);
      assert.equal(diary.entries.length, 0);
      assert.equal(diary.diagnostics.length, 1);
      assert.equal(
        diary.diagnostics[0]!.recordClass,
        TICKET_PROVENANCE_RECORD_CLASS_DIAGNOSTIC,
      );
      assert.equal(diary.diagnostics[0]!.diagnosticKind, "collector-failed");
      assert.equal(diary.diagnostics[0]!.cause, first.collectorError);
      const rawPayload = diary.records.find(
        (r) =>
          (r.payload as { recordClass?: string } | undefined)?.recordClass ===
          TICKET_PROVENANCE_RECORD_CLASS_DIAGNOSTIC,
      )?.payload as Record<string, unknown>;
      assert.equal(rawPayload.sourceKind, undefined);
      await access(first.humanViewFile);
      assert.equal(readOfferedIdentities(9, project, home).size, 0);

      // Reinstall PATH hermes so the retry court crosses a real successful collector.
      await installHermesFixture(binDir, { selectAllCandidates: true });
      const second = await runDiarist({
        ticketNumber: 9,
        cwd: project,
          home,
        packageRoot,
      });
      assert.equal(second.freshCount, 2);
      assert.equal(second.collectorStatus, "ok");
      assert.equal(second.appended, 2);

      const afterOk = await readTicketProvenance(9, project, home);
      assert.equal(afterOk.diagnostics.length, 1);
      assert.equal(afterOk.diagnostics[0]!.diagnosticKind, "collector-failed");
      assert.equal(afterOk.entries.length, 2);
    },
    { defaultExitCode: 2 },
  );
});

test("runDiarist watermark: empty-selection advances; partial/second-court only sees fresh", async () => {
  await withDiaristProject(
    "ak-diarist-wm-",
    async ({ project, home, binDir }) => {
      await seedCcSession(home, project, [
        { uuid: "u-a", content: "块 A。" },
        { uuid: "u-b", content: "块 B。" },
      ]);

      // Partial select: unselected still watermarked with selected.
      await installHermesFixture(binDir, {
        collectorResponse: {
          selections: [{ candidateIndex: 0, quotes: [] as string[] }],
        },
      });
      const first = await runDiarist({
        ticketNumber: 7,
        cwd: project,
          home,
        packageRoot,
      });
      assert.equal(first.freshCount, 2);
      assert.equal(first.collectorStatus, "ok");
      assert.equal(first.appended, 1);
      assert.equal(readOfferedIdentities(7, project, home).size, 2);

      // New block only offered; empty selection advances its watermark.
      await seedCcSession(home, project, [
        { uuid: "u-a", content: "块 A。" },
        { uuid: "u-b", content: "块 B。" },
        { uuid: "u-later", content: "块 later。" },
      ]);
      await installHermesFixture(binDir, {
        collectorResponse: { selections: [] },
      });
      const second = await runDiarist({
        ticketNumber: 7,
        cwd: project,
          home,
        packageRoot,
      });
      assert.equal(second.freshCount, 1);
      assert.equal(second.collectorStatus, "empty-selection");
      assert.equal(second.appended, 0);
      assert.equal(readOfferedIdentities(7, project, home).size, 3);

      // Same set after empty-selection: no re-offer (watermark advanced).
      const third = await runDiarist({
        ticketNumber: 7,
        cwd: project,
          home,
        packageRoot,
      });
      assert.equal(third.freshCount, 0);
      assert.equal(third.collectorStatus, "skipped-no-fresh");
    },
  );
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
    await withDiaristProject(
      "ak-diarist-wm-corrupt-",
      async ({ project, home }) => {
        await seedCcSession(home, project, [
          { uuid: "u-a", content: "块 A。" },
        ]);
        await runDiarist({
          ticketNumber: 10,
          cwd: project,
          home,
          packageRoot,
        });
        const { offeredWatermarkFile } = resolveTicketProvenanceVolume(
          10,
          project,
          home,
        );
        await corruption.prepare(offeredWatermarkFile);
        await seedCcSession(home, project, [
          { uuid: "u-a", content: "块 A。" },
          { uuid: "u-b", content: "块 B。" },
        ]);
        await assert.rejects(
          () =>
            runDiarist({
              ticketNumber: 10,
              cwd: project,
          home,
              packageRoot,
            }),
          (error: unknown) =>
            error instanceof TicketProvenanceWatermarkError &&
            error.reason === corruption.reason &&
            error.code === "ticket-provenance-watermark",
        );
      },
      { collectorResponse: { selections: [] } },
    );
  });
}

test("runDiarist: LLM receives blocks without ticket/keyword (no mechanical prose gate)", async () => {
  await withDiaristProject(
    "ak-diarist-fullsrc-",
    async ({ project, home }) => {
      const anaphora = "自动跑就行，先这样。";
      await seedCcSession(home, project, [
        { uuid: "u-ana", content: anaphora },
      ]);
      const result = await runDiarist({
        ticketNumber: 582,
        cwd: project,
          home,
        packageRoot,
      });
      assert.equal(result.freshCount, 1);
      assert.equal(result.appended, 1);
      const read = await readTicketProvenance(582, project, home);
      assert.equal(read.entries[0]!.transcript, anaphora);
    },
    { selectAllCandidates: true },
  );
});

test("runDiarist: LLM selection reverse-verify + idempotent append + reject splice", async () => {
  await withDiaristProject(
    "ak-diarist-",
    async ({ project, home }) => {
      const good =
        "立文件。送司天台记录。所以每个票都应该有的一份文档。";
      const bad =
        "起居郎不管票面写不写引语，只负责把这个issue的决策相关抓下来。";
      await seedCcSession(home, project, [
        { uuid: "u-good", content: good },
        { uuid: "u-2", content: bad },
      ]);

      const face: DiaristIssueFace = {
        body: "「立文件。送司天台记录。」",
        bodyUrl: "https://github.com/o/r/issues/582",
        comments: [],
      };

      const first = await runDiarist({
        ticketNumber: 582,
        cwd: project,
          home,
        packageRoot,
        issueFace: face,
      });
      // cc(2) + body + decree = 4 candidates; fixture picks good + spliced bad only.
      assert.equal(first.collectorStatus, "ok");
      assert.equal(first.appended, 1);
      assert.equal(first.rejectedQuotes, 1);
      await access(first.humanViewFile);

      const read1 = await readTicketProvenance(582, project, home);
      assert.equal(read1.entries.length, 1);
      assert.equal(read1.entries[0]!.basis.method, "llm-semantic");
      assert.equal(read1.entries[0]!.transcript, good);
      assert.ok(read1.entries[0]!.basis.anchors?.includes("#582"));
      assert.ok(
        read1.entries[0]!.basis.anchors?.includes("立文件。送司天台记录。"),
      );
      assert.ok(
        read1.diagnostics.some((d) => d.diagnosticKind === "quote-verify-failed"),
      );

      const beforeRecords = read1.records.length;
      appendTicketProvenanceEntry({
        ticketNumber: 582,
        cwd: project,
        home,
        entry: read1.entries[0]!,
      });
      const afterIdem = await readTicketProvenance(582, project, home);
      assert.equal(afterIdem.records.length, beforeRecords);
      assert.equal(afterIdem.entries.length, 1);

      const second = await runDiarist({
        ticketNumber: 582,
        cwd: project,
          home,
        packageRoot,
        issueFace: face,
      });
      assert.equal(second.freshCount, 0);
      assert.equal(second.collectorStatus, "skipped-no-fresh");
      assert.equal(second.appended, 0);
      const read2 = await readTicketProvenance(582, project, home);
      assert.equal(read2.entries.length, 1);
    },
    {
      collectorResponse: {
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
      },
    },
  );
});

test("runDiarist enumerates issue face + comments + ADR + cc into candidate stream", async () => {
  await withDiaristProject(
    "ak-diarist-sources-",
    async ({ project, home }) => {
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
      await seedCcSession(home, project, [
        { uuid: "u-cc", content: "cc turn about 起居录" },
      ]);

      const result = await runDiarist({
        ticketNumber: 99,
        cwd: project,
          home,
        packageRoot,
        issueFace: face,
      });
      assert.ok(result.candidateCount >= 4);
      assert.equal(result.collectorStatus, "ok");
      assert.ok(result.appended >= 4);

      const volume = await readTicketProvenance(99, project, home);
      const kindsSeen = new Set(volume.entries.map((e) => e.sourceKind));
      const refs = volume.entries.map((e) => e.sourceRef);
      assert.ok(kindsSeen.has("cc-session"));
      assert.ok(kindsSeen.has("issue-body-comment"));
      assert.ok(kindsSeen.has("ticket-decree-block"));
      assert.ok(kindsSeen.has("adr-decision-key"));
      assert.ok(refs.some((r) => r.url === "https://github.com/o/r/issues/99"));
      assert.ok(refs.some((r) => r.entryId === 42));
      assert.ok(refs.some((r) => r.path === adrRel));
      assert.ok(refs.some((r) => r.entryId === "u-cc"));
    },
    { selectAllCandidates: true },
  );
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

test("hermes collector argv: empty toolset boundary (never terminal/process tools)", async () => {
  await withHermeticHome({ prefix: "ak-diarist-toolset-" }, async ({ home }) => {
    const capturePath = join(home, "captured-argv.json");
    const childScript = join(home, "hermes-child.js");
    await writeFile(
      childScript,
      [
        "const { writeFileSync } = require('node:fs');",
        "writeFileSync(process.env.AK_CAPTURE_PATH, JSON.stringify(process.argv), 'utf8');",
        "process.stdout.write(JSON.stringify({ selections: [] }));",
      ].join("\n"),
      "utf8",
    );
    const collector = createHermesDiaristCollector({
      packageRoot,
      executable: process.execPath,
      extraArgv: [childScript],
      env: { ...process.env, AK_CAPTURE_PATH: capturePath },
      cwd: home,
    });
    const result = await collector({
      ticketNumber: 582,
      candidates: [
        block({
          transcript: "untrusted ticket text",
          sourceRef: { sessionFile: "/s", entryId: "1" },
        }),
      ],
    });
    const capturedArgv = JSON.parse(await readFile(capturePath, "utf8")) as string[];
    assert.ok(capturedArgv);
    // Independent of production constant: hermes `context_engine` resolves to
    // zero tools; terminal/file/web must not appear as enabled toolsets.
    const toolFlagAt = capturedArgv.indexOf("-t");
    assert.ok(toolFlagAt >= 0, "collector must pin an explicit toolset");
    assert.equal(capturedArgv[toolFlagAt + 1], "context_engine");
    for (const banned of ["terminal", "file", "web", "hermes-cli", "coding", "safe"] as const) {
      assert.equal(
        capturedArgv.includes(banned),
        false,
        `${banned} toolset must not be enabled on untrusted ticket text`,
      );
    }
    assert.deepEqual(result.engineArgv, [
      process.execPath,
      childScript,
      "chat",
      "--query-file",
      ENGINE_DETOUR_STAGED_PROMPT_TOKEN,
      "-Q",
      "--no-restore-cwd",
      "--ignore-rules",
      "-t",
      "context_engine",
    ]);
  });
});

test("runDiarist: mid-batch volume failure keeps partial commits; retry is idempotent", async () => {
  await withDiaristProject(
    "ak-diarist-wm-order-",
    async ({ project, home, binDir }) => {
      // Seed mid-batch prefix via production path: A entry + B quote diagnostic.
      await seedCcSession(home, project, [
        { uuid: "u-a", content: "块 A 可入录。" },
        { uuid: "u-b", content: "块 B 无此引文。" },
      ]);
      await installHermesFixture(binDir, {
        collectorResponse: {
          selections: [
            { candidateIndex: 0, quotes: [] as string[] },
            { candidateIndex: 1, quotes: ["绝不会出现的引文"] },
          ],
        },
      });
      await runDiarist({
        ticketNumber: 11,
        cwd: project,
          home,
        packageRoot,
      });

      const volume = resolveTicketProvenanceVolume(11, project, home);
      // Drop offered watermark so uncommitted blocks are re-offered (simulates
      // crash after partial volume commits, before watermark).
      if (existsSync(volume.offeredWatermarkFile)) {
        rmSync(volume.offeredWatermarkFile);
      }

      await seedCcSession(home, project, [
        { uuid: "u-a", content: "块 A 可入录。" },
        { uuid: "u-b", content: "块 B 无此引文。" },
        { uuid: "u-c", content: "块 C 可入录。" },
      ]);
      // B fails quote again; C appends. Freeze volume so C fails at sitian IO.
      await installHermesFixture(binDir, {
        collectorResponse: {
          selections: [
            { candidateIndex: 0, quotes: ["绝不会出现的引文"] },
            { candidateIndex: 1, quotes: [] as string[] },
          ],
        },
      });
      chmodSync(volume.recordFile, 0o444);
      try {
        await assert.rejects(() =>
          runDiarist({
            ticketNumber: 11,
            cwd: project,
          home,
            packageRoot,
          }),
        );
      } finally {
        chmodSync(volume.recordFile, 0o644);
      }

      const partial = await readTicketProvenance(11, project, home);
      assert.equal(partial.entries.length, 1);
      assert.equal(partial.entries[0]!.sourceRef.entryId, "u-a");
      assert.equal(partial.diagnostics.length, 1);
      assert.equal(partial.diagnostics[0]!.diagnosticKind, "quote-verify-failed");
      assert.equal(readOfferedIdentities(11, project, home).size, 0);

      // Retry: A filtered by volume; B (quote residue) + C re-offered.
      await installHermesFixture(binDir, {
        collectorResponse: {
          selections: [
            { candidateIndex: 0, quotes: ["绝不会出现的引文"] },
            { candidateIndex: 1, quotes: [] as string[] },
          ],
        },
      });
      const second = await runDiarist({
        ticketNumber: 11,
        cwd: project,
          home,
        packageRoot,
      });
      assert.equal(second.freshCount, 2);
      assert.equal(second.collectorStatus, "ok");
      const final = await readTicketProvenance(11, project, home);
      assert.equal(final.entries.length, 2);
      assert.deepEqual(
        final.entries.map((e) => e.sourceRef.entryId).sort(),
        ["u-a", "u-c"].sort(),
      );
      assert.equal(final.diagnostics.length, 1);
      assert.equal(final.diagnostics[0]!.diagnosticKind, "quote-verify-failed");
      assert.equal(readOfferedIdentities(11, project, home).size, 2);
    },
  );
});

test("hermes collector: real child receives method bytes via seam-staged --query-file (1MiB safe)", async () => {
  await withHermeticHome({ prefix: "ak-diarist-method-qf-" }, async ({ home }) => {
    const methodPath = resolveDiaristCollectMethodPath(packageRoot);
    assert.equal(methodPath.endsWith(DIARIST_COLLECT_METHOD_RELATIVE), true);
    accessSync(methodPath, fsConstants.R_OK);
    // File is sole source of truth — expected delivery is its current bytes.
    const methodBytes = await readFile(methodPath, "utf8");
    assert.ok(methodBytes.trim().length > 0);

    const capturePath = join(home, "method-payload-capture.json");
    const childScript = join(home, "engine-child.mjs");
    // Real subprocess on the detour seam: read staged --query-file body (not argv blob).
    // 1MiB candidates are the E2BIG boundary — one trunk proves delivery + size + cleanup.
    await writeFile(
      childScript,
      [
        "import { readFileSync, writeFileSync, statSync } from 'node:fs';",
        "const qf = process.argv.indexOf('--query-file');",
        "const path = qf >= 0 ? process.argv[qf + 1] : undefined;",
        "let method = null;",
        "let methodPath = null;",
        "let candidateCount = null;",
        "let size = 0;",
        "let argvHasPromptBlob = false;",
        "try {",
        "  size = path ? statSync(path).size : 0;",
        "  const raw = path ? readFileSync(path, 'utf8') : undefined;",
        "  const payload = JSON.parse(raw);",
        "  method = typeof payload?.method === 'string' ? payload.method : null;",
        "  methodPath = typeof payload?.methodPath === 'string' ? payload.methodPath : null;",
        "  candidateCount = Array.isArray(payload?.candidates) ? payload.candidates.length : null;",
        "  argvHasPromptBlob = process.argv.some((a) => typeof a === 'string' && a.includes('\"method\"'));",
        "} catch {}",
        "writeFileSync(process.env.AK_CAPTURE_PATH, JSON.stringify({ method, methodPath, candidateCount, size, argvHasPromptBlob, queryFilePath: path ?? null }), 'utf8');",
        "process.stdout.write(JSON.stringify({ selections: [] }));",
        "",
      ].join("\n"),
      "utf8",
    );

    // ~1.2 MiB candidate bodies — formerly single-argv E2BIG; now staged by the seam.
    const big = "X".repeat(600_000);
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
          transcript: big,
          sourceRef: { sessionFile: "/s", entryId: "1" },
        }),
        block({
          transcript: big,
          sourceRef: { sessionFile: "/s", entryId: "2" },
        }),
      ],
    });
    const captured = JSON.parse(await readFile(capturePath, "utf8")) as {
      method: string | null;
      methodPath: string | null;
      candidateCount: number | null;
      size: number;
      argvHasPromptBlob: boolean;
      queryFilePath: string | null;
    };
    // External visible: engine child received method material bytes from staged file.
    assert.equal(captured.method, methodBytes);
    assert.equal(captured.candidateCount, 2);
    assert.ok(captured.size > 1_000_000);
    assert.ok(captured.queryFilePath);
    // Seam-owned lifecycle: staged prompt file is gone after collector returns.
    assert.equal(existsSync(captured.queryFilePath), false);
    // Coordinate-only transport must not reappear as the delivery claim.
    assert.equal(captured.methodPath, null);
    // Body must not ride argv (E2BIG root cause).
    assert.equal(captured.argvHasPromptBlob, false);
  });
});

test("referenced ADR path escape fails typed at real IO seam (not silent read)", async () => {
  await withHermeticHome({ prefix: "ak-diarist-adr-esc-" }, async ({ home }) => {
    const root = join(home, "src-root");
    mkdirSync(root, { recursive: true });
    const secret = join(home, "secret.md");
    writeFileSync(secret, "TOP SECRET\n", "utf8");
    assert.throws(
      () =>
        readAdrDecisionKeyBlocks({
          cwd: root,
          adrPaths: ["docs/adr/a/../../../../secret.md"],
        }),
      (error: unknown) =>
        error instanceof DiaristSourceReadError &&
        error.reason === "adr-escape" &&
        error.code === "diarist-source-read",
    );
    // Sibling escape via absolute-looking relative must also fail closed.
    assert.throws(
      () =>
        readAdrDecisionKeyBlocks({
          cwd: root,
          adrPaths: ["../secret.md"],
        }),
      (error: unknown) =>
        error instanceof DiaristSourceReadError && error.reason === "adr-escape",
    );

    // In-repo but outside docs/adr: cwd-bounded is not enough (ADR root confinement).
    writeFileSync(join(root, "README.md"), "# not an ADR\n", "utf8");
    mkdirSync(join(root, "docs", "adr"), { recursive: true });
    assert.throws(
      () =>
        readAdrDecisionKeyBlocks({
          cwd: root,
          adrPaths: ["docs/adr/x/../../README.md"],
        }),
      (error: unknown) =>
        error instanceof DiaristSourceReadError &&
        error.reason === "adr-escape" &&
        error.code === "diarist-source-read",
    );

    // Physical escape: cwd-internal symlink whose realpath leaves the ADR root.
    // Lexical pathContainedIn passes; physicallyContainedIn must refuse before read.
    const outside = join(home, "outside-secret.md");
    writeFileSync(outside, "TOP SECRET\n", "utf8");
    const linkRel = "docs/adr/0075-via-symlink.md";
    symlinkSync(outside, join(root, linkRel));
    assert.throws(
      () =>
        readAdrDecisionKeyBlocks({
          cwd: root,
          adrPaths: [linkRel],
        }),
      (error: unknown) =>
        error instanceof DiaristSourceReadError &&
        error.reason === "adr-escape" &&
        error.code === "diarist-source-read",
    );
  });
});
