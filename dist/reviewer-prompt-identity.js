import { sha256Hex } from "./sha256.js";
export function reviewerPromptIdentity(text) {
    return Object.freeze({
        text,
        utf8Length: Buffer.byteLength(text, "utf8"),
        sha256: sha256Hex(text),
    });
}
export function isReviewerPromptIdentity(value) {
    const actual = reviewerPromptIdentity(value.text);
    return value.utf8Length === actual.utf8Length && value.sha256 === actual.sha256;
}
export function sameReviewerPromptIdentity(first, second) {
    return first.text === second.text &&
        first.utf8Length === second.utf8Length &&
        first.sha256 === second.sha256;
}
