import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { RecorderError } from "./errors.ts";

export type ChildSettlement = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

export class TailRing {
  readonly capacity: number;
  #data = Buffer.alloc(0);

  constructor(capacity = 4096) {
    this.capacity = capacity;
  }

  push(chunk: Buffer) {
    if (chunk.length >= this.capacity) {
      this.#data = Buffer.from(chunk.subarray(chunk.length - this.capacity));
      return;
    }
    const joined = Buffer.concat([this.#data, chunk]);
    this.#data =
      joined.length > this.capacity
        ? joined.subarray(joined.length - this.capacity)
        : joined;
  }

  bytes() {
    return Buffer.from(this.#data);
  }
}

export async function forwardStream(
  stream: Readable,
  sink: Writable,
  ring: TailRing,
): Promise<void> {
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    ring.push(chunk);
    if (!sink.write(chunk)) {
      await new Promise<void>((resolve, reject) => {
        const drained = () => {
          sink.off("error", failed);
          resolve();
        };
        const failed = (error: Error) => {
          sink.off("drain", drained);
          reject(error);
        };
        sink.once("drain", drained);
        sink.once("error", failed);
      });
    }
  }
}

export type SpawnExecution = {
  settlement: Promise<ChildSettlement>;
  streamCompletion: Promise<void>;
  stdoutTail: TailRing;
  stderrTail: TailRing;
};

export async function spawnOnce(options: {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: "inherit";
  stdoutMirror?: Writable;
  stderrMirror?: Writable;
}): Promise<SpawnExecution> {
  if (!options.argv.length) throw new RecorderError("invalid-argv");

  let child: ChildProcess;
  try {
    child = spawn(options.argv[0]!, options.argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: [options.stdin, "pipe", "pipe"],
    });
  } catch (error) {
    throw new RecorderError("spawn-failed", undefined, { cause: error });
  }
  if (!child.stdout || !child.stderr) throw new RecorderError("spawn-failed");

  const stdoutTail = new TailRing();
  const stderrTail = new TailRing();
  const streamCompletion = Promise.all([
    forwardStream(
      child.stdout,
      options.stdoutMirror ?? process.stdout,
      stdoutTail,
    ),
    forwardStream(
      child.stderr,
      options.stderrMirror ?? process.stderr,
      stderrTail,
    ),
  ]).then(() => undefined);
  void streamCompletion.catch(() => {});

  const settlement = new Promise<ChildSettlement>((resolve) => {
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error) =>
      reject(new RecorderError("spawn-failed", undefined, { cause: error })),
    );
  });
  return { settlement, streamCompletion, stdoutTail, stderrTail };
}
