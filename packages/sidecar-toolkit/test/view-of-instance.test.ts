/**
 * A view of the instance it was reached through (`meta.views` entry with
 * `of: 'instance'`, carried on the trail's last crumb as `viewOf`).
 *
 * By name, a file answers for the definition it holds under that name. For a
 * unit made per instance (by a factory, with the instance's parameters) that
 * is another one. So such a view is asked of the root first, by the path of
 * instances the trail records, exactly as a drill-down into a nested unit
 * falls back to; the file is asked by name only when the root has no answer,
 * and the same question is never asked twice. When the file answers in the
 * root's place the reader is told so, since what is shown is the
 * definition's. A view without the mark is asked as before.
 *
 * The host's refresh (a keystroke, a save) repeats the trail and names no
 * view: the storage takes the view from the trail's last crumb, so the view
 * stays, and stays the instance's.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Module } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscodeMock from './vscode-mock';
import { WorkflowSourceModelStorage } from '@dialogram/diagram-server/server/diagram-glsp-module';
import { SidecarModelSource } from '../src/server/sidecar-model-source';
import { type SidecarRuntimeConfig } from '../src/server/sidecar-runtime-config';
import { NEUTRAL_CREATE_NODE_CONFIG } from './fixtures/create-node-config';

const CFG: SidecarRuntimeConfig = {
    settingsNamespace: 'calLang',
    sidecarOperationPrefix: 'calpy',
    sidecarCommandSettingKey: 'calpySidecarCommand',
    sidecarCommandDefault: 'calpy-sidecar',
    cliCommandSettingKey: 'calpyCommand',
    cliCommandDefault: 'calpy',
    cliPythonModule: undefined,
    operationKinds: { createEntityPort: 'op.createEntityPort', deleteEntityPort: 'op.deleteEntityPort' },
    ...NEUTRAL_CREATE_NODE_CONFIG,
    acceptedOperationPrefixes: ['calpy'],
    graphAcquisition: 'sidecar-export'
};

const ROOT = 'file:///tmp/decoder.py';
const NESTED = 'file:///tmp/motion.py';
const UNIT = 'file:///tmp/interpolation.py';

/** Root, a nested unit reached through `motion_Y`, then the view of the unit reached through `interpolation`. */
function request(last: Record<string, unknown> = {}, view = 'actor'): Record<string, unknown> {
    return {
        networkName: 'Interpolation',
        'wf:view': view,
        'wf:navTrail': JSON.stringify([
            { sourceUri: ROOT, workflowName: 'decoder' },
            { sourceUri: NESTED, workflowName: 'motion', workflowInstanceName: 'motion_Y' },
            { sourceUri: UNIT, workflowName: 'Interpolation', workflowInstanceName: 'interpolation', view: 'actor', viewLabel: 'Actor', ...last }
        ])
    };
}

const GRAPH = { network: 'Interpolation', nodes: [], edges: [], scopes: [] };

/** A model source whose sidecar answers by `answer(call number)`, and what it was asked. */
function source(answer: (call: number) => { graph?: Record<string, unknown>; error?: string }) {
    const asked: Array<{ file: string; root?: unknown; path?: unknown; graphSource?: unknown; network?: unknown; view?: unknown }> = [];
    const modelSource = new SidecarModelSource(CFG) as any;
    modelSource.tryLoadGraphFromSidecar = async (file: string, opts: Record<string, unknown>) => {
        asked.push({
            file, root: opts['cal:rootWorkflow'], path: opts['cal:instancePath'], graphSource: opts['cal:graphSourceUri'],
            network: opts.networkName, view: opts['wf:view']
        });
        return answer(asked.length);
    };
    return { modelSource: modelSource as SidecarModelSource, asked };
}

// What `tryLoadGraphFromSidecar` is handed. `network` is the request's own
// name still: with a root and a path, the sidecar is not sent it (see "on the wire").
const BY_INSTANCE = { file: '/tmp/decoder.py', root: 'decoder', path: ['motion_Y', 'interpolation'], graphSource: ROOT, network: 'Interpolation', view: 'actor' };
const BY_NAME = { file: '/tmp/interpolation.py', root: undefined, path: undefined, graphSource: undefined, network: 'Interpolation', view: 'actor' };

describe('a view of the instance it was reached through', () => {
    it('is asked of the root, by the path of instances, and that answer is the one shown', async () => {
        const { modelSource, asked } = source(() => ({ graph: GRAPH }));
        const result: any = await modelSource.getGraph(UNIT, { requestOptions: request({ viewOf: 'instance' }) });

        expect(asked).toEqual([BY_INSTANCE]);
        expect(result.graph.id).toBeDefined();
        // What it was resolved with goes on with the document: its layout is the instance's.
        expect(result.resolvedOptions).toMatchObject({
            'cal:graphSourceUri': ROOT, 'cal:rootWorkflow': 'decoder', 'cal:instancePath': ['motion_Y', 'interpolation'], 'wf:view': 'actor'
        });
    });

    it('is asked of its file by name when the root has no answer, and the root is not asked again', async () => {
        const { modelSource, asked } = source(call => (call === 1 ? { error: 'the root could not be elaborated' } : { graph: GRAPH }));
        const result: any = await modelSource.getGraph(UNIT, { requestOptions: request({ viewOf: 'instance' }) });

        expect(asked).toEqual([BY_INSTANCE, BY_NAME]);
        expect(result.graph.id).toBeDefined();
        expect(result.resolvedOptions['cal:rootWorkflow']).toBeUndefined();
    });

    it('asks no third time when neither has an answer, and says what each said', async () => {
        const { modelSource, asked } = source(call => ({ error: call === 1 ? 'instance path not found' : 'no definition under that name' }));
        (modelSource as any).showGraphExportError = async () => undefined;
        const result: any = await modelSource.getGraph(UNIT, { requestOptions: request({ viewOf: 'instance' }) });

        expect(asked).toEqual([BY_INSTANCE, BY_NAME]);
        const messages = (result.diagnostics as Array<{ message: string }>).map(d => d.message).join(' | ');
        expect(messages).toContain('no definition under that name');
        expect(messages).toContain('asked of the instance first: instance path not found');
    });

    it('says so when its file answers in the root’s place: what is shown is the definition’s', async () => {
        const { modelSource } = source(call => (call === 1 ? { error: 'the root could not be elaborated' } : { graph: GRAPH }));
        const result: any = await modelSource.getGraph(UNIT, { requestOptions: request({ viewOf: 'instance' }) });

        expect(result.diagnostics).toEqual([expect.objectContaining({
            severity: 'warning',
            code: 'view_of_definition',
            uri: '/tmp/interpolation.py',
            message: 'This is the view of the definition in /tmp/interpolation.py, not of the instance motion_Y / interpolation: '
                + 'the root could not be elaborated'
        })]);
        // And nothing of the kind when the root answered.
        const answered: any = await source(() => ({ graph: GRAPH })).modelSource.getGraph(UNIT, { requestOptions: request({ viewOf: 'instance' }) });
        expect(answered.diagnostics).toEqual([]);
    });

    it('is asked of the root for an actor of the root itself: a trail of two', async () => {
        const { modelSource, asked } = source(() => ({ graph: GRAPH }));
        await modelSource.getGraph(UNIT, {
            requestOptions: {
                networkName: 'Interpolation',
                'wf:view': 'actor',
                'wf:navTrail': JSON.stringify([
                    { sourceUri: ROOT, workflowName: 'decoder' },
                    { sourceUri: UNIT, workflowName: 'Interpolation', workflowInstanceName: 'merger', view: 'actor', viewOf: 'instance' }
                ])
            }
        });

        expect(asked).toEqual([{ ...BY_INSTANCE, path: ['merger'] }]);
    });

    it('is asked by name when the trail has a step with no instance: the path would lead elsewhere', async () => {
        const { modelSource, asked } = source(() => ({ graph: GRAPH }));
        await modelSource.getGraph(UNIT, {
            requestOptions: {
                networkName: 'Interpolation',
                'wf:view': 'actor',
                'wf:navTrail': JSON.stringify([
                    { sourceUri: ROOT, workflowName: 'decoder' },
                    // Shown by name, not reached through an instance.
                    { sourceUri: NESTED, workflowName: 'motion' },
                    { sourceUri: UNIT, workflowName: 'Interpolation', workflowInstanceName: 'interpolation', view: 'actor', viewOf: 'instance' }
                ])
            }
        });

        expect(asked).toEqual([BY_NAME]);
    });
});

describe('the view after a refresh by the host', () => {
    /** The storage with the model source behind it, its drawing stubbed out: what is asked is what is checked. */
    function storageOver(modelSource: SidecarModelSource) {
        const storage = new WorkflowSourceModelStorage() as any;
        storage.injectedModelSource = modelSource;
        storage.storageOptions = { settingsNamespace: 'calLang', operationPrefix: 'calpy' };
        let finished: Record<string, unknown> | undefined;
        storage.finishLoadFromDoc = async (_doc: unknown, _sourceUri: string, _file: string, opts: Record<string, unknown>) => {
            finished = opts;
        };
        storage.getWorkflowRelationshipInfo = async () => ({ workflowNames: [] });
        return { storage, finishedWith: () => finished };
    }

    it('is still the view, and still the instance’s: the trail’s last crumb says both', async () => {
        const { modelSource, asked } = source(() => ({ graph: GRAPH }));
        const { storage, finishedWith } = storageOver(modelSource);
        // As the host refreshes: the file, the name, the trail, and no view.
        const { 'wf:view': _view, ...refresh } = request({ viewOf: 'instance' });
        await storage.loadSourceModelDocument({ options: { ...refresh, sourceUri: UNIT, forceReloadFromDisk: true } }, UNIT);

        expect(asked).toEqual([BY_INSTANCE]);
        expect(finishedWith()).toMatchObject({ 'wf:view': 'actor', 'cal:rootWorkflow': 'decoder', 'cal:instancePath': ['motion_Y', 'interpolation'] });
    });

    it('is the structure when the trail ends at no view, or at the view of another unit', async () => {
        const plain = source(() => ({ graph: GRAPH }));
        const { 'wf:view': _view, ...noView } = request({ view: '' });
        await storageOver(plain.modelSource).storage.loadSourceModelDocument({ options: { ...noView, sourceUri: UNIT } }, UNIT);
        expect(plain.asked.map(call => call.view)).toEqual([undefined]);

        // The request is for another name than the crumb's: the crumb does not speak for it.
        const other = source(() => ({ graph: GRAPH }));
        const { 'wf:view': _v, ...refresh } = request({ viewOf: 'instance' });
        await storageOver(other.modelSource).storage.loadSourceModelDocument(
            { options: { ...refresh, sourceUri: UNIT, networkName: 'Another' } }, UNIT);
        expect(other.asked.map(call => call.view)).toEqual([undefined]);
    });
});

describe('on the wire', () => {
    // The real `tryLoadGraphFromSidecar` reaches VS Code by `require`, which
    // the test runner's alias does not cover: answer it with the mock for
    // the length of this suite (as characterization-graph-load.test.ts does).
    let originalLoad: (request: string, parent: unknown, isMain: boolean) => unknown;
    const cleanup: string[] = [];
    beforeAll(() => {
        originalLoad = (Module as any)._load;
        (Module as any)._load = function patched(this: unknown, wanted: string, parent: unknown, isMain: boolean) {
            return wanted === 'vscode' ? vscodeMock : originalLoad.call(this, wanted, parent, isMain);
        };
    });
    afterAll(() => {
        (Module as any)._load = originalLoad;
    });
    afterEach(() => {
        delete process.env.FAKE_SIDECAR_LOG;
        for (const entry of cleanup.splice(0)) {
            fs.rmSync(entry, { recursive: true, force: true });
        }
    });

    it('the sidecar is sent the root’s file, the root, the path and the view, and no name', async () => {
        const log = path.join(os.tmpdir(), `view-of-instance-${process.pid}-${Math.random().toString(36).slice(2)}.log`);
        cleanup.push(log);
        process.env.FAKE_SIDECAR_LOG = log;
        const modelSource = new SidecarModelSource({ ...CFG, sidecarCommandDefault: path.join(__dirname, 'fixtures', 'fake-sidecar.cjs') });
        await modelSource.getGraph(UNIT, { requestOptions: request({ viewOf: 'instance' }) });

        const sent = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(sent).toHaveLength(1);
        expect(sent[0].file).toBe('/tmp/decoder.py');
        expect(sent[0].args).toEqual({ rootNetwork: 'decoder', instancePath: ['motion_Y', 'interpolation'], view: 'actor' });
    });
});

describe('a view without the mark', () => {
    it('is asked of its file by name, as before', async () => {
        const { modelSource, asked } = source(() => ({ graph: GRAPH }));
        await modelSource.getGraph(UNIT, { requestOptions: request() });

        expect(asked).toEqual([BY_NAME]);
    });

    it('still falls back to the root when its file has no answer', async () => {
        const { modelSource, asked } = source(call => (call === 1 ? { error: 'not found' } : { graph: GRAPH }));
        await modelSource.getGraph(UNIT, { requestOptions: request() });

        expect(asked).toEqual([BY_NAME, BY_INSTANCE]);
    });

    it('is what a mark on another view, or on a crumb reached through no instance, comes down to', async () => {
        // The request is for another view than the crumb's.
        const other = source(() => ({ graph: GRAPH }));
        await other.modelSource.getGraph(UNIT, { requestOptions: request({ viewOf: 'instance' }, 'synthesis') });
        expect(other.asked.map(call => call.file)).toEqual(['/tmp/interpolation.py']);
        // No instance on the last crumb: there is no path to ask by.
        const direct = source(() => ({ graph: GRAPH }));
        await direct.modelSource.getGraph(UNIT, { requestOptions: request({ viewOf: 'instance', workflowInstanceName: '' }) });
        expect(direct.asked.map(call => call.file)).toEqual(['/tmp/interpolation.py']);
        // A mark that is not the one the platform knows.
        const odd = source(() => ({ graph: GRAPH }));
        await odd.modelSource.getGraph(UNIT, { requestOptions: request({ viewOf: 'definition' }) });
        expect(odd.asked.map(call => call.file)).toEqual(['/tmp/interpolation.py']);
    });
});
