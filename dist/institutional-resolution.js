import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { seatModelOnly } from "./public-cli/config.js";
export const INSTITUTIONAL_RESOLUTION_FILE = "institutional-resolution.json";
export class InstitutionalResolutionError extends Error {
    reason;
    constructor(message, reason, options) {
        super(message, options);
        this.name = "InstitutionalResolutionError";
        this.reason = reason;
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
 * - navigator: explicit config seat only. Navigator model authority stays
 *   `navigator-model.json`; the page never carries a parent-inherited navigator
 *   seat, so host-neutral transport cannot shadow that setting (#590 Out of Scope:
 *   席位表／模型路由变更归 owner 域).
 */
export function resolveInstitutionalSeatSelections(config, parentEffectiveModel) {
    const parentSelection = cleanSelection(parentEffectiveModel);
    const ownInspector = cleanSelection(seatModelOnly(config.seats?.inspector));
    const ownNotary = cleanSelection(seatModelOnly(config.seats?.notary));
    const ownGatekeeper = cleanSelection(seatModelOnly(config.seats?.gatekeeper));
    const ownNavigator = cleanSelection(seatModelOnly(config.seats?.navigator));
    const gatekeeper = ownGatekeeper ?? parentSelection;
    const inspector = ownInspector ?? ownGatekeeper ?? parentSelection;
    const notary = ownNotary ?? ownGatekeeper ?? parentSelection;
    const auditor = parentSelection;
    const evidenceChild = parentSelection;
    const navigator = ownNavigator;
    return {
        version: 1,
        seats: {
            ...(gatekeeper === undefined ? {} : { gatekeeper }),
            ...(inspector === undefined ? {} : { inspector }),
            ...(notary === undefined ? {} : { notary }),
            ...(auditor === undefined ? {} : { auditor }),
            ...(evidenceChild === undefined ? {} : { evidenceChild }),
            ...(navigator === undefined ? {} : { navigator }),
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
        throw new InstitutionalResolutionError(`institutional resolution page is missing at ${filePath}`, "missing-page", { cause: error });
    }
    let page;
    try {
        page = JSON.parse(raw);
    }
    catch (error) {
        throw new InstitutionalResolutionError(`institutional resolution page is corrupted at ${filePath}`, "corrupted", { cause: error });
    }
    if (typeof page !== "object" || page === null || page.version !== 1) {
        throw new InstitutionalResolutionError(`institutional resolution page format is invalid at ${filePath}`, "invalid-format");
    }
    const seats = page.seats;
    if (typeof seats !== "object" || seats === null) {
        throw new InstitutionalResolutionError(`institutional resolution page missing seats object at ${filePath}`, "invalid-format");
    }
    const selection = cleanSelection(seats[seat]);
    if (selection === undefined) {
        throw new InstitutionalResolutionError(`institutional resolution page has no resolution for seat "${seat}" at ${filePath}`, "missing-seat");
    }
    return selection;
}
