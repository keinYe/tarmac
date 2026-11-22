import { appendFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 1024 * 1024;

// The daemon runs detached with stdio ignored, so reasons for closing a connection go to
// <dataDir>/daemon.log. It never holds terminal output, hook payloads or input text; one older
// generation is kept at daemon.log.1.
export function daemonLog(dataDir: string): (message: string) => void {
  const file = path.join(dataDir, 'daemon.log');
  return message => {
    try {
      try { if (statSync(file).size >= MAX_BYTES) renameSync(file, `${file}.1`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      appendFileSync(file, `${new Date().toISOString()} ${message.replace(/[\r\n]+/g, ' ')}\n`, { mode: 0o600 });
    } catch { /* Logging must never take down the daemon or its connections. */ }
  };
}
