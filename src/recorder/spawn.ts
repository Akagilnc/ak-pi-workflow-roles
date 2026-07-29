import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Readable } from "node:stream";

import { RecorderError } from "./errors.ts";

export type SpawnCapture = {
  stdoutPath: string;
  stderrPath: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

async function teeStream(
  stream: Readable,
  sinkPath: string,
  mirror: NodeJS.WriteStream,
): Promise<void> {
  await mkdir(dirname(sinkPath), { recursive: true });
  const file = createWriteStream(sinkPath);
  stream.on("data", (chunk: Buffer | string) => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    mirror.write(buf);
    file.write(buf);
  });
  await new Promise<void>((resolve, reject) => {
    stream.on("error", reject);
    file.on("error", reject);
    stream.on("end", () => {
      file.end(() => resolve());
    });
  });
}

export async function spawnOnce(options: {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdoutPath: string;
  stderrPath: string;
  stdin: "inherit";
  stdoutMirror?: NodeJS.WriteStream;
  stderrMirror?: NodeJS.WriteStream;
}): Promise<SpawnCapture> {
  if (options.argv.length === 0) {
    throw new RecorderError("invalid-argv", "child argv must not be empty");
  }
  const command = options.argv[0]!;
  const args = options.argv.slice(1);
  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: [options.stdin, "pipe", "pipe"],
    });
  } catch (error) {
    throw new RecorderError("spawn-failed", "failed to spawn child process", {
      cause: error,
    });
  }

  const stdoutMirror = options.stdoutMirror ?? process.stdout;
  const stderrMirror = options.stderrMirror ?? process.stderr;

  if (child.stdout === null || child.stderr === null) {
    throw new RecorderError("spawn-failed", "child stdio pipes unavailable");
  }

  const stdoutDone = teeStream(child.stdout, options.stdoutPath, stdoutMirror);
  const stderrDone = teeStream(child.stderr, options.stderrPath, stderrMirror);

  const close = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.on("error", (error) => {
      reject(
        new RecorderError("spawn-failed", "child process error", { cause: error }),
      );
    });
    child.on("close", (exitCode, signal) => {
      resolve({ exitCode, signal });
    });
  });

  await Promise.all([stdoutDone, stderrDone]);
  return {
    stdoutPath: options.stdoutPath,
    stderrPath: options.stderrPath,
    exitCode: close.exitCode,
    signal: close.signal,
  };
}
