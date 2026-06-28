// Maintenance progress channel. The harvest/onboard/refresh/prune steps write their live progress to
// data/.maintain-status.json (atomic), and the API surfaces it on /health so the web UI can show
// "refreshing 316 / 1604" without the steps and the server sharing memory. Best-effort: any write error
// is swallowed — progress reporting must NEVER break a harvest. The API gates on `updatedAt` freshness,
// so when a run ends the indicator disappears on its own (no explicit clear needed).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STATUS_FILE = process.env.MAINTAIN_STATUS || path.resolve(HERE, "../data/.maintain-status.json");

let state = {};
// Merge `patch` into the running state, stamp updatedAt, write atomically. Returns the new state.
export function setStatus(patch) {
  state = { ...state, ...patch, updatedAt: Date.now() };
  try {
    fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
    const tmp = STATUS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATUS_FILE); // atomic
  } catch { /* never let status I/O break a harvest */ }
  return state;
}
export function clearStatus() { try { fs.unlinkSync(STATUS_FILE); } catch { /* fine */ } }
