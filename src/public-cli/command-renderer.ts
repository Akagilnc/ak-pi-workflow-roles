/**
 * Public CLI re-export of the shared registry-owned command renderer.
 * Single implementation lives in src/public-command-renderer.ts.
 */
export {
  renderPublicAkRoleCommand,
  type PublicCommandTarget,
} from "../public-command-renderer.ts";
