import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { machinePiRuntimeFromActivation, runMachinePiRpc } from "./machine-pi-rpc.ts";
import { prepareComplianceDispatch } from "./compliance-transport.ts";
import { AUDITOR_BRIDGE_MODEL_ID, AUDITOR_BRIDGE_PROVIDER_ID, createAuditorProviderBridge } from "./auditor-provider-bridge.ts";

export type AuditorDecisionTool = { name: string; description: string; parameters: object; execute(...args: any[]): Promise<AgentToolResult<unknown>> };

export async function runAuditorRole(options: { systemPrompt: string; serializedInput: string; tool: AuditorDecisionTool; roleLabel: string; context: ExtensionContext; signal?: AbortSignal }): Promise<{ decision: unknown; response: AssistantMessage }> {
  const model = options.context.model;
  if (model === undefined) throw new Error(`${options.roleLabel} requires an active model`);
  const parentFile = options.context.sessionManager?.getSessionFile();
  if (parentFile === undefined) throw new Error(`${options.roleLabel} requires a durable parent session`);
  const sessionDir = resolve(options.context.sessionManager.getSessionDir(), "auditor-roles");
  const nonce = `${Date.now()}-${process.pid}`;
  const configPath = join(sessionDir, `config-${nonce}.json`);
  const socketPath = join(tmpdir(), `ak-aud-${process.pid}-${randomUUID()}.sock`);
  await mkdir(sessionDir, { recursive: true });
  const dispatch = await prepareComplianceDispatch(model, options.context, options.roleLabel);
  const provider = typeof options.context.modelRegistry.getProvider === "function" ? options.context.modelRegistry.getProvider(model.provider) : { id: model.provider, name: options.roleLabel, auth: {}, getModels: () => [dispatch.model], stream() { throw new Error("host provider dispatch is unavailable"); }, streamSimple() { throw new Error("host provider dispatch is unavailable"); } };
  if (provider === undefined) throw new Error(`${options.roleLabel} provider not found: ${model.provider}`);
  const bridge = await createAuditorProviderBridge({ socketPath, provider, model: dispatch.model, auth: dispatch.auth });
  const childModel = {
    id: AUDITOR_BRIDGE_MODEL_ID,
    provider: AUDITOR_BRIDGE_PROVIDER_ID,
    name: "Private auditor bridge",
    api: dispatch.model.api,
    reasoning: dispatch.model.reasoning,
    input: dispatch.model.input,
    cost: dispatch.model.cost,
    contextWindow: dispatch.model.contextWindow,
    maxTokens: dispatch.model.maxTokens,
  };
  await writeFile(configPath, `${JSON.stringify({ systemPrompt: options.systemPrompt, model: childModel, socketPath, tool: { name: options.tool.name, description: options.tool.description, parameters: options.tool.parameters } })}\n`, "utf8");
  const extensionPath = fileURLToPath(new URL("../extensions/auditor-rpc.ts", import.meta.url));
  let result;
  try { result = await runMachinePiRpc({
    runtime: machinePiRuntimeFromActivation(),
    env: { ...process.env, AK_AUDITOR_RPC_CONFIG: configPath },
    cwd: options.context.cwd ?? process.cwd(),
    sessionDir,
    args: ["--no-extensions", "-e", extensionPath, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--provider", AUDITOR_BRIDGE_PROVIDER_ID, "--model", AUDITOR_BRIDGE_MODEL_ID, "--thinking", options.context.thinkingLevel ?? "off", "--tools", `read,grep,find,ls,bash,write,edit,${options.tool.name}`, `--ak-auditor-rpc-config=${configPath}`],
    commands: [
      { id: "retry", type: "set_auto_retry", enabled: false },
      { id: "compaction", type: "set_auto_compaction", enabled: false },
      { id: "prompt", type: "prompt", message: options.serializedInput },
    ],
    decisionToolName: options.tool.name,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }); } finally { await bridge.close(); }
  if (result.decision === undefined || result.response === undefined) throw new Error(`${options.roleLabel} exited without a readable decision receipt${result.stderr === "" ? "" : `: ${result.stderr}`}`);
  return { decision: result.decision, response: result.response as unknown as AssistantMessage };
}
