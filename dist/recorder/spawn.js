import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { RecorderError } from "./errors.js";
async function teeStream(stream, sinkPath, mirror) {
    await mkdir(dirname(sinkPath), { recursive: true });
    const file = createWriteStream(sinkPath);
    stream.on("data", (chunk) => {
        const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        mirror.write(buf);
        file.write(buf);
    });
    await new Promise((resolve, reject) => {
        stream.on("error", reject);
        file.on("error", reject);
        stream.on("end", () => {
            file.end(() => resolve());
        });
    });
}
export async function spawnOnce(options) {
    if (options.argv.length === 0) {
        throw new RecorderError("invalid-argv", "child argv must not be empty");
    }
    const command = options.argv[0];
    const args = options.argv.slice(1);
    let child;
    try {
        child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            shell: false,
            stdio: [options.stdin, "pipe", "pipe"],
        });
    }
    catch (error) {
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
    const close = await new Promise((resolve, reject) => {
        child.on("error", (error) => {
            reject(new RecorderError("spawn-failed", "child process error", { cause: error }));
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
