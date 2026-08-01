import { randomBytes } from "node:crypto";
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function isUuidV7(value) {
  return typeof value === "string" && UUIDV7.test(value);
}
function uuidv7(now = Date.now()) {
  const b = randomBytes(16);
  let n = BigInt(now);
  for (let i = 5; i >= 0; i--) {
    b[i] = Number(n & 255n);
    n >>= 8n;
  }
  b[6] = b[6] & 15 | 112;
  b[8] = b[8] & 63 | 128;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export {
  isUuidV7,
  uuidv7
};
