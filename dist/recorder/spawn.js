import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { RecorderError } from "./errors.js";
async function teeStream(stream, sinkPath, mirror) {
    await mkdir(dirname(sinkPath), { recursive: true });
    const file = createWriteStream(sinkPath);
    stream.on("data", (chunk) => {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        mirror.write(buffer);
        file.write(buffer);
    });
    await new Promise((resolve, reject) => {
        stream.on("error", reject);
        file.on("error", reject);
        stream.on("end", () => file.end(resolve));
    });
}
export async function spawnOnce(options) {
    if (options.argv.length === 0) {
        throw new RecorderError("invalid-argv", "child argv must not be empty");
    }
    let child;
    try {
        child = spawn(options.argv[0], options.argv.slice(1), {
            cwd: options.cwd,
            env: options.env,
            shell: false,
            stdio: [options.stdin, "pipe", "pipe"],
        });
    }
    catch (error) {
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
    const settlement = new Promise((resolve) => {
        child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", (error) => reject(new RecorderError("spawn-failed", "failed to spawn child process", { cause: error })));
    });
    return {
        stdoutPath: options.stdoutPath,
        stderrPath: options.stderrPath,
        settlement,
        teeCompletion,
    };
}
