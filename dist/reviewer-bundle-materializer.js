import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { sha256Hex } from "./sha256.js";
import { verifyBundleIdentity } from "./reviewer-construction.js";
function confined(root, candidate) {
    const rel = relative(root, candidate);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export async function materializeMechanicalBundle(workspace, leg, bundle) {
    if (!verifyBundleIdentity(bundle))
        throw new Error("Mechanical bundle digest or manifest mismatch");
    const root = await realpath(workspace);
    const destinations = new Set();
    const staged = [];
    try {
        for (const item of bundle.entries) {
            if (isAbsolute(item.relativeClonePath) || item.relativeClonePath.includes("\\") || item.relativeClonePath.split("/").some((part) => !part || part === "." || part === ".."))
                throw new Error("Mechanical bundle path is not confined");
            const destination = resolve(root, item.relativeClonePath);
            if (!confined(root, destination) || destinations.has(destination.normalize("NFC")))
                throw new Error("Mechanical bundle path collision or escape");
            destinations.add(destination.normalize("NFC"));
            const parent = dirname(destination);
            await mkdir(parent, { recursive: true });
            let cursor = parent;
            while (cursor !== root) {
                if ((await lstat(cursor)).isSymbolicLink())
                    throw new Error("Mechanical bundle parent is a symlink");
                cursor = dirname(cursor);
            }
            try {
                await lstat(destination);
                throw new Error("Mechanical bundle destination collision");
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
            const temporary = join(parent, `.ak-reviewer-${randomUUID()}.tmp`);
            const handle = await open(temporary, "wx", 0o600);
            let primary;
            try {
                await handle.writeFile(item.bytes, "utf8");
                await handle.sync();
            }
            catch (error) {
                primary = error;
            }
            try {
                await handle.close();
            }
            catch (error) {
                if (primary !== undefined)
                    throw new AggregateError([primary, error], "Bundle write and close failed", { cause: primary });
                throw error;
            }
            if (primary !== undefined)
                throw primary;
            staged.push({ temporary, destination });
        }
        for (const item of staged)
            await rename(item.temporary, item.destination);
        for (const item of bundle.entries) {
            const destination = resolve(root, item.relativeClonePath);
            const stat = await lstat(destination);
            if (!stat.isFile() || stat.isSymbolicLink())
                throw new Error("Mechanical bundle readback is not a regular file");
            const bytes = await readFile(destination);
            if (bytes.byteLength !== item.utf8Length || sha256Hex(bytes) !== item.sha256)
                throw new Error("Mechanical bundle readback mismatch");
        }
        return Object.freeze({ leg, workspaceIdentity: sha256Hex(root), manifestSha256: bundle.manifestSha256, entries: Object.freeze(bundle.entries.map(({ id, relativeClonePath, utf8Length, sha256 }) => Object.freeze({ id, relativeClonePath, utf8Length, sha256, verified: true, readable: true }))) });
    }
    catch (error) {
        await Promise.all(staged.map(({ temporary, destination }) => Promise.all([rm(temporary, { force: true }), rm(destination, { force: true })])));
        throw error;
    }
}
