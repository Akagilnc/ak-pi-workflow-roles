import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { RecorderError } from "./errors.js";
const inode = (s) => `${s.dev}:${s.ino}`;
function modified(action) { try {
    return action();
}
catch (e) {
    if (e instanceof RecorderError)
        throw e;
    throw new RecorderError("session-modified", undefined, { cause: e });
} }
function inventory(dir) { return modified(() => readdirSync(dir).sort().flatMap(n => { const p = join(dir, n), s = lstatSync(p), head = `${n}:${s.mode}:${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; if (n !== "reviewer-legs" || !s.isDirectory() || s.isSymbolicLink())
    return [head]; return [head, ...readdirSync(p).sort().map(leg => { const x = lstatSync(join(p, leg)); return `${n}/${leg}:${x.mode}:${x.dev}:${x.ino}:${x.size}:${x.mtimeMs}:${x.ctimeMs}`; })]; }).join("\n")); }
function assertRealAncestors(root, path) { let current = root; try {
    const s = lstatSync(current);
    if (!s.isDirectory() || s.isSymbolicLink())
        throw new RecorderError("session-collision");
}
catch (e) {
    if (e instanceof RecorderError)
        throw e;
    throw new RecorderError("session-collision", undefined, { cause: e });
} for (const part of path.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    try {
        const s = lstatSync(current);
        if (!s.isDirectory() || s.isSymbolicLink())
            throw new RecorderError("session-collision");
    }
    catch (e) {
        if (e.code === "ENOENT")
            return;
        if (e instanceof RecorderError)
            throw e;
        throw new RecorderError("session-collision", undefined, { cause: e });
    }
} }
export function createSessionLeaf(config) { const path = join(config.archive.repositoryRoot, config.session.directory); assertRealAncestors(config.archive.repositoryRoot, dirname(path)); try {
    mkdirSync(path, { mode: 0o700 });
}
catch (e) {
    throw new RecorderError("session-collision", undefined, { cause: e });
} const s = lstatSync(path); if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o777) !== 0o700 || readdirSync(path).length)
    throw new RecorderError("session-collision"); return { path, dev: s.dev, ino: s.ino }; }
export function readSession(config, owner, onRow = () => { }) {
    const ds = modified(() => lstatSync(owner.path));
    if (inode(ds) !== `${owner.dev}:${owner.ino}` || !ds.isDirectory() || ds.isSymbolicLink())
        throw new RecorderError("session-modified");
    const names = modified(() => readdirSync(owner.path)), mains = [];
    for (const n of names) {
        const p = join(owner.path, n), s = modified(() => lstatSync(p));
        if (n === "reviewer-legs") {
            if (!s.isDirectory() || s.isSymbolicLink())
                throw new RecorderError("session-ambiguous");
            for (const leg of modified(() => readdirSync(p))) {
                const ls = modified(() => lstatSync(join(p, leg)));
                if (!ls.isFile() || ls.isSymbolicLink() || !leg.endsWith(".jsonl"))
                    throw new RecorderError("session-ambiguous");
            }
            continue;
        }
        if (s.isFile() && !s.isSymbolicLink() && n.endsWith(`_${config.session.id}.jsonl`))
            mains.push(n);
        else
            throw new RecorderError("session-ambiguous");
    }
    if (!mains.length)
        throw new RecorderError("session-missing");
    if (mains.length !== 1)
        throw new RecorderError("session-ambiguous");
    const path = join(owner.path, mains[0]), beforeInventory = inventory(owner.path), noFollow = constants.O_NOFOLLOW;
    if (noFollow === undefined)
        throw new RecorderError("session-ambiguous");
    let fd;
    try {
        fd = openSync(path, constants.O_RDONLY | noFollow);
    }
    catch (e) {
        throw new RecorderError("session-modified", undefined, { cause: e });
    }
    try {
        const before = fstatSync(fd);
        if (!before.isFile())
            throw new RecorderError("session-ambiguous");
        const ps = modified(() => lstatSync(path));
        if (inode(ps) !== inode(before) || ps.isSymbolicLink())
            throw new RecorderError("session-modified");
        const hash = createHash("sha256");
        let total = 0, carry = Buffer.alloc(0), entries = 0, previousId = null;
        const ids = new Set();
        const buffer = Buffer.allocUnsafe(64 * 1024);
        while (total < before.size) {
            const n = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - total), null);
            if (!n)
                break;
            const chunk = Buffer.from(buffer.subarray(0, n));
            hash.update(chunk);
            total += n;
            carry = Buffer.concat([carry, chunk]);
            let at;
            while ((at = carry.indexOf(10)) >= 0) {
                const line = carry.subarray(0, at);
                carry = carry.subarray(at + 1);
                if (line.length + 1 > 16 * 1024 * 1024 || ++entries > 100000 || !line.length)
                    throw new RecorderError("session-corrupt");
                try {
                    const row = JSON.parse(line.toString("utf8"));
                    if (!row || typeof row !== "object" || Array.isArray(row))
                        throw 0;
                    const record = row;
                    const index = entries - 1;
                    if (index === 0) {
                        if (Object.keys(record).sort().join(",") !== "cwd,id,timestamp,type,version" || record.type !== "session" || record.version !== 3 || record.id !== config.session.id || record.cwd !== config.execution.cwd || typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) || new Date(record.timestamp).toISOString() !== record.timestamp)
                            throw 0;
                    }
                    else {
                        if (record.type === "session" || typeof record.id !== "string" || !record.id || ids.has(record.id) || record.parentId !== previousId)
                            throw 0;
                        ids.add(record.id);
                        previousId = record.id;
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
        const after = fstatSync(fd);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.mode !== before.mode || inode(after) !== inode(before))
            throw new RecorderError("session-modified");
        const verify = () => { const now = modified(() => lstatSync(path)), d = modified(() => lstatSync(owner.path)); if (inode(now) !== inode(before) || now.size !== before.size || now.mtimeMs !== before.mtimeMs || now.ctimeMs !== before.ctimeMs || now.mode !== before.mode || inode(d) !== `${owner.dev}:${owner.ino}` || inventory(owner.path) !== beforeInventory)
            throw new RecorderError("session-modified"); };
        verify();
        return { rowCount: entries, basename: basename(path), sha256: hash.digest("hex"), byteLength: total, verify };
    }
    finally {
        closeSync(fd);
    }
}
