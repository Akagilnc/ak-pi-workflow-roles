import { createHash } from "node:crypto";
import {
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { packageRoot, packIsolatedPackage } from "./pi-test-harness.ts";

export const recorderBin = resolve(packageRoot, "bin/ak-docket-record.js");

export function sha256File(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function initGitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "recorder@test.local"], {
    cwd: dir,
  });
  execFileSync("git", ["config", "user.name", "Recorder Test"], { cwd: dir });
  execFileSync("git", ["checkout", "-b", "main"], { cwd: dir });
  // Match production archive layout: private recorder stage lives under ignored .ak/work.
  writeFileSync(join(dir, ".gitignore"), ".ak/work/\n");
  return dir;
}

export function commitFile(
  repo: string,
  relativePath: string,
  contents: string,
): { commit: string; blobOid: string; sha256: string; path: string } {
  const abs = join(repo, relativePath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
  execFileSync("git", ["add", relativePath], { cwd: repo });
  execFileSync("git", ["commit", "-m", `add ${relativePath}`], { cwd: repo });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  const blobOid = execFileSync(
    "git",
    ["rev-parse", `HEAD:${relativePath}`],
    { cwd: repo, encoding: "utf8" },
  ).trim();
  return {
    commit,
    blobOid,
    sha256: sha256File(contents),
    path: relativePath,
  };
}

export type MinimalConfigInput = {
  archiveRepo: string;
  docketId?: string;
  root?: string;
  cwd?: string;
  inherit?: boolean;
  overrides?: Record<string, string>;
  unset?: string[];
  authority: {
    repositoryRoot: string;
    commit: string;
    path: string;
    blobOid: string;
    sha256: string;
  };
  task: {
    repositoryRoot: string;
    commit: string;
    path: string;
    blobOid: string;
    sha256: string;
  };
  externalInputs?: Array<{
    id: string;
    sourcePath: string;
    sha256: string;
    kind: "authority" | "task" | "input";
  }>;
  exhibits?: Array<{
    id: string;
    sourcePath: string;
    sha256: string;
  }>;
  provenance?: {
    package: string | null;
    model: string | null;
    target: string | null;
  };
  sessionId?: string;
  sessionDirectory?: string;
};

export function writeRecorderConfig(
  dir: string,
  input: MinimalConfigInput,
): string {
  const sessionId = input.sessionId ?? "018f22e2-7d5a-7abc-8abc-123456789abc";
  const config = {
    version: 2,
    archive: {
      repositoryRoot: input.archiveRepo,
      root: input.root ?? ".ak/dockets",
      docketId: input.docketId ?? "issues/10/apply/apply-test-001",
    },
    session: {
      directory: input.sessionDirectory ?? `.ak/work/${sessionId}/session`,
      id: sessionId,
    },
    execution: {
      cwd: input.cwd ?? dir,
      environment: {
        inherit: input.inherit ?? true,
        overrides: input.overrides ?? {},
        unset: input.unset ?? [],
      },
      stdin: "inherit",
    },
    declarations: {
      gitReferences: [
        {
          id: "authority",
          repositoryRoot: input.authority.repositoryRoot,
          commit: input.authority.commit,
          path: input.authority.path,
          blobOid: input.authority.blobOid,
          sha256: input.authority.sha256,
          kind: "authority",
        },
        {
          id: "task",
          repositoryRoot: input.task.repositoryRoot,
          commit: input.task.commit,
          path: input.task.path,
          blobOid: input.task.blobOid,
          sha256: input.task.sha256,
          kind: "task",
        },
      ],
      externalInputs: input.externalInputs ?? [],
      exhibits: input.exhibits ?? [],
    },
    provenance: input.provenance ?? {
      package: null,
      model: null,
      target: null,
    },
  };
  const path = join(dir, "recorder-config.json");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

export type RecorderBinResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutBuf: Buffer;
  stderrBuf: Buffer;
};

export async function runRecorderBin(
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string | Buffer;
    binPath?: string;
  } = {},
): Promise<RecorderBinResult> {
  const handle = spawnRecorderBin(args, options);
  return await handle.result;
}

/** Spawn Recorder and expose the live child for black-box observation/kill tests. */
export function spawnRecorderBin(
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string | Buffer;
    binPath?: string;
  } = {},
): {
  pid: number | undefined;
  child: ChildProcess;
  result: Promise<RecorderBinResult>;
} {
  const binPath = options.binPath ?? recorderBin;
  const argv =
    binPath.endsWith(".js") || binPath.endsWith(".mjs")
      ? [process.execPath, binPath, ...args]
      : [binPath, ...args];
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: options.cwd ?? packageRoot,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on("data", (c: Buffer) => {
    stdoutChunks.push(Buffer.from(c));
  });
  child.stderr?.on("data", (c: Buffer) => {
    stderrChunks.push(Buffer.from(c));
  });
  if (options.input !== undefined) {
    child.stdin?.write(options.input);
  }
  child.stdin?.end();
  const result = new Promise<RecorderBinResult>((resolveResult, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const stdoutBuf = Buffer.concat(stdoutChunks);
      const stderrBuf = Buffer.concat(stderrChunks);
      resolveResult({
        code,
        signal,
        stdout: stdoutBuf.toString("utf8"),
        stderr: stderrBuf.toString("utf8"),
        stdoutBuf,
        stderrBuf,
      });
    });
  });
  return { pid: child.pid, child, result };
}

const COUNTER_SCRIPT = String.raw`#!/usr/bin/env node
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const counter = process.env.AK_RECORDER_COUNTER;
if (!counter) {
  console.error("missing counter path");
  process.exit(2);
}
mkdirSync(resolve(counter, ".."), { recursive: true });
appendFileSync(counter, "1\n");
const printAt = process.argv.indexOf("-p");
const mode = printAt >= 0 ? process.argv[printAt + 1] : "ok";
if (mode === "native-session") {
  const sessionDir = process.argv[process.argv.indexOf("--session-dir") + 1];
  const sessionId = process.argv[process.argv.indexOf("--session-id") + 1];
  mkdirSync(sessionDir, { recursive: true });
  const details = { status: "completed", report: process.env.AK_REPORT ?? "done" };
  const issuedId = "00000001";
  const rows = [
    { type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: process.cwd() },
    { type: "message", id: issuedId, parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "ak_coder_output", arguments: details }], stopReason: "toolUse", timestamp: Date.now() } },
    { type: "message", id: "00000002", parentId: issuedId, timestamp: "2026-01-01T00:00:02.000Z", message: { role: "toolResult", toolCallId: "call-1", toolName: "ak_coder_output", content: [{ type: "text", text: "presentation" }], isError: false, details, timestamp: Date.now() } },
  ];
  writeFileSync(join(sessionDir, "native_" + sessionId + ".jsonl"), rows.map(JSON.stringify).join("\n") + "\n");
  process.stdout.write("OUT:native\n");
  process.stderr.write("ERR:native\n");
  if (process.env.AK_LOCK_WORK === "1") chmodSync(join(process.cwd(), ".ak/work"), 0o500);
  process.exit(Number(process.env.AK_CHILD_EXIT ?? "0"));
}
if (mode === "stdout-stderr") {
  process.stdout.write("OUT:" + process.argv.slice(3).join("|") + "\n");
  process.stderr.write("ERR:marker\n");
  process.exit(0);
}
if (mode === "exit") {
  const code = Number(process.argv[3] ?? "0");
  process.stdout.write("exit-body\n");
  process.exit(code);
}
if (mode === "exit-text") {
  const code = Number(process.argv[3] ?? "0");
  process.stdout.write(process.argv[4] ?? "");
  process.stderr.write(process.argv[5] ?? "");
  process.exit(code);
}
if (mode === "signal") {
  process.stdout.write("signal-body\n");
  process.kill(process.pid, process.argv[3] ?? "SIGTERM");
  setInterval(() => {}, 10000);
} else if (mode === "env") {
  const names = process.argv.slice(3);
  for (const name of names) {
    process.stdout.write(name + "=" + (process.env[name] ?? "<unset>") + "\n");
  }
  process.exit(0);
} else if (mode === "cwd") {
  process.stdout.write(process.cwd() + "\n");
  process.exit(0);
} else if (mode === "stdin-echo") {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  process.stdout.write(body);
  process.exit(0);
} else if (mode === "binary-tee") {
  const outLen = Number(process.argv[3] ?? "0");
  const errLen = Number(process.argv[4] ?? "0");
  const out = Buffer.alloc(outLen);
  const err = Buffer.alloc(errLen);
  for (let i = 0; i < outLen; i++) out[i] = i % 256;
  for (let i = 0; i < errLen; i++) err[i] = 255 - (i % 256);
  // Drain both pipes before exit — process.exit would truncate large tees.
  await new Promise((resolve, reject) => {
    process.stdout.write(out, (errWrite) => (errWrite ? reject(errWrite) : resolve()));
  });
  await new Promise((resolve, reject) => {
    process.stderr.write(err, (errWrite) => (errWrite ? reject(errWrite) : resolve()));
  });
  process.exit(0);
} else {
  process.stdout.write("ok\n");
  process.exit(0);
}
`;

export function writeCounterScript(dir: string): string {
  const path = join(dir, "count-invoke.mjs");
  writeFileSync(path, COUNTER_SCRIPT);
  chmodSync(path, 0o755);
  return path;
}

/** Pack from a private materialization; never rewrites shared packageRoot dist/. */
export async function npmPackTo(dir: string): Promise<string> {
  const packed = await packIsolatedPackage(dir);
  return packed.tarball;
}
