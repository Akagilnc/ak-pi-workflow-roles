/**
 * Shared MCP tools/call helper for public-entry + fake-host tests (#1171).
 * One seam definition — consumers must not fork a second copy.
 */
import { connect } from "node:net";
import assert from "node:assert/strict";

export async function callMcpTool(input: {
  readonly socketPath: string;
  readonly token: string;
  readonly name: string;
  readonly args: unknown;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const sock = connect(input.socketPath);
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      buf += chunk;
      if (!buf.includes("\n")) return;
      sock.destroy();
      const reply = JSON.parse(buf.split("\n")[0]!) as { error?: unknown };
      if (reply.error !== undefined) reject(new Error(JSON.stringify(reply.error)));
      else resolve();
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
