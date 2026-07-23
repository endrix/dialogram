// Tests for the run-output overlay workspace-fallback scan (perf round 3).
//
// When the primary per-out-dir scan finds no overlay (e.g. a CLI `--out-dir` run wrote outside the
// resolved run-output dirs, or before the first run), `tryLoadLatestViewerOverlay` falls back to a
// `vscode.workspace.findFiles` scan of the whole workspace. On the synchronous first-load critical
// path that scan must never become an unbounded crawl of an LLVM-scale repo's build/output trees.
// These tests pin three guarantees for the fallback:
//   1. It still resolves the overlay written to an out-of-tree `--out-dir` (behavior preserved).
//   2. The workspace search is exclude-hardened — build/, .git/ and hidden dirs are pruned, not
//      just node_modules — so the crawl is bounded regardless of workspace size.
//   3. It is memoized: repeated opens (the diagram reloads on a polling timer) reuse a single
//      crawl instead of re-scanning the workspace once per open.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkflowSourceModelStorage } from '../src/server/source-model-storage';
import { workspace } from './vscode-mock';

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

function makeStorage(): any {
    const storage = new (WorkflowSourceModelStorage as any)();
    storage.storageOptions = { settingsNamespace: 'wfLang', operationPrefix: 'wfpy' };
    return storage;
}

interface FindFilesCall { include: string; exclude: string; max: number; }

let originalFindFiles: typeof workspace.findFiles;
let findFilesCalls: FindFilesCall[];

/**
 * Seed a workflow whose resolved primary out-dir (`<fileDir>/wf-out`) is absent, plus an
 * out-of-tree run-output dir (as a CLI `--out-dir` run would produce) that only the workspace
 * fallback can discover. Installs a recording `findFiles` that returns the external run-log for the
 * run-log glob (and nothing for the live-overlay glob), so the run-log fallback path is exercised.
 */
async function seedOutOfTreeRun(): Promise<{ workflowFile: string; runId: string }> {
    const root = await mkTempDir('run-out-fallback-');
    const workflowFile = path.join(root, 'proj', 'wf.py');
    await fs.mkdir(path.dirname(workflowFile), { recursive: true });
    await fs.writeFile(workflowFile, '# wf stub\n', 'utf-8');
    const sourcePath = path.resolve(workflowFile);

    const runId = 'ext-run';
    const extRunDir = path.join(root, 'ext-out', runId);
    await writeJson(path.join(extRunDir, 'run.wf-viewer.json'), {
        version: 1,
        runId,
        outDir: extRunDir,
        workflowName: 'wf',
        sourcePath,
        running: false,
        edges: {}
    });
    const extRunLogPath = path.join(root, 'ext-out', 'run-log.jsonl');
    await fs.writeFile(extRunLogPath, JSON.stringify({
        runId,
        workflowName: 'wf',
        sourcePath,
        outDir: extRunDir,
        finishedAt: '2026-07-20T00:00:00Z'
    }) + '\n', 'utf-8');

    workspace.findFiles = (async (include: unknown, exclude: unknown, max: unknown): Promise<Array<{ fsPath: string }>> => {
        findFilesCalls.push({ include: String(include), exclude: String(exclude), max: Number(max) });
        if (String(include).includes('run-log.jsonl')) {
            return [{ fsPath: extRunLogPath }];
        }
        return [];
    }) as unknown as typeof workspace.findFiles;

    return { workflowFile, runId };
}

beforeEach(() => {
    originalFindFiles = workspace.findFiles;
    findFilesCalls = [];
});

afterEach(async () => {
    workspace.findFiles = originalFindFiles;
    for (const dir of tempDirs.splice(0)) {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

describe('run-output overlay workspace fallback', () => {
    it('resolves an out-of-tree --out-dir overlay via the fallback scan', async () => {
        const { workflowFile, runId } = await seedOutOfTreeRun();
        const storage = makeStorage();

        const overlay = await storage.tryLoadLatestViewerOverlay(workflowFile, 'wf', [workflowFile], ['wf']);
        expect(overlay?.runId).toBe(runId);
        // The fallback must have fired (the primary out-dir is absent).
        expect(findFilesCalls.length).toBeGreaterThan(0);
    });

    it('bounds the workspace crawl: excludes build/, .git/ and hidden dirs, not just node_modules', async () => {
        const { workflowFile } = await seedOutOfTreeRun();
        const storage = makeStorage();

        await storage.tryLoadLatestViewerOverlay(workflowFile, 'wf', [workflowFile], ['wf']);

        const runLogCall = findFilesCalls.find(c => c.include.includes('run-log.jsonl'));
        expect(runLogCall).toBeDefined();
        expect(runLogCall!.exclude).toContain('node_modules');
        expect(runLogCall!.exclude).toContain('build');
        expect(runLogCall!.exclude).toContain('.git');
        // Hidden-dir prune (e.g. `**/.*/**`).
        expect(runLogCall!.exclude).toMatch(/\.\*/);
        // Result cap stays in place.
        expect(runLogCall!.max).toBeGreaterThan(0);
        expect(runLogCall!.max).toBeLessThanOrEqual(200);
    });

    it('memoizes the fallback crawl: repeated opens reuse one workspace scan', async () => {
        const { workflowFile, runId } = await seedOutOfTreeRun();
        const storage = makeStorage();

        const first = await storage.tryLoadLatestViewerOverlay(workflowFile, 'wf', [workflowFile], ['wf']);
        const second = await storage.tryLoadLatestViewerOverlay(workflowFile, 'wf', [workflowFile], ['wf']);
        expect(first?.runId).toBe(runId);
        expect(second?.runId).toBe(runId);

        const runLogCalls = findFilesCalls.filter(c => c.include.includes('run-log.jsonl'));
        // The workspace crawl runs at most once across both opens.
        expect(runLogCalls.length).toBe(1);
    });
});
