import { createServer } from "node:net";
import { unlink } from "node:fs/promises";
import { createStreamIdleGuard, isStreamIdleTimeoutError } from "./stream-idle-guard.js";
export const DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES = 2;
export const AUDITOR_BRIDGE_PROVIDER_ID = "ak-private-auditor-bridge";
export const AUDITOR_BRIDGE_MODEL_ID = "ak-private-auditor-model";
function errorEnvelope(value) {
    if (value instanceof Error) {
        const code = value.code;
        return { name: value.name, message: value.message, ...(typeof code === "string" || typeof code === "number" ? { code } : {}) };
    }
    return { name: "Error", message: String(value) };
}
/** A private, typed child-process bridge. Authentication and the real model remain host-side. */
export async function createAuditorProviderBridge(options) {
    await unlink(options.socketPath).catch(() => { });
    const sockets = new Set();
    const requests = new Map();
    const server = createServer((socket) => {
        sockets.add(socket);
        const requestLifetime = new AbortController();
        requests.set(socket, requestLifetime);
        const abortRequest = (reason) => { if (!requestLifetime.signal.aborted)
            requestLifetime.abort(reason); };
        const parentAbort = () => abortRequest(options.signal?.reason ?? new Error("auditor provider bridge aborted"));
        if (options.signal?.aborted)
            parentAbort();
        else
            options.signal?.addEventListener("abort", parentAbort, { once: true });
        const disconnected = () => abortRequest(new Error("auditor provider child disconnected"));
        socket.once("end", disconnected);
        socket.once("error", disconnected);
        socket.once("close", () => {
            disconnected();
            options.signal?.removeEventListener("abort", parentAbort);
            sockets.delete(socket);
            requests.delete(socket);
        });
        let input = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
            input += chunk;
            const newline = input.indexOf("\n");
            if (newline < 0)
                return;
            const line = input.slice(0, newline);
            input = input.slice(newline + 1);
            socket.pause();
            void (async () => {
                try {
                    const request = JSON.parse(line);
                    if (request.type !== "stream")
                        throw new Error("invalid auditor provider request");
                    for (let attempt = 0;; attempt += 1) {
                        const idle = createStreamIdleGuard({ parentSignal: requestLifetime.signal });
                        let emitted = false;
                        try {
                            const stream = options.provider.stream(options.model, request.context, { ...request.request, ...options.auth, signal: idle.signal });
                            for await (const event of stream) {
                                idle.poke();
                                emitted = true;
                                if (socket.destroyed)
                                    throw requestLifetime.signal.reason;
                                socket.write(`${JSON.stringify({ type: "event", event })}\n`);
                            }
                            if (idle.signal.aborted)
                                throw idle.signal.reason;
                            const message = await stream.result();
                            socket.end(`${JSON.stringify({ type: "result", message })}\n`);
                            break;
                        }
                        catch (error) {
                            if (emitted || !isStreamIdleTimeoutError(error) || attempt >= DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES || requestLifetime.signal.aborted)
                                throw error;
                        }
                        finally {
                            idle.dispose();
                        }
                    }
                }
                catch (error) {
                    if (!socket.destroyed)
                        socket.end(`${JSON.stringify({ type: "error", error: errorEnvelope(error) })}\n`);
                }
            })();
        });
    });
    try {
        await new Promise((resolve, reject) => { server.once("error", reject); server.listen(options.socketPath, resolve); });
    }
    catch (error) {
        await new Promise((resolve) => server.close(() => resolve()));
        await unlink(options.socketPath).catch(() => { });
        throw error;
    }
    let closing;
    return { socketPath: options.socketPath, close() {
            closing ??= (async () => {
                for (const [socket, controller] of requests) {
                    if (!controller.signal.aborted)
                        controller.abort(new Error("auditor provider bridge closed"));
                    socket.destroy();
                }
                await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
                await unlink(options.socketPath).catch(() => { });
            })();
            return closing;
        } };
}
