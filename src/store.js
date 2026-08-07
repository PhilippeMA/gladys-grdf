// -----------------------------------------------------------------------------
// Persistence of the synchronization cursor.
//
// GRDF answers with a whole period at once, so without a cursor every poll
// would republish the same days and pile up duplicates in the Gladys history.
// We therefore remember the last gas day published for each PCE.
//
// It lives in `/data`, the only writable location of the sandboxed container
// (see the Dockerfile) — set `GAZPAR_DATA_DIR` to run it elsewhere locally.
// The cursor is a cache, not a source of truth: when the file cannot be read or
// written the integration keeps working in memory and simply re-imports the
// configured history after a restart.
// -----------------------------------------------------------------------------

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'store' });

const DEFAULT_DIRECTORY = process.env.GAZPAR_DATA_DIR ?? '/data';
const FILE_NAME = 'gazpar-state.json';

export class SyncStore {
  /**
   * @param {{ directory?: string }} options
   */
  constructor({ directory = DEFAULT_DIRECTORY } = {}) {
    this.filePath = path.join(directory, FILE_NAME);
    /** @type {Record<string, string>} last published gas day, keyed by PCE */
    this.lastDayByPce = {};
    this.persistent = true;
    this.loaded = false;
  }

  /**
   * Read the cursor file; a missing or broken file simply starts from zero.
   *
   * Only the FIRST call reads: Gladys reconnects call it again, and when the
   * file could never be written the on-disk state is empty — re-reading it
   * would throw away the cursor we hold in memory and re-import the whole
   * history window.
   */
  async load() {
    if (this.loaded) {
      return this;
    }
    this.loaded = true;
    try {
      const content = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed.lastDayByPce === 'object' && parsed.lastDayByPce !== null) {
        this.lastDayByPce = parsed.lastDayByPce;
      }
      logger.debug(`Sync cursor loaded from ${this.filePath}`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn(
          `Could not read ${this.filePath}, starting from an empty cursor: ${err.message}`,
        );
      }
      this.lastDayByPce = {};
    }
    return this;
  }

  /** Last gas day published for a PCE, or undefined when never synchronized. */
  get(pce) {
    return this.lastDayByPce[pce];
  }

  /** Move the cursor forward (never backward: a re-import must not rewind it). */
  set(pce, day) {
    const current = this.lastDayByPce[pce];
    if (!current || day > current) {
      this.lastDayByPce[pce] = day;
      return true;
    }
    return false;
  }

  /** Write the cursor. Failing to persist is a warning, never a crash. */
  async save() {
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(
        this.filePath,
        `${JSON.stringify({ lastDayByPce: this.lastDayByPce }, null, 2)}\n`,
        'utf8',
      );
    } catch (err) {
      if (this.persistent) {
        // Log the disappointment once, then stay quiet: the integration works
        // without the file, it just re-imports history after a restart.
        logger.warn(
          `Could not write ${this.filePath}: the sync cursor stays in memory only (${err.message})`,
        );
        this.persistent = false;
      }
    }
  }
}
