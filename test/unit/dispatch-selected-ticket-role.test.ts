/**
 * #176 machine launcher entry — real scripts/dispatch-selected-ticket-role.ts.
 * Proves attach-capable roles receive a typed ticket face via ordinary --attach;
 * reviewer (no attachment channel) is forwarded unbound; ephemeral face is cleaned.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

function writeRecordingAkRole(dir: string, markerPath: string): string {
  const bin = join(dir, "fake-ak-role");
  // Absolute node shebang — launcher tests isolate PATH to /bin:/usr/bin only.
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("node:fs");
const marker = ${JSON.stringify(markerPath)};
const argv = process.argv.slice(2);
const attachIdx = argv.indexOf("--attach");
let attachBody = null;
let attachPath = null;
if (attachIdx >= 0 && argv[attachIdx + 1]) {
  attachPath = argv[attachIdx + 1];
  attachBody = fs.readFileSync(attachPath, "utf8");
}
fs.writeFileSync(
  marker,
  JSON.stringify({ argv, attachPath, attachBody, home: process.env.HOME ?? null }) + "\\n",
);
process.exit(0);
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
