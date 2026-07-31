import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, } from "node:fs";
import { basename, dirname, join } from "node:path";
import { RecorderError } from "./errors.js";
const canonicalRowId = /^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const inode = (identity) => `${identity.dev}:${identity.ino}`;
function modified(action) {
    try {
        return action();
    }
    catch (error) {
        if (error instanceof RecorderError)
            throw error;
        throw new RecorderError("session-modified", undefined, { cause: error });
    }
}
function inventory(directory) {
    return modified(() => readdirSync(directory)
        .sort()
        .flatMap((name) => {
        const path = join(directory, name);
        const stats = lstatSync(path);
        const identity = `${name}:${stats.mode}:${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
        if (name !== "reviewer-legs" ||
            !stats.isDirectory() ||
            stats.isSymbolicLink())
            return [identity];
        return [
            identity,
            ...readdirSync(path)
                .sort()
                .map((legName) => {
                const legStats = lstatSync(join(path, legName));
                return `${name}/${legName}:${legStats.mode}:${legStats.dev}:${legStats.ino}:${legStats.size}:${legStats.mtimeMs}:${legStats.ctimeMs}`;
            }),
        ];
    })
        .join("\n"));
}
function assertRealAncestors(root, path) {
    let current = root;
    try {
        const rootStats = lstatSync(current);
        if (!rootStats.isDirectory() || rootStats.isSymbolicLink())
            throw new RecorderError("session-collision");
    }
    catch (error) {
        if (error instanceof RecorderError)
            throw error;
        throw new RecorderError("session-collision", undefined, { cause: error });
    }
    for (const part of path
        .slice(root.length)
        .split(/[\\/]+/)
        .filter(Boolean)) {
        current = join(current, part);
        try {
            const stats = lstatSync(current);
            if (!stats.isDirectory() || stats.isSymbolicLink())
                throw new RecorderError("session-collision");
        }
        catch (error) {
            if (error.code === "ENOENT")
                return;
            if (error instanceof RecorderError)
                throw error;
            throw new RecorderError("session-collision", undefined, { cause: error });
        }
    }
}
export function createSessionLeaf(config) {
    const path = join(config.archive.repositoryRoot, config.session.directory);
    assertRealAncestors(config.archive.repositoryRoot, dirname(path));
    try {
        mkdirSync(path, { mode: 0o700 });
    }
    catch (error) {
        throw new RecorderError("session-collision", undefined, { cause: error });
    }
    const stats = lstatSync(path);
    if (!stats.isDirectory() ||
        stats.isSymbolicLink() ||
        (stats.mode & 0o777) !== 0o700 ||
        readdirSync(path).length) {
        throw new RecorderError("session-collision");
    }
    return { path, dev: stats.dev, ino: stats.ino };
}
export function readSession(config, owner, onRow = () => { }) {
    const directoryStats = modified(() => lstatSync(owner.path));
    if (inode(directoryStats) !== inode(owner) ||
        !directoryStats.isDirectory() ||
        directoryStats.isSymbolicLink()) {
        throw new RecorderError("session-modified");
    }
    const names = modified(() => readdirSync(owner.path));
    const mainNames = [];
    for (const name of names) {
        const path = join(owner.path, name);
        const stats = modified(() => lstatSync(path));
        if (name === "reviewer-legs") {
            if (!stats.isDirectory() || stats.isSymbolicLink())
                throw new RecorderError("session-ambiguous");
            for (const legName of modified(() => readdirSync(path))) {
                const legStats = modified(() => lstatSync(join(path, legName)));
                if (!legStats.isFile() ||
                    legStats.isSymbolicLink() ||
                    !legName.endsWith(".jsonl")) {
                    throw new RecorderError("session-ambiguous");
                }
            }
            continue;
        }
        if (stats.isFile() &&
            !stats.isSymbolicLink() &&
            name.endsWith(`_${config.session.id}.jsonl`))
            mainNames.push(name);
        else
            throw new RecorderError("session-ambiguous");
    }
    if (!mainNames.length)
        throw new RecorderError("session-missing");
    if (mainNames.length !== 1)
        throw new RecorderError("session-ambiguous");
    const path = join(owner.path, mainNames[0]);
    const beforeInventory = inventory(owner.path);
    const noFollow = constants.O_NOFOLLOW;
    if (noFollow === undefined)
        throw new RecorderError("session-ambiguous");
    let descriptor;
    try {
        descriptor = openSync(path, constants.O_RDONLY | noFollow);
    }
    catch (error) {
        throw new RecorderError("session-modified", undefined, { cause: error });
    }
    try {
        const before = fstatSync(descriptor);
        if (!before.isFile())
            throw new RecorderError("session-ambiguous");
        const pathStats = modified(() => lstatSync(path));
        if (inode(pathStats) !== inode(before) || pathStats.isSymbolicLink())
            throw new RecorderError("session-modified");
        const hash = createHash("sha256");
        const rowIds = new Set();
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let total = 0;
        let carry = Buffer.alloc(0);
        let entries = 0;
        let previousRowId = null;
        while (total < before.size) {
            const bytesRead = readSync(descriptor, buffer, 0, Math.min(buffer.length, before.size - total), null);
            if (!bytesRead)
                break;
            const chunk = Buffer.from(buffer.subarray(0, bytesRead));
            hash.update(chunk);
            total += bytesRead;
            carry = Buffer.concat([carry, chunk]);
            let newline;
            while ((newline = carry.indexOf(10)) >= 0) {
                const line = carry.subarray(0, newline);
                carry = carry.subarray(newline + 1);
                if (line.length + 1 > 16 * 1024 * 1024 ||
                    ++entries > 100000 ||
                    !line.length) {
                    throw new RecorderError("session-corrupt");
                }
                try {
                    const row = JSON.parse(line.toString("utf8"));
                    if (!row || typeof row !== "object" || Array.isArray(row))
                        throw new Error("invalid row");
                    const record = row;
                    const index = entries - 1;
                    if (index === 0) {
                        if (Object.keys(record).sort().join(",") !==
                            "cwd,id,timestamp,type,version" ||
                            record.type !== "session" ||
                            record.version !== 3 ||
                            record.id !== config.session.id ||
                            record.cwd !== config.execution.cwd ||
                            typeof record.timestamp !== "string" ||
                            Number.isNaN(Date.parse(record.timestamp)) ||
                            new Date(record.timestamp).toISOString() !== record.timestamp) {
                            throw new Error("invalid session header");
                        }
                    }
                    else {
                        if (record.type === "session" ||
                            typeof record.id !== "string" ||
                            !canonicalRowId.test(record.id) ||
                            rowIds.has(record.id) ||
                            record.parentId !== previousRowId) {
                            throw new Error("invalid row identity");
                        }
                        rowIds.add(record.id);
                        previousRowId = record.id;
                    }
                    onRow(row, index);
                }
                catch (error) {
                    if (error instanceof RecorderError)
                        throw error;
                    throw new RecorderError("session-corrupt");
                }
            }
            if (carry.length >= 16 * 1024 * 1024)
                throw new RecorderError("session-corrupt");
        }
        if (total !== before.size || carry.length || entries === 0)
            throw new RecorderError("session-corrupt");
        const after = fstatSync(descriptor);
        if (after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs ||
            after.mode !== before.mode ||
            inode(after) !== inode(before)) {
            throw new RecorderError("session-modified");
        }
        const verify = () => {
            const currentFile = modified(() => lstatSync(path));
            const currentDirectory = modified(() => lstatSync(owner.path));
            if (inode(currentFile) !== inode(before) ||
                currentFile.size !== before.size ||
                currentFile.mtimeMs !== before.mtimeMs ||
                currentFile.ctimeMs !== before.ctimeMs ||
                currentFile.mode !== before.mode ||
                inode(currentDirectory) !== inode(owner) ||
                inventory(owner.path) !== beforeInventory) {
                throw new RecorderError("session-modified");
            }
        };
        verify();
        return {
            rowCount: entries,
            basename: basename(path),
            sha256: hash.digest("hex"),
            byteLength: total,
            verify,
        };
    }
    finally {
        closeSync(descriptor);
    }
}
