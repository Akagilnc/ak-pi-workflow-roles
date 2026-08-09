import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

const CONFIG_FLAG = "ak-auditor-rpc-config";
type Config = { systemPrompt: string; tool: { name: string; description: string; parameters: TSchema } };

export default function auditorRpcExtension(pi: ExtensionAPI) {
  pi.registerFlag(CONFIG_FLAG, { type: "string", description: "Internal auditor RPC configuration path" });
  let configured = false;
  pi.on("session_start", async () => {
    if (configured) return;
    const path = pi.getFlag(CONFIG_FLAG);
    if (typeof path !== "string" || path === "") throw new Error("auditor RPC configuration is missing");
    const config = JSON.parse(await readFile(path, "utf8")) as Config;
    pi.registerTool({
      name: config.tool.name,
      label: config.tool.description,
      description: config.tool.description,
      parameters: config.tool.parameters,
      async execute(_id, params) {
        return { content: [{ type: "text", text: "Compliance decision received" }], details: params, terminate: true };
      },
    });
    pi.on("before_agent_start", (event) => ({ systemPrompt: config.systemPrompt }));
    pi.setActiveTools([...new Set([...pi.getActiveTools(), config.tool.name])]);
    configured = true;
  });
}
