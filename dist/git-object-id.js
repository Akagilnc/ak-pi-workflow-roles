export const FULL_GIT_OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export function isFullGitObjectId(value) {
    return typeof value === "string" && FULL_GIT_OBJECT_ID_RE.test(value);
}
export function gitObjectIdWidth(format) {
    return format === "sha1" ? 40 : 64;
}
