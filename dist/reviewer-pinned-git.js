import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { immutableReviewerRefs, parseReviewerRefSnapshot, reviewerRefSnapshotArgs } from "./reviewer-git-snapshot.js";
import { sha256Hex } from "./sha256.js";
import { ReviewerCorrectablePreflightError } from "./reviewer-preflight-error.js";
import { exactUtf8 } from "./exact-utf8.js";
import { ReviewerAdmissionError } from "./reviewer-admission.js";
const execFileAsync = promisify(execFile);
const evidenceViolation = (code) => { if (code === "capability-invalid")
    throw new ReviewerAdmissionError(code); throw new ReviewerCorrectablePreflightError(code); };
const classifyEvidenceRead = (error) => { if (error instanceof ReviewerCorrectablePreflightError)
    throw error; throw error; };
/** Acquires and normalizes all proposal-dependent bytes against the immutable pin. */
export async function acquireReviewerPinnedEvidence(reader, target, admitted, ceiling) {
    let base;
    let readRange;
    try {
        base = await reader.resolve(admitted.baseRevision);
        readRange = await reader.range(base);
    }
    catch (error) {
        classifyEvidenceRead(error);
    }
    if (readRange.base !== base || readRange.target !== target.targetHead || readRange.diffCommand !== `git diff ${base}...${target.targetHead}` || !/^[0-9a-f]{64}$/.test(readRange.diffSha256) || readRange.diffSha256 === sha256Hex("") || !Array.isArray(readRange.commits) || !readRange.commits.every(x => typeof x === "string") || new Set(readRange.commits).size !== readRange.commits.length)
        evidenceViolation("range-invalid");
    const range = Object.freeze({ ...readRange, commits: Object.freeze([...readRange.commits]) });
    const grants = [admitted.standardsGrant, ...(admitted.specGrant ? [admitted.specGrant] : [])];
    if (!ceiling.tools.includes("bash") || !ceiling.bashCommands.includes(range.diffCommand) || grants.some(g => !g.tools.includes("bash") || !g.bashCommands.includes(range.diffCommand) || g.bashCommands.some(c => !ceiling.bashCommands.includes(c))))
        evidenceViolation("capability-invalid");
    const materials = [];
    for (const item of admitted.materials) {
        let bytes;
        try {
            bytes = await reader.material(item.repositoryPath, target.targetHead);
        }
        catch (error) {
            classifyEvidenceRead(error);
        }
        let text;
        try {
            text = exactUtf8(bytes, "Reviewer material");
        }
        catch {
            evidenceViolation("material-invalid");
        }
        materials.push(Object.freeze({ ...item, text: text, utf8Length: bytes.byteLength, sha256: sha256Hex(bytes) }));
    }
    return Object.freeze({ range, materials: Object.freeze(materials) });
}
export const immutableReviewerPin = (pin) => Object.freeze({
    repositoryRoot: pin.repositoryRoot, objectFormat: pin.objectFormat, targetHead: pin.targetHead, refs: immutableReviewerRefs(pin.refs),
});
async function gitText(root, args) {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" });
    return stdout.trim();
}
/** Concrete fixed-point Git I/O; dispatch owns all policy applied to these reads. */
export async function createReviewerPinnedGitReader(root = process.cwd()) {
    const discoveredRoot = await gitText(root, ["rev-parse", "--show-toplevel"]);
    const repositoryRoot = await realpath(discoveredRoot);
    const objectFormat = await gitText(repositoryRoot, ["rev-parse", "--show-object-format"]);
    if (objectFormat !== "sha1" && objectFormat !== "sha256")
        throw new Error("Unsupported Git object format");
    const oidWidth = objectFormat === "sha1" ? 40 : 64;
    const targetHead = await gitText(repositoryRoot, ["rev-parse", "HEAD^{commit}"]);
    const reachableCommitIds = Object.freeze((await gitText(repositoryRoot, ["rev-list", targetHead])).split("\n").filter(Boolean));
    const refs = parseReviewerRefSnapshot(await gitText(repositoryRoot, reviewerRefSnapshotArgs()));
    const pin = immutableReviewerPin({ repositoryRoot, objectFormat, targetHead, refs });
    const invalid = (code) => {
        throw new ReviewerCorrectablePreflightError(code);
    };
    const symbolic = (base) => {
        const selected = Object.hasOwn(refs, base) ? base : (() => {
            const candidates = [`refs/heads/${base}`, `refs/tags/${base}`, `refs/remotes/${base}`].filter((name) => Object.hasOwn(refs, name));
            if (candidates.length > 1)
                invalid("base-invalid");
            return candidates[0];
        })();
        if (selected === undefined)
            return undefined;
        const commit = refs[selected]?.peeledCommitId;
        if (commit === null)
            invalid("base-invalid");
        return commit ?? undefined;
    };
    return Object.freeze({
        pin,
        async snapshot() {
            const liveObjectFormat = await gitText(repositoryRoot, ["rev-parse", "--show-object-format"]);
            if (liveObjectFormat !== "sha1" && liveObjectFormat !== "sha256")
                throw new Error("Unsupported Git object format");
            return immutableReviewerPin({ repositoryRoot, objectFormat: liveObjectFormat, targetHead: await gitText(repositoryRoot, ["rev-parse", "HEAD^{commit}"]), refs: parseReviewerRefSnapshot(await gitText(repositoryRoot, reviewerRefSnapshotArgs())) });
        },
        async resolve(base) {
            if (!/^[A-Za-z0-9._/~^+-]+$/.test(base) || base.startsWith("-") || base.includes("..") || base.includes("@{"))
                invalid("base-invalid");
            let commit;
            const headExpression = /^HEAD((?:~[0-9]+|\^[0-9]+)*)$/.exec(base);
            if (headExpression)
                commit = await gitText(repositoryRoot, ["rev-parse", "--verify", `${targetHead}${headExpression[1]}^{commit}`]);
            else if (new RegExp(`^[0-9a-f]{${oidWidth}}$`).test(base))
                commit = base;
            else if (new RegExp(`^[0-9a-f]{4,${oidWidth - 1}}$`).test(base) && !(objectFormat === "sha256" && base.length === 40)) {
                const matches = reachableCommitIds.filter((candidate) => candidate.startsWith(base));
                if (matches.length !== 1)
                    invalid("base-invalid");
                commit = matches[0];
            }
            else
                commit = symbolic(base);
            if (commit === undefined)
                invalid("base-invalid");
            try {
                commit = await gitText(repositoryRoot, ["rev-parse", "--verify", `${commit}^{commit}`]);
            }
            catch (error) {
                const stderr = String(error.stderr ?? "");
                if (typeof error.code === "number" && /Needed a single revision|unknown revision|bad object|not a valid object name/i.test(stderr))
                    invalid("base-invalid");
                throw error;
            }
            try {
                await gitText(repositoryRoot, ["merge-base", "--is-ancestor", commit, targetHead]);
            }
            catch (error) {
                if (error.code === 1)
                    invalid("base-invalid");
                throw error;
            }
            return commit;
        },
        async range(base) {
            const mergeBase = await gitText(repositoryRoot, ["merge-base", base, targetHead]);
            if (!mergeBase)
                invalid("range-invalid");
            const diffCommand = `git diff ${mergeBase}...${targetHead}`;
            const [{ stdout: diff }, commitsText] = await Promise.all([
                execFileAsync("git", ["-C", repositoryRoot, "diff", `${mergeBase}...${targetHead}`], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }),
                gitText(repositoryRoot, ["rev-list", "--reverse", `${mergeBase}..${targetHead}`]),
            ]);
            if (diff.length === 0)
                invalid("range-invalid");
            return Object.freeze({ base: mergeBase, target: targetHead, diffCommand, diffSha256: sha256Hex(Uint8Array.from(diff)), commits: Object.freeze(commitsText ? commitsText.split("\n") : []) });
        },
        async material(path, revision) {
            if (revision !== targetHead)
                throw new Error("Material revision is not the pinned target");
            if (path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f]/u.test(path) || path.split("/").some((segment) => !segment || segment === "." || segment === ".."))
                invalid("material-invalid");
            try {
                const { stdout } = await execFileAsync("git", ["-C", repositoryRoot, "show", `${revision}:${path}`], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
                return Uint8Array.from(stdout);
            }
            catch (error) {
                const stderr = String(error.stderr ?? "");
                if (typeof error.code === "number" && /does not exist in|exists on disk, but not in|path .* not in/i.test(stderr))
                    invalid("material-invalid");
                throw error;
            }
        },
    });
}
