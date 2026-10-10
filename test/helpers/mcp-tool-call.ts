/**
 * Shared MCP tools/call helper for public-entry + fake-host tests (#1171 / #1214).
 * One seam definition — consumers must not fork a second copy.
 */
import { connect } from "node:net";
import assert from "node:assert/strict";

export type McpToolCallReply = {
  readonly content?: unknown;
  readonly isError?: boolean;
  readonly error?: unknown;
};

export async function callMcpTool(input: {
  readonly socketPath: string;
  readonly token: string;
  readonly name: string;
  readonly args: unknown;
}): Promise<McpToolCallReply> {
  return await new Promise<McpToolCallReply>((resolve, reject) => {
    const sock = connect(input.socketPath);
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      buf += chunk;
      if (!buf.includes("\n")) return;
      sock.destroy();
      try {
        const reply = JSON.parse(buf.split("\n")[0]!) as {
          result?: McpToolCallReply;
          error?: unknown;
        };
        if (reply.error !== undefined) {
          // Protocol/RPC error (not tool isError).
          reject(new Error(JSON.stringify(reply.error)));
          return;
        }
        resolve(reply.result ?? {});
      } catch (error) {
        reject(error);
      }
    });
    sock.on("error", reject);
    sock.on("connect", () => {
      sock.write(
        `${JSON.stringify({
          id: 1,
          token: input.token,
          method: "tools/call",
          params: { name: input.name, arguments: input.args },
        })}\n`,
      );
    });
  });
}

export function mcpTokenFromPrepared(prepared: { mcpServers: readonly unknown[] }): string {
  const envRows = (prepared.mcpServers[0] as { env?: Array<{ name: string; value: string }> } | undefined)
    ?.env ?? [];
  const token = envRows.find((row) => row.name === "AK_ACP_MCP_TOKEN")?.value;
  assert.ok(token, "MCP token required");
  return token;
}
