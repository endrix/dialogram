// Tests for the run-output overlay-scan performance work (perf round 2, P2).
//
// A single diagram open reads each run-output `run-log.jsonl` three times — the viewer overlay, the
// agent-context, and the run-history scans each opened it independently — and in a real workspace
// with months of runs that append-only log grows to many MB, so re-reading and re-parsing it
// dominated the cold-open `overlays` phase (~700ms). The fix funnels all three readers through a
// per-path cache invalidated on the log's size/mtime. These tests pin the two guarantees:
//   1. Behavior is unchanged — the SAME (newest matching) overlay is chosen, cold and warm.
//   2. The parse is memoized per (path, size/mtime): an unchanged log is not re-parsed, and any
//      change to the file invalidates the entry so a freshly appended run is observed.
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkflowSourceModelStorage } from '../src/server/source-model-storage';

const tempDirs: string[] = [];

async function mkTempDir(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(value), 'utf-8');
}

afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

/**
 * Lay down a `wf-out` run-output dir next to `<root>/wf.py` with one `run-log.jsonl` (entries in the
 * given order, oldest → newest) and a matching `run.wf-viewer.json` per run. Returns the workflow
 * file path and the run-log path.
 */
async function seedRunOutput(
    root: string,
    runIds: string[]
): Promise<{ workflowFile: string; runLogPath: string; outDir: string }> {
    const workflowFile = path.join(root, 'wf.py');
    await fs.writeFile(workflowFile, '# wf stub\n', 'utf-8');
    const sourcePath = path.resolve(workflowFile);
    const outDir = path.join(root, 'wf-out');

    const logLines: string[] = [];
    for (const runId of runIds) {
        const runDir = path.join(outDir, runId);
        await writeJson(path.join(runDir, 'run.wf-viewer.json'), {
            version: 1,
            runId,
            outDir: runDir,
            workflowName: 'wf',
            sourcePath,
            running: false,
            edges: {}
        });
        logLines.push(JSON.stringify({
            runId,
            workflowName: 'wf',
            sourcePath,
            outDir: runDir,
            finishedAt: `2026-07-20T00:00:0${logLines.length}Z`
        }));
    }
    const runLogPath = path.join(outDir, 'run-log.jsonl');
    await fs.writeFile(runLogPath, logLines.join('\n') + '\n', 'utf-8');
    return { workflowFile, runLogPath, outDir };
}

function makeStorage(): any {
    const storage = new (WorkflowSourceModelStorage as any)();
    storage.storageOptions = { settingsNamespace: 'wfLang', operationPrefix: 'wfpy' };
    return storage;
}

describe('run-output overlay scan — selection parity', () => {
    it('selects the newest matching run overlay, identically on the cold and warm (cached) scan', async () => {
        const root = await mkTempDir('run-out-overlay-parity-');
        const { workflowFile } = await seedRunOutput(root, ['run-old', 'run-new']);
        const storage = makeStorage();

        const cold = await storage.tryLoadLatestViewerOverlay(workflowFile, 'wf', [workflowFile], ['wf']);
        expect(cold?.runId).toBe('run-new');

        // Second scan is served from the memoized run-log entries (nothing changed on disk).
        const warm = await storage.tryLoadLatestViewerOverlay(workflowFile, 'wf', [workflowFile], ['wf']);
        expect(warm?.runId).toBe('run-new');
        expect(warm?.runId).toBe(cold?.runId);
    });
});

describe('run-output run-log memoization', () => {
    it('parses valid object entries in file order and drops blank/invalid lines', async () => {
        const root = await mkTempDir('run-out-parse-');
        const { runLogPath, outDir } = await seedRunOutput(root, ['run-a', 'run-b']);
        // Append a blank line and a non-JSON line: both must be dropped, matching the old inline scan.
        await fs.appendFile(runLogPath, '\nnot-json\n', 'utf-8');
        const storage = makeStorage();

        const entries = await storage.readRunLogEntries(path.join(outDir, 'run-log.jsonl'));
        expect(entries.map((e: any) => e.runId)).toEqual(['run-a', 'run-b']);
    });

    it('memoizes an unchanged log (same array reference) and invalidates on any change', async () => {
        const root = await mkTempDir('run-out-memo-');
        const { runLogPath } = await seedRunOutput(root, ['run-1']);
        const storage = makeStorage();

        const first = await storage.readRunLogEntries(runLogPath);
        const second = await storage.readRunLogEntries(runLogPath);
        // Unchanged file → same cached array instance, i.e. no re-read/re-parse.
        expect(second).toBe(first);
        expect(first.map((e: any) => e.runId)).toEqual(['run-1']);

        // Appending a run changes the file's size (and mtime) → cache invalidates, new run observed.
        await fs.appendFile(
            runLogPath,
            JSON.stringify({ runId: 'run-2', workflowName: 'wf' }) + '\n',
            'utf-8'
        );
        const third = await storage.readRunLogEntries(runLogPath);
        expect(third).not.toBe(first);
        expect(third.map((e: any) => e.runId)).toEqual(['run-1', 'run-2']);
    });

    it('returns an empty list for a missing log and does not cache it', async () => {
        const root = await mkTempDir('run-out-missing-');
        const storage = makeStorage();
        const missing = path.join(root, 'wf-out', 'run-log.jsonl');

        const entries = await storage.readRunLogEntries(missing);
        expect(entries).toEqual([]);
        expect(storage.runLogEntryCache.has(missing)).toBe(false);
    });
});
