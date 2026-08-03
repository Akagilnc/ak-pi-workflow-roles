import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { immutableReviewerRefs, parseReviewerRefSnapshot, reviewerRefSnapshotArgs } from "./reviewer-git-snapshot.js";
import { sha256Hex } from "./sha256.js";
import { ReviewerCorrectablePreflightError } from "./reviewer-preflight-error.js";
import { exactUtf8 } from "./exact-utf8.js";
import { ReviewerAdmissionError } from "./reviewer-admission.js";
const execFileAsync = promisify(execFile);
async function execGit(args, options) {
    try {
        return await execFileAsync("git", args, options);
    }
    catch (error) {
        const source = error;
        const wrapped = new Error("git process failed", { cause: error });
        Object.assign(wrapped, { code: source.code ?? null, signal: source.signal ?? null, timedOut: source.killed === true && source.signal === "SIGTERM", aborted: source.name === "AbortError", stderr: String(source.stderr ?? ""), stdout: String(source.stdout ?? "") });
        throw wrapped;
    }
}
function exitCode(error) { const code = typeof error === "object" && error !== null ? error.code : undefined; return typeof code === "number" ? code : undefined; }
async function repositoryIsAvailable(root) { try {
    await access(`${root}/.git`);
    return true;
}
catch {
    return false;
} }
const evidenceViolation = (code) => {
    const diagnostic = code === "range-invalid"
        ? "derived range must match the resolved base and pinned target with canonical command, digest, and unique commits"
        : code === "material-invalid"
            ? "selected material must be valid UTF-8 at the pinned target"
            : "capability constraint failed while acquiring pinned evidence";
    if (code === "capability-invalid")
        throw new ReviewerAdmissionError(code, diagnostic);
    throw new ReviewerCorrectablePreflightError(code, diagnostic);
};
const classifyEvidenceRead = (error) => { if (error instanceof ReviewerCorrectablePreflightError)
    throw error; throw error; };
/** Acquires and normalizes all proposal-dependent bytes against the immutable pin. */
export async function acquireReviewerPinnedEvidence(reader, target, admitted) {
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
    const { stdout } = await execGit(["-C", root, ...args], { encoding: "utf8" });
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
    const invalid = (code, diagnostic) => {
        throw new ReviewerCorrectablePreflightError(code, diagnostic);
    };
    const symbolic = (base) => {
        const selected = Object.hasOwn(refs, base) ? base : (() => {
            const candidates = [`refs/heads/${base}`, `refs/tags/${base}`, `refs/remotes/${base}`].filter((name) => Object.hasOwn(refs, name));
            if (candidates.length > 1)
                invalid("base-invalid", "base revision is ambiguous across pinned refs");
            return candidates[0];
        })();
        if (selected === undefined)
            return undefined;
        const commit = refs[selected]?.peeledCommitId;
        if (commit === null)
            invalid("base-invalid", "base revision ref must resolve to a commit");
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
            if (!/^[A-Za-z0-9._/~^+-]+$/.test(base) || base.startsWith("-") || base.includes("..") || base.includes("@{")) {
                invalid("base-invalid", "base revision syntax is invalid or uses a forbidden revision form");
            }
            let commit;
            const headExpression = /^HEAD((?:~[0-9]+|\^[0-9]+)*)$/.exec(base);
            if (headExpression) {
                try {
                    commit = await gitText(repositoryRoot, ["rev-parse", "--verify", `${targetHead}${headExpression[1]}^{commit}`]);
                }
                catch (error) {
                    if (exitCode(error) === 128 && await repositoryIsAvailable(repositoryRoot)) {
                        invalid("base-invalid", "base revision HEAD ancestry expression must resolve to a reachable commit");
                    }
                    throw error;
                }
            }
            else if (new RegExp(`^[0-9a-f]{${oidWidth}}$`).test(base))
                commit = base;
            else if (new RegExp(`^[0-9a-f]{4,${oidWidth - 1}}$`).test(base) && !(objectFormat === "sha256" && base.length === 40)) {
                const matches = reachableCommitIds.filter((candidate) => candidate.startsWith(base));
                if (matches.length !== 1)
                    invalid("base-invalid", "base revision abbreviation must identify exactly one reachable commit");
                commit = matches[0];
            }
            else
                commit = symbolic(base);
            if (commit === undefined)
                invalid("base-invalid", "base revision must name an existing pinned ref or reachable commit");
            try {
                commit = await gitText(repositoryRoot, ["rev-parse", "--verify", `${commit}^{commit}`]);
            }
            catch (error) {
                if (exitCode(error) === 128 && await repositoryIsAvailable(repositoryRoot))
                    invalid("base-invalid", "base revision must resolve to an existing commit");
                throw error;
            }
            try {
                await gitText(repositoryRoot, ["merge-base", "--is-ancestor", commit, targetHead]);
            }
            catch (error) {
                if (exitCode(error) === 1)
                    invalid("base-invalid", "base revision must be an ancestor of the pinned target");
                throw error;
            }
            return commit;
        },
        async range(base) {
            let mergeBase;
            try {
                mergeBase = await gitText(repositoryRoot, ["merge-base", base, targetHead]);
            }
            catch (error) {
                if (exitCode(error) === 1) {
                    invalid("range-invalid", "review range requires a common ancestor for base and pinned target");
                }
                throw error;
            }
            if (!mergeBase)
                invalid("range-invalid", "review range requires a common ancestor for base and pinned target");
            const diffCommand = `git diff ${mergeBase}...${targetHead}`;
            const [{ stdout: diff }, commitsText] = await Promise.all([
                execGit(["-C", repositoryRoot, "diff", `${mergeBase}...${targetHead}`], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }),
                gitText(repositoryRoot, ["rev-list", "--reverse", `${mergeBase}..${targetHead}`]),
            ]);
            if (diff.length === 0)
                invalid("range-invalid", "review range must contain a non-empty diff between base and pinned target");
            return Object.freeze({ base: mergeBase, target: targetHead, diffCommand, diffSha256: sha256Hex(Uint8Array.from(diff)), commits: Object.freeze(commitsText ? commitsText.split("\n") : []) });
        },
        async material(path, revision) {
            if (revision !== targetHead)
                throw new Error("Material revision is not the pinned target");
            if (path.startsWith("/"))
                invalid("material-invalid", "materials.repositoryPath must be relative, not absolute");
            if (path.includes("\\"))
                invalid("material-invalid", "materials.repositoryPath must not contain backslashes");
            if (/[\u0000-\u001f\u007f]/u.test(path))
                invalid("material-invalid", "materials.repositoryPath must not contain control characters");
            if (path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
                invalid("material-invalid", "materials.repositoryPath must not contain empty, current-directory, or parent-directory segments");
            }
            try {
                const { stdout } = await execGit(["-C", repositoryRoot, "show", `${revision}:${path}`], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
                return Uint8Array.from(stdout);
            }
            catch (error) {
                if (exitCode(error) === 128 && await repositoryIsAvailable(repositoryRoot)) {
                    invalid("material-invalid", "pinned material at materials.repositoryPath is missing from the target");
                }
                throw error;
            }
        },
    });
}
