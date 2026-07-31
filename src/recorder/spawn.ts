import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Readable } from "node:stream";

import { RecorderError } from "./errors.ts";

export type ChildSettlement = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

export type SpawnExecution = {
  stdoutPath: string;
  stderrPath: string;
  settlement: Promise<ChildSettlement>;
  teeCompletion: Promise<void>;
};

async function teeStream(
  stream: Readable,
  sinkPath: string,
  mirror: NodeJS.WriteStream,
): Promise<void> {
  await mkdir(dirname(sinkPath), { recursive: true });
  const file = createWriteStream(sinkPath);
  stream.on("data", (chunk: Buffer | string) => {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    mirror.write(buffer);
    file.write(buffer);
  });
  await new Promise<void>((resolve, reject) => {
    stream.on("error", reject);
    file.on("error", reject);
    stream.on("end", () => file.end(resolve));
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
}): Promise<SpawnExecution> {
  if (options.argv.length === 0) {
    throw new RecorderError("invalid-argv", "child argv must not be empty");
  }

  let child: ChildProcess;
  try {
    child = spawn(options.argv[0]!, options.argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: [options.stdin, "pipe", "pipe"],
    });
  } catch (error) {
    throw new RecorderError("spawn-failed", "failed to spawn child process", { cause: error });
  }

  if (child.stdout === null || child.stderr === null) {
    throw new RecorderError("spawn-failed", "child stdio pipes unavailable");
  }

  // Install all handlers immediately. Each promise has a rejection handler before
  // this function waits for the process-start verdict.
  const teeCompletion = Promise.all([
    teeStream(child.stdout, options.stdoutPath, options.stdoutMirror ?? process.stdout),
    teeStream(child.stderr, options.stderrPath, options.stderrMirror ?? process.stderr),
  ]).then(() => undefined);
  void teeCompletion.catch(() => undefined);

  const settlement = new Promise<ChildSettlement>((resolve) => {
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error) => reject(
      new RecorderError("spawn-failed", "failed to spawn child process", { cause: error }),
    ));
  });

  return {
    stdoutPath: options.stdoutPath,
    stderrPath: options.stderrPath,
    settlement,
    teeCompletion,
  };
}
