import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { packageRoot } from "./pi-test-harness.ts";

const execFileAsync = promisify(execFile);

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
};

export function writeRecorderConfig(
  dir: string,
  input: MinimalConfigInput,
): string {
  const config = {
    version: 1,
    archive: {
      repositoryRoot: input.archiveRepo,
      root: input.root ?? ".ak/dockets",
      docketId: input.docketId ?? "issues/10/apply/apply-test-001",
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
  const { spawn } = await import("node:child_process");
  const binPath = options.binPath ?? recorderBin;
  const argv =
    binPath.endsWith(".js") || binPath.endsWith(".mjs")
      ? [process.execPath, binPath, ...args]
      : [binPath, ...args];
  return await new Promise((resolveResult, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd ?? packageRoot,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => {
      stdoutChunks.push(Buffer.from(c));
    });
    child.stderr.on("data", (c: Buffer) => {
      stderrChunks.push(Buffer.from(c));
    });
    if (options.input !== undefined) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
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
}

/** True when the OS can freeze a file against unlink (macOS uchg / Linux immutable). */
export function canFreezeFileAgainstUnlink(dir: string): boolean {
  const probe = join(dir, `.freeze-probe-${process.pid}`);
  try {
    writeFileSync(probe, "x");
    if (process.platform === "darwin") {
      execFileSync("chflags", ["uchg", probe], { stdio: "ignore" });
      try {
        rmSync(probe, { force: true });
        return false;
      } catch {
        execFileSync("chflags", ["nouchg", probe], { stdio: "ignore" });
        rmSync(probe, { force: true });
        return true;
      }
    }
    if (process.platform === "linux") {
      try {
        execFileSync("chattr", ["+i", probe], { stdio: "ignore" });
      } catch {
        rmSync(probe, { force: true });
        return false;
      }
      try {
        rmSync(probe, { force: true });
        execFileSync("chattr", ["-i", probe], { stdio: "ignore" });
        rmSync(probe, { force: true });
        return false;
      } catch {
        execFileSync("chattr", ["-i", probe], { stdio: "ignore" });
        rmSync(probe, { force: true });
        return true;
      }
    }
    rmSync(probe, { force: true });
    return false;
  } catch {
    try {
      rmSync(probe, { force: true });
    } catch {
      // ignore
    }
    return false;
  }
}

function freezePath(path: string): void {
  if (process.platform === "darwin") {
    execFileSync("chflags", ["uchg", path], { stdio: "ignore" });
    return;
  }
  if (process.platform === "linux") {
    execFileSync("chattr", ["+i", path], { stdio: "ignore" });
    return;
  }
  throw new Error("freeze unsupported");
}

function unfreezePath(path: string): void {
  try {
    if (process.platform === "darwin") {
      execFileSync("chflags", ["nouchg", path], { stdio: "ignore" });
    } else if (process.platform === "linux") {
      execFileSync("chattr", ["-i", path], { stdio: "ignore" });
    }
  } catch {
    // best effort
  }
}

/**
 * Poll tmpdir for a new ak-docket-record-scratch-* directory and freeze a file
 * inside it so required raw cleanup fails. Returns a disposer that unfreezes.
 */
export async function sabotageRawScratchCleanup(options: {
  tmpDir?: string;
  timeoutMs?: number;
}): Promise<{ dispose: () => void } | null> {
  const { readdirSync, statSync } = await import("node:fs");
  const watchRoot = options.tmpDir ?? tmpdir();
  const timeoutMs = options.timeoutMs ?? 5000;
  const started = Date.now();
  const baseline = new Set(
    readdirSync(watchRoot).filter((name) =>
      name.startsWith("ak-docket-record-scratch-"),
    ),
  );
  const frozen: string[] = [];
  const dispose = () => {
    for (const path of frozen) unfreezePath(path);
  };
  while (Date.now() - started < timeoutMs) {
    let names: string[] = [];
    try {
      names = readdirSync(watchRoot).filter((name) =>
        name.startsWith("ak-docket-record-scratch-"),
      );
    } catch {
      await new Promise((r) => setTimeout(r, 5));
      continue;
    }
    for (const name of names) {
      if (baseline.has(name)) continue;
      const scratch = join(watchRoot, name);
      let entries: string[] = [];
      try {
        if (!statSync(scratch).isDirectory()) continue;
        entries = readdirSync(scratch);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const target = join(scratch, entry);
        if (frozen.includes(target)) continue;
        try {
          freezePath(target);
          frozen.push(target);
        } catch {
          // try next
        }
      }
      if (frozen.length > 0) {
        return { dispose };
      }
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  if (frozen.length > 0) return { dispose };
  return null;
}

const COUNTER_SCRIPT = String.raw`import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
const counter = process.env.AK_RECORDER_COUNTER;
if (!counter) {
  console.error("missing counter path");
  process.exit(2);
}
mkdirSync(resolve(counter, ".."), { recursive: true });
appendFileSync(counter, "1\n");
const mode = process.argv[2] ?? "ok";
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
} else if (mode === "json-receipt") {
  const tool = process.argv[3] ?? "ak_coder_output";
  const details = JSON.parse(process.argv[4] ?? '{"status":"completed","report":"done"}');
  const acceptedByTool = {
    ak_coder_output: "Coder report accepted",
    ak_fixer_output: "Fixer report accepted",
    ak_reviewer_output: "Reviewer report accepted",
    ak_judge_output: "Judge verdict accepted",
    ak_collector_output: "Collector receipt accepted",
  };
  const acceptedText = acceptedByTool[tool] ?? "accepted";
  const callId = "call-1";
  const issued = {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name: tool, arguments: details }],
      timestamp: Date.now(),
    },
  };
  const start = {
    type: "tool_execution_start",
    toolCallId: callId,
    toolName: tool,
    args: details,
  };
  // Exactly one successful terminal (machine tool_execution_end).
  const end = {
    type: "tool_execution_end",
    toolCallId: callId,
    toolName: tool,
    isError: false,
    result: {
      content: [{ type: "text", text: acceptedText }],
      details,
    },
  };
  for (const event of [issued, start, end]) {
    process.stdout.write(JSON.stringify(event) + "\n");
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

export async function npmPackTo(dir: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--json", "--pack-destination", dir],
    { cwd: packageRoot, maxBuffer: 5 * 1024 * 1024 },
  );
  const pack = JSON.parse(stdout) as Array<{ filename: string }>;
  return join(dir, pack[0]!.filename);
}
