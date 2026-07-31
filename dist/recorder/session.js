import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { RecorderError } from "./errors.js";
const inode = (s) => `${s.dev}:${s.ino}`;
function inventory(dir) { return readdirSync(dir).sort().map(n => { const s = lstatSync(join(dir, n)); return `${n}:${s.mode}:${s.dev}:${s.ino}:${s.size}`; }).join("\n"); }
export function createSessionLeaf(config) {
    const path = join(config.archive.repositoryRoot, config.session.directory);
    try {
        mkdirSync(path, { mode: 0o700 });
    }
    catch (e) {
        throw new RecorderError("session-collision", undefined, { cause: e });
    }
    const s = lstatSync(path);
    if (!s.isDirectory() || s.isSymbolicLink() || readdirSync(path).length)
        throw new RecorderError("session-collision");
    return { path, dev: s.dev, ino: s.ino };
}
export function readSession(config, owner) {
    const ds = lstatSync(owner.path);
    if (inode(ds) !== `${owner.dev}:${owner.ino}`)
        throw new RecorderError("session-modified");
    const names = readdirSync(owner.path);
    const mains = [];
    for (const n of names) {
        const p = join(owner.path, n), s = lstatSync(p);
        if (n === "reviewer-legs") {
            if (!s.isDirectory() || s.isSymbolicLink())
                throw new RecorderError("session-ambiguous");
            for (const leg of readdirSync(p)) {
                const ls = lstatSync(join(p, leg));
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
    const path = join(owner.path, mains[0]);
    const beforeInventory = inventory(owner.path);
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const before = fstatSync(fd);
        if (!before.isFile())
            throw new RecorderError("session-ambiguous");
        const ps = lstatSync(path);
        if (inode(ps) !== inode(before))
            throw new RecorderError("session-modified");
        const hash = createHash("sha256");
        let total = 0, carry = Buffer.alloc(0), entries = 0;
        const rows = [];
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
                    const r = JSON.parse(line.toString("utf8"));
                    if (!r || typeof r !== "object" || Array.isArray(r))
                        throw 0;
                    rows.push(r);
                }
                catch {
                    throw new RecorderError("session-corrupt");
                }
            }
        }
        if (total !== before.size || carry.length)
            throw new RecorderError("session-corrupt");
        const after = fstatSync(fd);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || inode(after) !== inode(before))
            throw new RecorderError("session-modified");
        let prev = null;
        const ids = new Set();
        rows.forEach((r, i) => { const x = r; if (i === 0) {
            if (x.type !== "session" || x.version !== 3 || x.id !== config.session.id || x.cwd !== config.execution.cwd || Object.hasOwn(x, "parentSession") || typeof x.timestamp !== "string" || Number.isNaN(Date.parse(x.timestamp)))
                throw new RecorderError("session-corrupt");
            return;
        } if (typeof x.id !== "string" || !x.id || ids.has(x.id) || x.parentId !== prev)
            throw new RecorderError("session-corrupt"); ids.add(x.id); prev = x.id; });
        const verify = () => { const now = lstatSync(path), d = lstatSync(owner.path); if (inode(now) !== inode(before) || now.size !== before.size || now.mtimeMs !== before.mtimeMs || now.ctimeMs !== before.ctimeMs || inode(d) !== `${owner.dev}:${owner.ino}` || inventory(owner.path) !== beforeInventory)
            throw new RecorderError("session-modified"); };
        verify();
        return { rows, basename: basename(path), sha256: hash.digest("hex"), byteLength: total, verify };
    }
    finally {
        closeSync(fd);
    }
}
