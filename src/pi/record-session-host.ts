import { existsSync } from "node:fs";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { RecordSessionHost } from "../host-contracts.ts";

/** Pi-native implementation of the shared record-session lifecycle seam. */
export const piRecordSessionHost: RecordSessionHost = {
  openRecordSession({ sessionFile, sessionDir, cwd }) {
    return SessionManager.open(sessionFile, sessionDir, cwd);
  },
  createRecordSession({ cwd, sessionDir, parentSession }) {
    return SessionManager.create(
      cwd,
      sessionDir,
      parentSession === undefined ? undefined : { parentSession },
    );
  },
  continueRecentRecordSession({ cwd, sessionDir }) {
    const session = SessionManager.continueRecent(cwd, sessionDir);
    const sessionFile = session.getSessionFile();
    return {
      session,
      resumed: sessionFile !== undefined && existsSync(sessionFile),
    };
  },
  inMemoryRecordSession(cwd) {
    return SessionManager.inMemory(cwd);
  },
};
