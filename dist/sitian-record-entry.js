/**
 * 司天台唯一 Pi session 记录落盘入口（ADR 0065）。
 * 调用方只声明自己是谁的什么；落点由候簿拓扑算出，签名不含任何落点/路径参数。
 * 「谁调了谁」复用 Pi parentSession + ADR 0047 correlation，不新增 caller 字段。
 */
import { dirname, resolve, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveBookKeyFromGit } from "./activation-ledger-git.js";
import { activationBookDirectory, ensureRealDirectoryTree, physicallyContainedIn, resolveActivationLedgerHome, } from "./activation-ledger-topology.js";
/**
 * Sole package entry that constructs a durable Pi session record (ADR 0065).
 * No destination/path parameters — location is computed from ledger topology only.
 */
export function createRecordSession(options) {
    const cwd = options.cwd;
    const parentFile = options.parent?.getSessionFile();
    if (parentFile === undefined || parentFile.length === 0) {
        // No durable parent principal — preserve prior in-memory child behavior.
        return SessionManager.inMemory(cwd);
    }
    const ledgerHome = resolveActivationLedgerHome();
    const parentResolved = resolve(parentFile);
    // Nest under parent only when the parent record already lives under the package home.
    // Nest base is dirname(parent file) — the durable principal's directory — never a
    // separate getSessionDir() that can diverge (empty in-memory dir + durable file).
    // Otherwise the book is resolved from cwd (ADR 0048) and the kind sits under that book —
    // workspace / foreign parents cannot drag records out of home.
    const sessionDir = physicallyContainedIn(ledgerHome, parentResolved)
        ? join(dirname(parentResolved), options.kind)
        : join(activationBookDirectory(ledgerHome, resolveBookKeyFromGit(cwd)), options.kind);
    ensureRealDirectoryTree(ledgerHome, sessionDir);
    return SessionManager.create(cwd, sessionDir, { parentSession: parentFile });
}
