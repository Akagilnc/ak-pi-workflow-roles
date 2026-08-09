import { createServer, type Server } from "node:net";
import { unlink } from "node:fs/promises";
import type { Api, Context, Model, Provider, ProviderStreamOptions } from "@earendil-works/pi-ai";
import { createStreamIdleGuard, isStreamIdleTimeoutError } from "./stream-idle-guard.ts";

export const DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES = 2;

export type AuditorProviderBridge = { socketPath: string; close(): Promise<void> };

/** A private, typed child-process bridge. Authentication remains in the host process. */
export async function createAuditorProviderBridge(options: { socketPath: string; provider: Provider; model: Model<Api>; auth: ProviderStreamOptions; signal?: AbortSignal }): Promise<AuditorProviderBridge> {
  await unlink(options.socketPath).catch(() => {});
  const server: Server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const line = input.slice(0, newline); input = "";
      void (async () => {
        try {
          const request = JSON.parse(line) as { type: "stream"; context: Context; request?: ProviderStreamOptions };
          if (request.type !== "stream") throw new Error("invalid auditor provider request");
          for (let attempt = 0; ; attempt += 1) {
            const idle = createStreamIdleGuard(options.signal === undefined ? {} : { parentSignal: options.signal });
            try {
              const stream = options.provider.stream(options.model, request.context, { ...request.request, ...options.auth, signal: idle.signal });
              const events: unknown[] = [];
              for await (const event of stream) { idle.poke(); events.push(event); }
              if (idle.signal.aborted) throw idle.signal.reason;
              const message = await stream.result();
              for (const event of events) socket.write(`${JSON.stringify({ type: "event", event })}\n`);
              socket.end(`${JSON.stringify({ type: "result", message })}\n`);
              break;
            } catch (error) {
              if (!isStreamIdleTimeoutError(error) || attempt >= DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES || options.signal?.aborted) throw error;
            } finally { idle.dispose(); }
          }
        } catch (error) { socket.end(`${JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) })}\n`); }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.socketPath, resolve); });
  return { socketPath: options.socketPath, async close() { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); await unlink(options.socketPath).catch(() => {}); } };
}
