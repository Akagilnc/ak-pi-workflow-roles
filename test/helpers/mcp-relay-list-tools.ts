/**
 * Shared ACP MCP tools/list probe for envelope tests (#1166 J8).
 * Token extraction reuses mcp-tool-call — request method differs, rule does not (#1171 F6-R2).
 */
import { createConnection } from "node:net";

export { mcpTokenFromPrepared as mcpRelayToken } from "./mcp-tool-call.ts";

export async function listMcpToolNames(
  socketPath: string,
  token: string,
): Promise<string[]> {
  const result = await new Promise<{ tools?: Array<{ name?: string }> }>((resolve, reject) => {
    const conn = createConnection(socketPath);
    let buffer = "";
    conn.setEncoding("utf8");
    conn.on("error", reject);
    conn.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const message = JSON.parse(buffer.slice(0, end)) as {
          result?: { tools?: Array<{ name?: string }> };
          error?: unknown;
        };
        if (message.error !== undefined) {
          reject(new Error(JSON.stringify(message.error)));
          return;
        }
        resolve(message.result ?? {});
      } catch (error) {
        reject(error);
      } finally {
        conn.end();
      }
    });
    conn.write(`${JSON.stringify({ id: 1, token, method: "tools/list" })}\n`);
  });
  return (result.tools ?? [])
    .map((tool) => tool.name)
    .filter((name): name is string => typeof name === "string");
}
