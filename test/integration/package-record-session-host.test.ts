/**
 * #1178: side-branch records use the package writer — no pi runtime import.
 * Seam: createRecordSession / createRecordSessionOpen (sole archivist entry).
 */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  createRecordSession,
  createRecordSessionOpen,
  WORKER_SUBMISSION_GATE_KIND,
} from "../../src/archivist-record-entry.ts";
import {
  machineLedgerHome,
  seedGitRepository,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";

function sessionHeaderLine(id: string, cwd: string, parentSession?: string): string {
  return `${JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-09-01T00:00:00.000Z",
    cwd,
    ...(parentSession === undefined ? {} : { parentSession }),
  })}\n`;
}

test("#1178 createRecordSession writes pi JSONL v3 with parentSession and custom entries", async () => {
  await withHermeticHome({ prefix: "ak-pkg-record-shape-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const parentDir = join(
      machineLedgerHome(home),
      "books",
      "proj",
      "1178",
      "runs",
      "r@coder",
      "session",
    );
    await mkdir(parentDir, { recursive: true });
    const parentFile = join(parentDir, "session.jsonl");
    await writeFile(parentFile, sessionHeaderLine("parent-1178", project));

    const child = createRecordSession({
      cwd: project,
      kind: WORKER_SUBMISSION_GATE_KIND,
      parent: { getSessionFile: () => parentFile },
    });

    const file = child.getSessionFile();
    assert.ok(file, "persisted child must name a session file");
    assert.equal(child.isPersisted(), true);
    assert.equal(child.getSessionDir(), join(parentDir, WORKER_SUBMISSION_GATE_KIND));

    const raw = await readFile(file, "utf8");
    const lines = raw.trim().split("\n");
    const header = JSON.parse(lines[0]!) as {
      type: string;
      version: number;
      id: string;
      timestamp: string;
      cwd: string;
      parentSession?: string;
    };
    assert.equal(header.type, "session");
    assert.equal(header.version, 3);
    assert.ok(typeof header.id === "string" && header.id.length > 0);
    assert.ok(typeof header.timestamp === "string" && header.timestamp.length > 0);
    assert.equal(header.cwd, project);
    assert.equal(header.parentSession, parentFile);

    const entryId = child.appendCustomEntry("ak-commit-baseline", { version: 1, head: "abc" });
    assert.ok(typeof entryId === "string" && entryId.length > 0);

    const after = (await readFile(file, "utf8")).trim().split("\n");
    assert.equal(after.length, 2);
    const custom = JSON.parse(after[1]!) as {
      type: string;
      customType: string;
      data: unknown;
      id: string;
      parentId: string | null;
      timestamp: string;
    };
    assert.equal(custom.type, "custom");
    assert.equal(custom.customType, "ak-commit-baseline");
    assert.deepEqual(custom.data, { version: 1, head: "abc" });
    assert.equal(custom.id, entryId);
    assert.equal(custom.parentId, null);
    assert.ok(typeof custom.timestamp === "string" && custom.timestamp.length > 0);

    const entries = child.getEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.customType, "ak-commit-baseline");
  });
});

test("#1178 worker gate nest continues prior file and keeps parentSession", async () => {
  await withHermeticHome({ prefix: "ak-pkg-record-resume-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const parentDir = join(
      machineLedgerHome(home),
      "books",
      "proj",
      "1178",
      "runs",
      "r@coder",
      "session",
    );
    await mkdir(parentDir, { recursive: true });
    const parentFile = join(parentDir, "session.jsonl");
    await writeFile(parentFile, sessionHeaderLine("parent-resume", project));
    const parent = { getSessionFile: () => parentFile };

    const first = createRecordSessionOpen({
      cwd: project,
      kind: WORKER_SUBMISSION_GATE_KIND,
      parent,
    });
    assert.equal(first.resumed, false);
    const firstFile = first.session.getSessionFile()!;
    first.session.appendCustomEntry("ak-commit-baseline", { version: 1, head: "h1" });

    const second = createRecordSessionOpen({
      cwd: project,
      kind: WORKER_SUBMISSION_GATE_KIND,
      parent,
    });
    assert.equal(second.resumed, true);
    assert.equal(second.session.getSessionFile(), firstFile);
    second.session.appendCustomEntry("ak-commit-reminder-bounce", { version: 1 });

    const rows = (await readFile(firstFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows[0]!.type, "session");
    assert.equal(rows[0]!.parentSession, parentFile);
    assert.equal(rows[1]!.customType, "ak-commit-baseline");
    assert.equal(rows[2]!.customType, "ak-commit-reminder-bounce");
  });
});

test("#1178 no-parent no-subject stays in-memory and creates no files", async () => {
  await withHermeticHome({ prefix: "ak-pkg-record-mem-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    const before = await readdir(home);

    const opened = createRecordSessionOpen({
      cwd: project,
      kind: "attendance",
    });
    assert.equal(opened.resumed, false);
    assert.equal(opened.session.isPersisted(), false);
    assert.equal(opened.session.getSessionFile(), undefined);
    opened.session.appendCustomEntry("ak-memory-only", { ok: true });
    assert.equal(opened.session.getEntries().length, 1);
    assert.equal(opened.session.getEntries()[0]!.customType, "ak-memory-only");

    const after = await readdir(home);
    assert.deepEqual(after, before);
  });
});

test("#1178 archivist record entry loads and writes when coding-agent peer is unresolvable", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const { tmpdir } = await import("node:os");
  const { worktreeTempPrefix } = await import("../helpers/worktree-temp.ts");
  const root = mkdtempSync(worktreeTempPrefix("ak-pkg-record-peer-iso-"));
  const peerHomes: string[] = [];
  try {
    const hooks = join(root, "block-peer-hooks.mjs");
    const register = join(root, "register-block-peer.mjs");
    const probe = join(root, "probe.mjs");
    const archivistUrl = new URL("../../src/archivist-record-entry.ts", import.meta.url).href;
    writeFileSync(
      hooks,
      `export async function resolve(specifier, context, nextResolve) {
  if (
    specifier === "@earendil-works/pi-coding-agent"
    || specifier.startsWith("@earendil-works/pi-coding-agent/")
    || specifier === "@earendil-works/pi-ai"
    || specifier.startsWith("@earendil-works/pi-ai/")
  ) {
    const err = new Error("Cannot find package '" + specifier + "' (blocked by #1178 isolation probe)");
    err.code = "ERR_MODULE_NOT_FOUND";
    throw err;
  }
  return nextResolve(specifier, context);
}
`,
    );
    writeFileSync(
      register,
      `import { register } from "node:module";
import { pathToFileURL } from "node:url";
register(${JSON.stringify(pathToFileURL(hooks).href)});
`,
    );
    writeFileSync(
      probe,
      `import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { createRecordSession, WORKER_SUBMISSION_GATE_KIND } = await import(${JSON.stringify(archivistUrl)});
const home = mkdtempSync(join(tmpdir(), "ak-1178-peer-iso-home-"));
process.stdout.write(JSON.stringify({ home }) + "\\n");
const project = join(home, "proj");
mkdirSync(project, { recursive: true });
const parentDir = join(home, ".ak-roles", "books", "proj", "runs", "r@coder", "session");
mkdirSync(parentDir, { recursive: true });
const parentFile = join(parentDir, "session.jsonl");
writeFileSync(
  parentFile,
  JSON.stringify({
    type: "session",
    version: 3,
    id: "parent",
    timestamp: "2026-09-01T00:00:00.000Z",
    cwd: project,
  }) + "\\n",
);
const child = createRecordSession({
  cwd: project,
  kind: WORKER_SUBMISSION_GATE_KIND,
  parent: { getSessionFile: () => parentFile },
  home,
});
const file = child.getSessionFile();
if (typeof file !== "string") throw new Error("missing session file");
child.appendCustomEntry("ak-commit-baseline", { version: 1, head: null });
const rows = readFileSync(file, "utf8").trim().split("\\n").map((line) => JSON.parse(line));
process.stdout.write(JSON.stringify({
  headerType: rows[0]?.type,
  parentSession: rows[0]?.parentSession,
  customType: rows[1]?.customType,
}) + "\\n");
`,
    );
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--import", register, probe],
      {
        encoding: "utf8",
        cwd: process.cwd(),
        env: { ...process.env, NODE_OPTIONS: "" },
      },
    );
    assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    assert.ok(lines.length >= 2, `expected structured probe lines, got: ${result.stdout}`);
    const meta = JSON.parse(lines[0]!) as { home?: string };
    if (typeof meta.home === "string") peerHomes.push(meta.home);
    const observed = JSON.parse(lines[1]!) as {
      headerType?: string;
      parentSession?: string;
      customType?: string;
    };
    assert.equal(observed.headerType, "session");
    assert.ok(typeof observed.parentSession === "string" && observed.parentSession.length > 0);
    assert.equal(observed.customType, "ak-commit-baseline");
  } finally {
    for (const home of peerHomes) {
      rmSync(home, { recursive: true, force: true });
    }
    rmSync(root, { recursive: true, force: true });
  }
});
