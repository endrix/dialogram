/**
 * The run overlay holds steady while a run is on, and at its end.
 *
 * The runtime writes `run.wf-viewer.live.json` at every firing and the diagram
 * re-reads it every 400ms, so now and then it reads the file halfway written.
 * That used to count as no file: the loader fell through to the previous run,
 * the ring went off and the previous run's queue sizes came on, and the next
 * read put things back -- the ring and the sizes blinked all through a run.
 * At the end of a run the live file went before the run was in the log, and
 * for a moment the previous run showed again.
 *
 * And the eye on the palette, off, took only the step counter away: the tokens
 * and queue sizes stayed on the edges, so it looked as if it did nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GEdge, GModelRoot } from '@eclipse-glsp/server';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { WorkflowSourceModelStorage } from '../src/server/source-model-storage';

const tempDirs: string[] = [];
afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function makeStorage(): any {
    const storage = new (WorkflowSourceModelStorage as any)();
    storage.storageOptions = { settingsNamespace: 'wfLang', operationPrefix: 'wfpy' };
    return storage;
}

/** `<root>/wf.py` with `wf-out/`: a finished run `old` in the log, and the files `run` wrote. */
async function seed(): Promise<{ workflowFile: string; outDir: string; livePath: string; logPath: string; sourcePath: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'overlay-steady-'));
    tempDirs.push(root);
    const workflowFile = path.join(root, 'wf.py');
    await fs.writeFile(workflowFile, '# wf stub\n', 'utf-8');
    const sourcePath = path.resolve(workflowFile);
    const outDir = path.join(root, 'wf-out');
    const oldDir = path.join(outDir, 'old');
    await fs.mkdir(oldDir, { recursive: true });
    await fs.writeFile(path.join(oldDir, 'run.wf-viewer.json'), JSON.stringify({
        version: 1, runId: 'old', outDir: oldDir, workflowName: 'wf', sourcePath, running: false, edges: { ab: { lastToken: 'old-token' } }
    }));
    const logPath = path.join(outDir, 'run-log.jsonl');
    await fs.writeFile(logPath, JSON.stringify({ runId: 'old', workflowName: 'wf', sourcePath, outDir: oldDir, finishedAt: '2026-07-20T00:00:00Z' }) + '\n');
    return { workflowFile, outDir, livePath: path.join(outDir, 'run.wf-viewer.live.json'), logPath, sourcePath };
}

const liveOverlay = (sourcePath: string, outDir: string, running: boolean, active?: string) => ({
    version: 1, runId: 'run', outDir: path.join(outDir, 'run'), workflowName: 'wf', sourcePath, running,
    edges: { ab: { lastToken: 'run-token' } },
    ...(active ? { active: [{ entityInstanceName: active, fireCount: 3 }] } : {})
});

describe('the live overlay while a run is on', () => {
    it('is read as it last parsed when the file is halfway written', async () => {
        const { workflowFile, outDir, livePath, sourcePath } = await seed();
        const storage = makeStorage();
        await fs.writeFile(livePath, JSON.stringify(liveOverlay(sourcePath, outDir, true, 'b')));
        const first = await storage.tryLoadLatestViewerOverlay(workflowFile, 'wf', [workflowFile], ['wf']);
        expect(first?.runId).toBe('run');
        expect(first?.running).toBe(true);

        // The runtime is rewriting the file: a read sees the first half of it.
        await fs.writeFile(livePath, JSON.stringify(liveOverlay(sourcePath, outDir, true, 'c')).slice(0, 40));
        const during = await storage.tryLoadLatestViewerOverlay(workflowFile, 'wf', [workflowFile], ['wf']);
        expect(during?.runId).toBe('run');
        expect(during?.running).toBe(true);
        expect(during?.active?.[0]?.entityInstanceName).toBe('b');

        // Written in full: the new state.
        await fs.writeFile(livePath, JSON.stringify(liveOverlay(sourcePath, outDir, true, 'c')));
        const after = await storage.tryLoadLatestViewerOverlay(workflowFile, 'wf', [workflowFile], ['wf']);
        expect(after?.active?.[0]?.entityInstanceName).toBe('c');
    });

    it('stands, finished, from the end of the run until the log records it', async () => {
        const { workflowFile, outDir, livePath, logPath, sourcePath } = await seed();
        const storage = makeStorage();
        await fs.writeFile(livePath, JSON.stringify(liveOverlay(sourcePath, outDir, true, 'b')));
        expect((await storage.tryLoadLatestViewerOverlay(workflowFile, 'wf', [workflowFile], ['wf']))?.runId).toBe('run');

        // The run stops: the live file says so first ...
        await fs.writeFile(livePath, JSON.stringify(liveOverlay(sourcePath, outDir, false)));
        const stopped = await storage.tryLoadLatestViewerOverlay(workflowFile, 'wf', [workflowFile], ['wf']);
        expect(stopped?.runId).toBe('run');
        expect(stopped?.running).toBe(false);
        expect(stopped?.active).toBeUndefined();
        expect(stopped?.edges.ab.lastToken).toBe('run-token');

        // ... then goes, before the run is in the log.
        await fs.rm(livePath);
        const gone = await storage.tryLoadLatestViewerOverlay(workflowFile, 'wf', [workflowFile], ['wf']);
        expect(gone?.runId).toBe('run');
        expect(gone?.running).toBe(false);

        // The log records the run: its final overlay is what shows from now on.
        const runDir = path.join(outDir, 'run');
        await fs.mkdir(runDir, { recursive: true });
        await fs.writeFile(path.join(runDir, 'run.wf-viewer.json'), JSON.stringify({
            version: 1, runId: 'run', outDir: runDir, workflowName: 'wf', sourcePath, running: false, edges: { ab: { lastToken: 'final-token' } }
        }));
        await fs.appendFile(logPath, JSON.stringify({ runId: 'run', workflowName: 'wf', sourcePath, outDir: runDir, finishedAt: '2026-07-21T00:00:00Z' }) + '\n');
        const recorded = await storage.tryLoadLatestViewerOverlay(workflowFile, 'wf', [workflowFile], ['wf']);
        expect(recorded?.runId).toBe('run');
        expect(recorded?.edges.ab.lastToken).toBe('final-token');
    });

    it('a queue trace halfway written is read as it last parsed', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'overlay-steady-trace-'));
        tempDirs.push(dir);
        const storage = makeStorage();
        const tracePath = path.join(dir, 'run.wf-queues.json');
        const trace = (steps: number) => ({ version: 1, steps: Array.from({ length: steps }, (_, i) => ({ step: i + 1, queueSizes: [{ overlayAstPath: 'ab', size: i }] })) });
        await fs.writeFile(tracePath, JSON.stringify(trace(2)));
        expect((await storage.tryLoadQueueTraceAtStep(dir))?.stepCount).toBe(2);
        await fs.writeFile(tracePath, JSON.stringify(trace(3)).slice(0, 30));
        expect((await storage.tryLoadQueueTraceAtStep(dir))?.stepCount).toBe(2);
        await fs.writeFile(tracePath, JSON.stringify(trace(3)));
        expect((await storage.tryLoadQueueTraceAtStep(dir))?.stepCount).toBe(3);
    });
});

describe('the eye on the palette, off', () => {
    function model(): { root: GModelRoot; ab: GEdge } {
        const root = new GModelRoot();
        root.id = 'root';
        const ab = new GEdge();
        ab.id = 'ab';
        // Stale from the last model: a size the trace no longer has.
        ab.args = { astPath: 'ab', [WorkflowDiagramMetadata.QUEUE_SIZE]: 7 };
        root.children = [ab];
        return { root, ab };
    }

    async function apply(visible: boolean): Promise<GEdge> {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'overlay-eye-'));
        tempDirs.push(dir);
        await fs.writeFile(path.join(dir, 'run.wf-queues.json'), JSON.stringify({
            version: 1, steps: [{ step: 1, actorInstanceName: 'a', queueSizes: [{ overlayAstPath: 'ab', size: 2, lastToken: 'tok' }] }]
        }));
        const storage = makeStorage();
        storage.isLiveExecutionGlowEnabled = async () => true;
        storage.tryLoadLatestViewerOverlay = async () => ({ runId: 'r', outDir: dir, running: false, active: [], edges: { ab: { lastToken: 'tok' } } });
        storage.ensureModelSource = () => ({
            analysis: {
                buildOverlayAstPathCandidates: (args: any) => (args?.astPath ? [args.astPath] : []),
                buildOverlaySignatureCandidates: () => [],
                buildOverlayNodeIdentityCandidates: () => [],
                resolveOverlayActiveEntityName: () => undefined
            }
        });
        const m = model();
        await storage.applyViewerOverlayToEdges(m.root, '/w/flow.py', 'flow', [], ['flow'], undefined, visible, ['/w/flow.py']);
        return m.ab;
    }

    it('takes the token and the queue size off the edges', async () => {
        const ab = await apply(false);
        expect((ab.args as any)[WorkflowDiagramMetadata.VIEWER_LAST_TOKEN]).toBeUndefined();
        expect((ab.args as any)[WorkflowDiagramMetadata.QUEUE_SIZE]).toBeUndefined();
    });

    it('on, draws them, the size the trace has and not a stale one', async () => {
        const ab = await apply(true);
        expect((ab.args as any)[WorkflowDiagramMetadata.VIEWER_LAST_TOKEN]).toBe('tok');
        expect((ab.args as any)[WorkflowDiagramMetadata.QUEUE_SIZE]).toBe(2);
    });
});
