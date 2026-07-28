import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import type { SessionData } from '../../core/shared/types';

const SESSION_FILE = path.join(app.getPath('userData'), 'session.json');

function canReadSource(filePath: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close failures for session validation
      }
    }
  }
}

/**
 * Serialises writes so overlapping autosaves cannot interleave, and keeps the
 * work off the synchronous path — this runs on the main process, where a
 * blocking write of a large session stalls every pending IPC reply.
 */
let sessionWriteChain: Promise<void> = Promise.resolve();

export function saveSession(data: SessionData): Promise<void> {
  const payload = JSON.stringify({ ...data, savedAt: new Date().toISOString() });
  const tempFile = `${SESSION_FILE}.tmp`;

  const previous: Promise<void> = sessionWriteChain;
  const next: Promise<void> = (async (): Promise<void> => {
    try {
      await previous;
    } catch {
      // A failed earlier write must not block this one.
    }
    await fsp.mkdir(path.dirname(SESSION_FILE), { recursive: true });
    // Write-then-rename so a crash mid-write cannot leave a truncated session.
    await fsp.writeFile(tempFile, payload, 'utf-8');
    await fsp.rename(tempFile, SESSION_FILE);
  })();

  sessionWriteChain = next;
  return next;
}

export function loadSession(): SessionData | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const raw = fs.readFileSync(SESSION_FILE, 'utf-8');
    const data: SessionData = JSON.parse(raw);
    const originalFiles = Array.isArray(data.files) ? data.files : [];
    let unavailableSourceCount = 0;

    // Validate that files can still be opened by this app process.
    if (originalFiles.length > 0) {
      data.files = originalFiles.filter((f) => {
        const canRead = canReadSource(f.sourcePath);
        if (!canRead) unavailableSourceCount++;
        return canRead;
      });

    } else {
      data.files = [];
    }

    data.unavailableSourceCount = unavailableSourceCount;
    if (!data.files || (data.files.length === 0 && unavailableSourceCount === 0 && !data.batchResult)) return null;
    return data;
  } catch {
    return null;
  }
}
