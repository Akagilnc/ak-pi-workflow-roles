import { dirname, join, resolve } from "node:path";

import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const AUDITOR_DOSSIER_TOOL_NAME = "ak_get_run_dossier" as const;

export type AuditorDossierLocation = {
  readonly runDirectory: string;
  readonly admittedRequest: string;
  readonly parentSessionCandidate: string;
  readonly attachments: string;
  readonly artifacts: string;
};

/** Resolve the exact run binding already carried by the parent record session. */
export function auditorRunDirectory(context: ExtensionContext): string | undefined {
  const sessionFile = context.sessionManager?.getSessionFile?.();
  return sessionFile === undefined ? undefined : resolve(dirname(dirname(sessionFile)));
}

/** The one shared, run-bound dossier locator exposed to every auditor seat. */
export function createAuditorDossierTool(runDirectory: string | undefined) {
  return {
    name: AUDITOR_DOSSIER_TOOL_NAME,
    description: "定位本审计席绑定的 run 卷宗及其证据入口。",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id: string, _params: unknown): Promise<AgentToolResult<AuditorDossierLocation | undefined>> {
      if (runDirectory === undefined) {
        return {
          content: [{ type: "text", text: "本审计席无绑定 run 卷宗记录。" }],
          details: undefined,
        };
      }
      const details: AuditorDossierLocation = {
        runDirectory,
        admittedRequest: join(runDirectory, "admitted-request.json"),
        parentSessionCandidate: join(runDirectory, "session", "session.jsonl"),
        attachments: join(runDirectory, "attachments"),
        artifacts: join(runDirectory, "artifacts"),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    },
  };
}
