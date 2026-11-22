/**
 * Every test gets its own Dialogram data folder, so a ChatRuntime's session
 * store never writes into the user's real one and no test sees another's chats.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach } from 'vitest';

const base = mkdtempSync(path.join(os.tmpdir(), 'dialogram-test-data-'));
let count = 0;

beforeEach(() => {
    process.env.DIALOGRAM_DATA_DIR = path.join(base, String(++count));
});

afterAll(async () => {
    rmSync(base, { recursive: true, force: true });
    // A chat write a test did not wait for may still land and make its folder again.
    await new Promise((resolve) => setTimeout(resolve, 100));
    rmSync(base, { recursive: true, force: true });
});
