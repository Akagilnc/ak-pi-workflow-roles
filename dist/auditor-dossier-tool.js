import { dirname, join, resolve } from "node:path";
import { Type } from "typebox";
export const AUDITOR_DOSSIER_TOOL_NAME = "ak_get_run_dossier";
/** Resolve the exact run binding already carried by the parent record session. */
export function auditorRunDirectory(context) {
    const sessionFile = context.sessionManager?.getSessionFile?.();
    if (sessionFile !== undefined)
        return resolve(dirname(dirname(sessionFile)));
    return undefined;
}
/** The one shared, run-bound dossier locator exposed to every auditor seat. */
export function createAuditorDossierTool(runDirectory) {
    return {
        name: AUDITOR_DOSSIER_TOOL_NAME,
        description: "定位本审计席绑定的 run 卷宗及其证据入口。",
        parameters: Type.Object({}, { additionalProperties: false }),
        async execute(_id, _params) {
            if (runDirectory === undefined) {
                return {
                    content: [{ type: "text", text: "本审计席无绑定 run 卷宗记录。" }],
                    details: undefined,
                };
            }
            const details = {
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
