import { issuePiDurablePrincipalCoordinates } from "./pi/durable-principal.js";
function roleRunSessionCoordinates(options) {
  return issuePiDurablePrincipalCoordinates(options);
}
export {
  roleRunSessionCoordinates
};
