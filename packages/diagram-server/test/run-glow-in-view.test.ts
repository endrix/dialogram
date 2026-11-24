/**
 * The running glow in a view of a nested workflow: on the node of the view the
 * running instance is in, found by its instance path from the run's root, as
 * a failure is. A node of the view named like an instance running elsewhere,
 * at the top or in a sibling, is another instance, and it is waiting.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GModelRoot, GNode } from '@eclipse-glsp/server';
import { WorkflowDiagramMetadata, nodeInView } from '@dialogram/shared';
import { WorkflowSourceModelStorage } from '../src/server/source-model-storage';

const TOP = 'file:///w/top.py';
const INNER = 'file:///w/inner.py';
const AT_TOP = [{ sourceUri: TOP, workflowName: 'top' }];
const IN_CHILD = [...AT_TOP, { sourceUri: INNER, workflowName: 'inner', workflowInstanceName: 'child' }];

describe('the node of a view an instance is in', () => {
    it('is the instance, or the nested workflow holding it', () => {
        expect(nodeInView(['child', 'slow'], [])).toBe('child');
        expect(nodeInView(['child', 'slow'], ['child'])).toBe('slow');
    });

    it('is none when the instance is not under the view, or is the view', () => {
        expect(nodeInView(['join'], ['child'])).toBeUndefined();
        expect(nodeInView(['sibling', 'join'], ['child'])).toBeUndefined();
        expect(nodeInView(['child'], ['child'])).toBeUndefined();
    });
});

const tempDirs: string[] = [];
afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

/** The view of `names` along `trail`, with the run's `active` instances drawn on it. */
async function glowAt(
    trail: object[],
    names: string[],
    active: Array<{ entityInstanceName?: string; entityInstancePath?: string[] }>,
    byName: (entry: { entityInstanceName?: string }) => string | undefined = () => undefined
) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-glow-'));
    tempDirs.push(dir);
    const storage: any = new (WorkflowSourceModelStorage as any)();
    storage.storageOptions = { settingsNamespace: 'wf', operationPrefix: 'wf' };
    storage.isLiveExecutionGlowEnabled = async () => true;
    storage.tryLoadLatestViewerOverlay = async () => ({
        runId: 'r', outDir: dir, running: true, workflowName: 'top', sourcePath: '/w/top.py', active, edges: {}
    });
    storage.ensureModelSource = () => ({
        analysis: {
            buildOverlayAstPathCandidates: () => [],
            buildOverlaySignatureCandidates: () => [],
            buildOverlayNodeIdentityCandidates: (args: any) => (args?.name ? [args.name] : []),
            resolveOverlayActiveEntityName: (entry: any) => byName(entry)
        }
    });
    const root = new GModelRoot();
    root.id = 'root';
    root.args = {};
    root.children = names.map(name => {
        const node = new GNode();
        node.id = name;
        node.args = { name };
        return node;
    });
    await storage.applyViewerOverlayToEdges(root, '/w/top.py', 'top', trail, ['top'], undefined, false, ['/w/top.py']);
    return root.children
        .filter(node => (node.args as any)?.[WorkflowDiagramMetadata.IS_EXECUTING] === true)
        .map(node => node.id);
}

describe('the running glow', () => {
    it('is on the nested workflow in the root view', async () => {
        const glowing = await glowAt(AT_TOP, ['child', 'join'], [
            { entityInstanceName: 'child', entityInstancePath: ['child'] },
            { entityInstanceName: 'slow', entityInstancePath: ['child', 'slow'] }
        ]);
        expect(glowing).toEqual(['child']);
    });

    it('is on the instance running in a nested workflow, not on one named like an instance running above it', async () => {
        const glowing = await glowAt(IN_CHILD, ['slow', 'first', 'join', 'last'], [
            { entityInstanceName: 'child', entityInstancePath: ['child'] },
            { entityInstanceName: 'join', entityInstancePath: ['join'] },
            { entityInstanceName: 'slow', entityInstancePath: ['child', 'slow'] }
        ]);
        expect(glowing).toEqual(['slow']);
    });

    it('is not on an instance named like one running in a sibling workflow', async () => {
        const glowing = await glowAt(IN_CHILD, ['slow', 'join'], [
            { entityInstanceName: 'sibling', entityInstancePath: ['sibling'] },
            { entityInstanceName: 'join', entityInstancePath: ['sibling', 'join'] }
        ]);
        expect(glowing).toEqual([]);
    });

    it('is matched by name for an instance the run gives no path', async () => {
        const glowing = await glowAt(IN_CHILD, ['slow', 'join'], [{ entityInstanceName: 'join' }], entry => entry.entityInstanceName);
        expect(glowing).toEqual(['join']);
    });
});
