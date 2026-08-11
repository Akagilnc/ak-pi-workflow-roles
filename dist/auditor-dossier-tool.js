import { dirname, join, resolve } from "node:path";
import { Type } from "typebox";
export const AUDITOR_DOSSIER_TOOL_NAME = "ak_get_run_dossier";
/** Resolve the exact run binding already carried by the parent record session. */
export function auditorRunDirectory(context) {
    const sessionFile = context.sessionManager?.getSessionFile?.();
    return sessionFile === undefined ? undefined : resolve(dirname(dirname(sessionFile)));
}
/** The one shared, run-bound dossier locator exposed to every auditor seat. */
export function createAuditorDossierTool(runDirectory) {
    return {
        name: AUDITOR_DOSSIER_TOOL_NAME,
        description: "Locate this auditor's bound run dossier and its evidence entry points.",
        parameters: Type.Object({}, { additionalProperties: false }),
        async execute(_id, _params) {
            if (runDirectory === undefined) {
                return {
                    content: [{ type: "text", text: "This auditor has no run-bound dossier record." }],
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
