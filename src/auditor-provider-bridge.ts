import { createServer, type Server, type Socket } from "node:net";
import { unlink } from "node:fs/promises";
import type { Api, Context, Model, Provider, ProviderStreamOptions } from "@earendil-works/pi-ai";
import { createStreamIdleGuard, isStreamIdleTimeoutError } from "./stream-idle-guard.ts";

export const DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES = 2;
export const AUDITOR_BRIDGE_PROVIDER_ID = "ak-private-auditor-bridge";
export const AUDITOR_BRIDGE_MODEL_ID = "ak-private-auditor-model";

export type AuditorProviderBridge = { socketPath: string; close(): Promise<void> };

/** A private, typed child-process bridge. Authentication and the real model remain host-side. */
export async function createAuditorProviderBridge(options: { socketPath: string; provider: Provider; model: Model<Api>; auth: ProviderStreamOptions; signal?: AbortSignal }): Promise<AuditorProviderBridge> {
  await unlink(options.socketPath).catch(() => {});
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      socket.pause();
      void (async () => {
        try {
          const request = JSON.parse(line) as { type: "stream"; context: Context; request?: ProviderStreamOptions };
          if (request.type !== "stream") throw new Error("invalid auditor provider request");
          for (let attempt = 0; ; attempt += 1) {
            const idle = createStreamIdleGuard(options.signal === undefined ? {} : { parentSignal: options.signal });
            try {
              const stream = options.provider.stream(options.model, request.context, { ...request.request, ...options.auth, signal: idle.signal });
              for await (const event of stream) {
                idle.poke();
                socket.write(`${JSON.stringify({ type: "event", event })}\n`);
              }
              if (idle.signal.aborted) throw idle.signal.reason;
              const message = await stream.result();
              socket.end(`${JSON.stringify({ type: "result", message })}\n`);
              break;
            } catch (error) {
              if (!isStreamIdleTimeoutError(error) || attempt >= DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES || options.signal?.aborted) throw error;
            } finally {
              idle.dispose();
            }
          }
        } catch (error) {
          if (!socket.destroyed) socket.end(`${JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) })}\n`);
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.socketPath, resolve); });
  let closing: Promise<void> | undefined;
  return { socketPath: options.socketPath, close() {
    closing ??= (async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await unlink(options.socketPath).catch(() => {});
    })();
    return closing;
  } };
}
