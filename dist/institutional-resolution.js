import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { seatModelOnly } from "./public-cli/config.js";
export const INSTITUTIONAL_RESOLUTION_FILE = "institutional-resolution.json";
export class InstitutionalResolutionError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "InstitutionalResolutionError";
    }
}
function cleanSelection(model) {
    if (model === undefined)
        return undefined;
    if (typeof model.provider !== "string" || typeof model.model !== "string")
        return undefined;
    return {
        provider: model.provider,
        model: model.model,
        ...(model.thinking === undefined ? {} : { thinking: model.thinking }),
    };
}
/**
 * Resolve effective per-seat institutional selections (#518 §2 Hop 1):
 * - gatekeeper / inspector / notary: seat override > gatekeeper override > parent effective
 * - auditor / evidenceChild: parent effective
 */
export function resolveInstitutionalSeatSelections(config, parentEffectiveModel) {
    const parentSelection = cleanSelection(parentEffectiveModel);
    const ownInspector = cleanSelection(seatModelOnly(config.seats?.inspector));
    const ownNotary = cleanSelection(seatModelOnly(config.seats?.notary));
    const ownGatekeeper = cleanSelection(seatModelOnly(config.seats?.gatekeeper));
    const gatekeeper = ownGatekeeper ?? parentSelection;
    const inspector = ownInspector ?? ownGatekeeper ?? parentSelection;
    const notary = ownNotary ?? ownGatekeeper ?? parentSelection;
    const auditor = parentSelection;
    const evidenceChild = parentSelection;
    return {
        version: 1,
        seats: {
            ...(gatekeeper === undefined ? {} : { gatekeeper }),
            ...(inspector === undefined ? {} : { inspector }),
            ...(notary === undefined ? {} : { notary }),
            ...(auditor === undefined ? {} : { auditor }),
            ...(evidenceChild === undefined ? {} : { evidenceChild }),
        },
    };
}
/**
 * Persist institutional resolution page to run directory (#518 §2 Hop 2).
 * Rewritten on each dispatch and resume. Zero secrets inside page.
 */
export async function writeInstitutionalResolutionPage(runDirectory, page) {
    const filePath = join(runDirectory, INSTITUTIONAL_RESOLUTION_FILE);
    await writeFile(filePath, `${JSON.stringify(page, null, 2)}\n`, "utf8");
}
/**
 * Read institutional seat selection from run directory (#518 §2 Hop 3).
 * Fails loud if page is missing, corrupted, or does not contain a resolution for the seat.
 */
export async function readInstitutionalSeatSelection(runDirectory, seat) {
    const filePath = join(runDirectory, INSTITUTIONAL_RESOLUTION_FILE);
    let raw;
    try {
        raw = await readFile(filePath, "utf8");
    }
    catch (error) {
        throw new InstitutionalResolutionError(`institutional resolution page is missing at ${filePath}`, { cause: error });
    }
    let page;
    try {
        page = JSON.parse(raw);
    }
    catch (error) {
        throw new InstitutionalResolutionError(`institutional resolution page is corrupted at ${filePath}`, { cause: error });
    }
    if (typeof page !== "object" || page === null || page.version !== 1) {
        throw new InstitutionalResolutionError(`institutional resolution page format is invalid at ${filePath}`);
    }
    const seats = page.seats;
    if (typeof seats !== "object" || seats === null) {
        throw new InstitutionalResolutionError(`institutional resolution page missing seats object at ${filePath}`);
    }
    const selection = cleanSelection(seats[seat]);
    if (selection === undefined) {
        throw new InstitutionalResolutionError(`institutional resolution page has no resolution for seat "${seat}" at ${filePath}`);
    }
    return selection;
}
