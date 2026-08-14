/**
 * #176 machine launcher entry — real scripts/dispatch-selected-ticket-role.ts.
 * Proves attach-capable roles receive a typed ticket face via ordinary --attach;
 * reviewer (no attachment channel) is forwarded unbound; ephemeral face is cleaned;
 * cleanup failure is observable and non-zero without masking a child primary status.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
const launcherPath = join(packageRoot, "scripts/dispatch-selected-ticket-role.ts");

/** Minimal PATH so the launcher falls back to AK_ROLE_PATH (no host ak-role). */
function isolatedPath(): string {
  return ["/bin", "/usr/bin"].join(":");
}

function writeRecordingAkRole(
  dir: string,
  markerPath: string,
  options?: { exitCode?: number; sabotageAttachDir?: boolean },
): string {
  const bin = join(dir, "fake-ak-role");
  const exitCode = options?.exitCode ?? 0;
  const sabotage = options?.sabotageAttachDir === true;
  // Absolute node shebang — launcher tests isolate PATH to /bin:/usr/bin only.
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const marker = ${JSON.stringify(markerPath)};
const argv = process.argv.slice(2);
const attachIdx = argv.indexOf("--attach");
let attachBody = null;
let attachPath = null;
if (attachIdx >= 0 && argv[attachIdx + 1]) {
  attachPath = argv[attachIdx + 1];
  attachBody = fs.readFileSync(attachPath, "utf8");
  if (${sabotage ? "true" : "false"}) {
    // Deny scandir/unlink so launcher rmSync(recursive) must fail (real EACCES).
    try { fs.chmodSync(attachPath, 0o000); } catch {}
    try { fs.chmodSync(path.dirname(attachPath), 0o000); } catch {}
  }
}
fs.writeFileSync(
  marker,
  JSON.stringify({ argv, attachPath, attachBody, home: process.env.HOME ?? null }) + "\\n",
);
process.exit(${exitCode});
`,
    { mode: 0o755 },
  );
  chmodSync(bin, 0o755);
  return bin;
}

function runLauncher(input: {
  ticketNumber: number;
  project: string;
  home: string;
  akRolePath: string;
  akRoleArgs: readonly string[];
}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      launcherPath,
      String(input.ticketNumber),
      "--project",
      input.project,
      "--home",
      input.home,
      "--",
      ...input.akRoleArgs,
    ],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        PATH: isolatedPath(),
        AK_ROLE_PATH: input.akRolePath,
      },
      encoding: "utf8",
      input: "",
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function listTicketFaceDirs(): string[] {
  return readdirSync(tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("ak-ticket-face-"))
    .map((entry) => join(tmpdir(), entry.name));
}

function restoreAndRemoveTicketFaces(dirs: readonly string[]): void {
  for (const dir of dirs) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // already gone or still unreachable
    }
    try {
      for (const name of readdirSync(dir)) {
        try {
          chmodSync(join(dir, name), 0o600);
        } catch {
          // best-effort restore before rm
        }
      }
    } catch {
      // scandir may still fail
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // leave for OS tmp scrub if still locked
    }
  }
}

test("launcher injects typed --attach for judge and cleans the face directory", async () => {
  const work = await mkdtemp(join(tmpdir(), "ak-dispatch-judge-"));
  try {
    const markerPath = join(work, "marker.json");
    const akRolePath = writeRecordingAkRole(work, markerPath);
    const before = new Set(listTicketFaceDirs());
    const result = runLauncher({
      ticketNumber: 176,
      project: work,
      home: work,
      akRolePath,
      akRoleArgs: ["judge", "--project", work, "Review the plan."],
    });
    assert.equal(result.status, 0, result.stderr);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      argv: string[];
      attachPath: string | null;
      attachBody: string | null;
      home: string | null;
    };
    assert.equal(marker.home, work);
    assert.ok(marker.attachPath, "judge must receive --attach");
    assert.equal(marker.argv.includes("--attach"), true);
    assert.equal(marker.argv[0], "judge");
    assert.equal(marker.argv[marker.argv.indexOf("--attach") + 1], marker.attachPath);
    assert.match(marker.attachBody ?? "", /^---\nticketNumber: 176\n---\n/);
    // Ephemeral face directory must be gone after the launcher exits.
    assert.equal(existsSync(marker.attachPath), false);
    const leaked = listTicketFaceDirs().filter((dir) => !before.has(dir));
    assert.deepEqual(leaked, []);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("launcher injects --attach after role when global --model precedes command", async () => {
  const work = await mkdtemp(join(tmpdir(), "ak-dispatch-model-"));
  try {
    const markerPath = join(work, "marker.json");
    const akRolePath = writeRecordingAkRole(work, markerPath);
    const result = runLauncher({
      ticketNumber: 176,
      project: work,
      home: work,
      akRolePath,
      akRoleArgs: ["--model", "xai/grok-4:off", "fixer", "--project", work, "apply fix"],
    });
    assert.equal(result.status, 0, result.stderr);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      argv: string[];
      attachPath: string | null;
    };
    assert.ok(marker.attachPath);
    assert.deepEqual(marker.argv.slice(0, 5), [
      "--model",
      "xai/grok-4:off",
      "fixer",
      "--attach",
      marker.attachPath,
    ]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("launcher forwards reviewer unbound without --attach", async () => {
  const work = await mkdtemp(join(tmpdir(), "ak-dispatch-reviewer-"));
  try {
    const markerPath = join(work, "marker.json");
    const akRolePath = writeRecordingAkRole(work, markerPath);
    const before = new Set(listTicketFaceDirs());
    const result = runLauncher({
      ticketNumber: 176,
      project: work,
      home: work,
      akRolePath,
      akRoleArgs: ["reviewer", "--project", work, "--base", "HEAD", "Review"],
    });
    assert.equal(result.status, 0, result.stderr);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      argv: string[];
      attachPath: string | null;
      attachBody: string | null;
    };
    assert.equal(marker.attachPath, null);
    assert.equal(marker.argv.includes("--attach"), false);
    assert.deepEqual(marker.argv, [
      "reviewer",
      "--project",
      work,
      "--base",
      "HEAD",
      "Review",
    ]);
    const leaked = listTicketFaceDirs().filter((dir) => !before.has(dir));
    assert.deepEqual(leaked, []);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("launcher cleanup failure is nonzero and observable when child succeeds", async () => {
  const work = await mkdtemp(join(tmpdir(), "ak-dispatch-cleanup-fail-"));
  const before = new Set(listTicketFaceDirs());
  try {
    const markerPath = join(work, "marker.json");
    const akRolePath = writeRecordingAkRole(work, markerPath, {
      sabotageAttachDir: true,
    });
    const result = runLauncher({
      ticketNumber: 176,
      project: work,
      home: work,
      akRolePath,
      akRoleArgs: ["judge", "--project", work, "Review the plan."],
    });
    assert.notEqual(result.status, 0, "cleanup failure must not exit 0");
    assert.match(result.stderr, /ticket face cleanup failed/);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      attachPath: string | null;
    };
    assert.ok(marker.attachPath);
    // Face directory leaked because cleanup could not remove it — honest residue.
    assert.equal(existsSync(dirname(marker.attachPath!)), true);
  } finally {
    const leaked = listTicketFaceDirs().filter((dir) => !before.has(dir));
    restoreAndRemoveTicketFaces(leaked);
    await rm(work, { recursive: true, force: true });
  }
});

test("launcher keeps child primary status when cleanup also fails", async () => {
  const work = await mkdtemp(join(tmpdir(), "ak-dispatch-child-primary-"));
  const before = new Set(listTicketFaceDirs());
  try {
    const markerPath = join(work, "marker.json");
    const akRolePath = writeRecordingAkRole(work, markerPath, {
      exitCode: 7,
      sabotageAttachDir: true,
    });
    const result = runLauncher({
      ticketNumber: 176,
      project: work,
      home: work,
      akRolePath,
      akRoleArgs: ["coder", "--project", work, "implement"],
    });
    assert.equal(result.status, 7, "child status remains primary");
    assert.match(result.stderr, /ticket face cleanup failed/);
  } finally {
    const leaked = listTicketFaceDirs().filter((dir) => !before.has(dir));
    restoreAndRemoveTicketFaces(leaked);
    await rm(work, { recursive: true, force: true });
  }
});
