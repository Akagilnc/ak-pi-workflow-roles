function isNonSuccessHttpStatus(status) {
  return typeof status === "number" && (status < 200 || status >= 300);
}
function hasUpstreamErrorTestimony(input) {
  if (isNonSuccessHttpStatus(input.httpStatus)) return true;
  return Array.isArray(input.diagnostics) && input.diagnostics.length > 0;
}
function projectConfirmedRemotePayload(input) {
  return {
    ...input.body === void 0 ? {} : { body: input.body },
    ...input.code === void 0 ? {} : { code: input.code },
    ...input.errno === void 0 ? {} : { errno: input.errno }
  };
}
export {
  hasUpstreamErrorTestimony,
  isNonSuccessHttpStatus,
  projectConfirmedRemotePayload
};
