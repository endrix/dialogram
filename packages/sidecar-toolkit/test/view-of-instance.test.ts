/**
 * A view of the instance it was reached through (`meta.views` entry with
 * `of: 'instance'`, carried on the trail's last crumb as `viewOf`).
 *
 * By name, a file answers for the definition it holds under that name. For a
 * unit made per instance (by a factory, with the instance's parameters) that
 * is another one. So such a view is asked of the root first, by the path of
 * instances the trail records, exactly as a drill-down into a nested unit
 * falls back to; the file is asked by name only when the root has no answer,
 * and the same question is never asked twice. A view without the mark is
 * asked as before.
 */
import { describe, expect, it } from 'vitest';
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

    it('asks no third time when neither has an answer', async () => {
        const { modelSource, asked } = source(() => ({ error: 'nothing' }));
        await modelSource.getGraph(UNIT, { requestOptions: request({ viewOf: 'instance' }) });

        expect(asked).toEqual([BY_INSTANCE, BY_NAME]);
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
