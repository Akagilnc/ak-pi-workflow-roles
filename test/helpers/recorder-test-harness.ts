import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
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

export async function runRecorderBin(
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
  } = {},
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [recorderBin, ...args], {
      cwd: options.cwd ?? packageRoot,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c) => {
      stdout += c;
    });
    child.stderr.setEncoding("utf8").on("data", (c) => {
      stderr += c;
    });
    if (options.input !== undefined) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolveResult({ code, signal, stdout, stderr });
    });
  });
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
  const terminal = {
    type: "message_end",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: tool,
      isError: false,
      details,
      timestamp: Date.now(),
      content: [{ type: "text", text: acceptedText }],
    },
  };
  for (const event of [issued, start, end, terminal]) {
    process.stdout.write(JSON.stringify(event) + "\n");
  }
  process.exit(0);
} else if (mode === "cwd") {
  process.stdout.write(process.cwd() + "\n");
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
