import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

const CONFIG_FLAG = "ak-auditor-rpc-config";
type ChildModel = Omit<Model<Api>, "baseUrl" | "headers" | "compat" | "samplingParams" | "thinkingLevelMap">;
type Config = { systemPrompt: string; model: ChildModel; socketPath: string; tool: { name: string; description: string; parameters: TSchema } };

export default function auditorRpcExtension(pi: ExtensionAPI) {
  pi.registerFlag(CONFIG_FLAG, { type: "string", description: "Internal auditor RPC configuration path" });
  // Pi discovers extension flags before its second argv parse; configuration needed
  // during this first initialization pass is supplied by the matching private env path.
  const path = process.env.AK_AUDITOR_RPC_CONFIG;
  if (typeof path !== "string" || path === "") throw new Error("auditor RPC configuration is missing");
  const config = JSON.parse(readFileSync(path, "utf8")) as Config;
  const model: Model<Api> = { ...config.model, baseUrl: "http://ak-private-auditor.invalid" };
  let decisionSubmitted = false;

  // Provider registration is legal during extension initialization, before session_start.
  pi.registerProvider({
    id: model.provider,
    name: "Private auditor bridge",
    auth: { apiKey: { name: "Private host bridge", async resolve() { return { auth: { apiKey: "non-secret-bridge-sentinel" } }; } } },
    getModels() { return [model]; },
    stream(_model, context: Context, request?: any) {
      const output = createAssistantMessageEventStream();
      const socket = createConnection(config.socketPath);
      let buffer = "";
      socket.setEncoding("utf8");
      const fail = (message: string) => {
        const error: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: message, timestamp: Date.now() };
        output.push({ type: "error", reason: "error", error });
      };
      socket.on("connect", () => {
        const { signal: _signal, ...serializable } = request ?? {};
        socket.write(`${JSON.stringify({ type: "stream", context, request: serializable })}\n`);
      });
      socket.on("data", (chunk) => {
        buffer += chunk;
        for (;;) {
          const i = buffer.indexOf("\n");
          if (i < 0) break;
          const envelope = JSON.parse(buffer.slice(0, i)) as any;
          buffer = buffer.slice(i + 1);
          if (envelope.type === "event") output.push(envelope.event);
          else if (envelope.type === "result") output.end(envelope.message);
          else if (envelope.type === "error") fail(envelope.message);
        }
      });
      socket.on("error", (error) => fail(error.message));
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
