import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { createAssistantMessageEventStream, type Api, type Context, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

type Config = { systemPrompt: string; model: Model<Api>; providerName: string; socketPath: string; tool: { name: string; description: string; parameters: TSchema } };

export default function auditorRpcExtension(pi: ExtensionAPI) {
  let decisionSubmitted = false;
  const path = process.env.AK_AUDITOR_RPC_CONFIG;
  if (typeof path !== "string" || path === "") throw new Error("auditor RPC configuration is missing");
  const config = JSON.parse(readFileSync(path, "utf8")) as Config;
    pi.registerProvider({
      id: config.model.provider, name: config.providerName,
      auth: { apiKey: { name: "Host auditor dispatch", async resolve() { return { auth: { apiKey: "host-bridge" } }; } } },
      getModels() { return [config.model]; },
      stream(_model, context: Context, request?: any) {
        const output = createAssistantMessageEventStream();
        const socket = createConnection(config.socketPath);
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("connect", () => { const { signal: _signal, ...serializable } = request ?? {}; socket.write(`${JSON.stringify({ type: "stream", context, request: serializable })}\n`); });
        socket.on("data", (chunk) => { buffer += chunk; for (;;) { const i = buffer.indexOf("\n"); if (i < 0) break; const envelope = JSON.parse(buffer.slice(0, i)) as any; buffer = buffer.slice(i + 1); if (envelope.type === "event") output.push(envelope.event); else if (envelope.type === "result") output.end(envelope.message); else if (envelope.type === "error") { console.error(envelope.message); output.end(); } } });
        socket.on("error", (error) => { console.error(error); output.end(); });
        return output;
      },
      streamSimple(model, context, request) { return this.stream(model, context, request as any); },
    });
  pi.on("session_start", () => {
    pi.registerTool({
      name: config.tool.name,
      label: config.tool.description,
      description: config.tool.description,
      parameters: config.tool.parameters,
      async execute(_id, params) {
        if (decisionSubmitted) throw new Error("Auditor decision was submitted more than once");
        decisionSubmitted = true;
        return { content: [{ type: "text", text: "Compliance decision received" }], details: params, terminate: true };
      },
    });
    pi.on("before_agent_start", () => ({ systemPrompt: config.systemPrompt }));
    pi.setActiveTools([...new Set([...pi.getActiveTools(), config.tool.name])]);
  });
}
