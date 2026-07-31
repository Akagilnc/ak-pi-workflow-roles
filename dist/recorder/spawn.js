import { spawn } from "node:child_process";
import { RecorderError } from "./errors.js";
export class TailRing {
    capacity;
    #data = Buffer.alloc(0);
    constructor(capacity = 4096) { this.capacity = capacity; }
    push(chunk) { if (chunk.length >= this.capacity)
        this.#data = Buffer.from(chunk.subarray(chunk.length - this.capacity));
    else {
        const joined = Buffer.concat([this.#data, chunk]);
        this.#data = joined.length > this.capacity ? joined.subarray(joined.length - this.capacity) : joined;
    } }
    bytes() { return Buffer.from(this.#data); }
}
export async function forwardStream(stream, sink, ring) { for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    ring.push(chunk);
    if (!sink.write(chunk))
        await new Promise((resolve, reject) => { const done = () => { sink.off("error", fail); resolve(); }; const fail = (e) => { sink.off("drain", done); reject(e); }; sink.once("drain", done); sink.once("error", fail); });
} }
export async function spawnOnce(options) { if (!options.argv.length)
    throw new RecorderError("invalid-argv"); let child; try {
    child = spawn(options.argv[0], options.argv.slice(1), { cwd: options.cwd, env: options.env, shell: false, stdio: [options.stdin, "pipe", "pipe"] });
}
catch (e) {
    throw new RecorderError("spawn-failed", undefined, { cause: e });
} if (!child.stdout || !child.stderr)
    throw new RecorderError("spawn-failed"); const stdoutTail = new TailRing(), stderrTail = new TailRing(); const streamCompletion = Promise.all([forwardStream(child.stdout, options.stdoutMirror ?? process.stdout, stdoutTail), forwardStream(child.stderr, options.stderrMirror ?? process.stderr, stderrTail)]).then(() => undefined); void streamCompletion.catch(() => { }); const settlement = new Promise(r => child.once("close", (exitCode, signal) => r({ exitCode, signal }))); await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", e => reject(new RecorderError("spawn-failed", undefined, { cause: e }))); }); return { settlement, streamCompletion, stdoutTail, stderrTail }; }
