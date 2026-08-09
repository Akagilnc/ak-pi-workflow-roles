import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runMachinePiRpc } from "./machine-pi-rpc.js";
export class AuditorTurnLimitError extends Error {
    limit;
    constructor(limit) {
        super(`Auditor exceeded ${limit} turns`);
        this.limit = limit;
        this.name = "AuditorTurnLimitError";
    }
}
export async function runAuditorRole(options) {
    if (options.runCompletion !== undefined)
        throw new Error("in-process Auditor completion is no longer a production runtime authority");
    const model = options.context.model;
    if (model === undefined)
        throw new Error(`${options.roleLabel} requires an active model`);
    const parentFile = options.context.sessionManager?.getSessionFile();
    if (parentFile === undefined)
        throw new Error(`${options.roleLabel} requires a durable parent session`);
    const sessionDir = join(options.context.sessionManager.getSessionDir(), "auditor-roles");
    const configPath = join(sessionDir, `config-${Date.now()}-${process.pid}.json`);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(configPath, `${JSON.stringify({ systemPrompt: options.systemPrompt, tool: { name: options.tool.name, description: options.tool.description, parameters: options.tool.parameters } })}\n`, "utf8");
    const extensionPath = fileURLToPath(new URL("../extensions/auditor-rpc.ts", import.meta.url));
    const result = await runMachinePiRpc({
        cwd: options.context.cwd ?? process.cwd(),
        sessionDir,
        args: ["--no-extensions", "-e", extensionPath, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--provider", model.provider, "--model", model.id, "--thinking", options.context.thinkingLevel ?? "off", "--tools", `read,grep,find,ls,bash,write,edit,${options.tool.name}`, `--ak-auditor-rpc-config=${configPath}`],
        commands: [
            { id: "retry", type: "set_auto_retry", enabled: false },
            { id: "compaction", type: "set_auto_compaction", enabled: false },
            { id: "prompt", type: "prompt", message: options.serializedInput },
        ],
        decisionToolName: options.tool.name,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (result.decision === undefined || result.response === undefined)
        throw new Error(`${options.roleLabel} exited without a readable decision receipt${result.stderr === "" ? "" : `: ${result.stderr}`}`);
    return { decision: result.decision, response: result.response };
}
