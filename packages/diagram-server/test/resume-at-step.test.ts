/**
 * Resuming a run at a step: what the server tells the client.
 *
 * The stepper's resume button and the node's "Rerun from Here" appear only for
 * a run whose queue trace can be resumed — every step carrying the journal
 * position a runtime replays from. The server reads that from the trace and
 * says so on the root; the menu offers the item only then.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { WorkflowContextMenuItemProvider } from '../src/server/context-menu-item-provider';
import { WorkflowSourceModelStorage } from '../src/server/source-model-storage';

async function traceIn(steps: Array<Record<string, unknown>>): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-trace-'));
    await fs.writeFile(path.join(dir, 'run.wf-queues.json'), JSON.stringify({ version: 1, steps }));
    return dir;
}

const step = (n: number, extra: Record<string, unknown> = {}) => ({
    step: n,
    actorInstanceName: 'a',
    queueSizes: [],
    ...extra
});

describe('a queue trace that can be resumed', () => {
    const load = (dir: string) =>
        (new WorkflowSourceModelStorage() as any).tryLoadQueueTraceAtStep(dir, 0);

    it('is one whose every step carries a journal position', async () => {
        const dir = await traceIn([step(1, { journalSeq: 1 }), step(2, { journalSeq: 3 })]);
        expect((await load(dir)).resumable).toBe(true);
    });

    it('is not one written without a journal', async () => {
        const dir = await traceIn([step(1), step(2)]);
        expect((await load(dir)).resumable).toBe(false);
    });

    it('is not one with a step missing its position', async () => {
        const dir = await traceIn([step(1, { journalSeq: 1 }), step(2)]);
        expect((await load(dir)).resumable).toBe(false);
    });
});

describe('Rerun from Here', () => {
    function itemsFor(rootArgs: Record<string, unknown>): string[] {
        const root: any = { id: 'root', type: 'graph', args: rootArgs };
        const node: any = {
            id: 'node:review',
            type: WorkflowDiagramTypes.NODE_ACTOR,
            args: { [WorkflowDiagramMetadata.ENTITY_NAME]: 'review' },
            parent: root
        };
        const provider: any = new WorkflowContextMenuItemProvider();
        provider.modelState = {
            sourceUri: 'file:///w/flow.py',
            root,
            index: { find: (id: string) => (id === node.id ? node : undefined) }
        };
        const items = provider.getItems([node.id], { x: 0, y: 0 });
        return items.map((item: any) => item.id);
    }

    it('is offered on a node when the shown run can be resumed', () => {
        expect(itemsFor({ 'wf:queueTraceResumable': true })).toContain('dialogram.rerunFromHere');
    });

    it('is not offered otherwise', () => {
        expect(itemsFor({ 'wf:queueTraceResumable': false })).not.toContain('dialogram.rerunFromHere');
        expect(itemsFor({})).not.toContain('dialogram.rerunFromHere');
    });

    it('names the node it reruns', () => {
        const root: any = { id: 'root', type: 'graph', args: { 'wf:queueTraceResumable': true } };
        const node: any = {
            id: 'n',
            type: WorkflowDiagramTypes.NODE_ACTOR,
            args: { [WorkflowDiagramMetadata.ENTITY_NAME]: 'review' },
            parent: root
        };
        const provider: any = new WorkflowContextMenuItemProvider();
        provider.modelState = { sourceUri: 'file:///w/flow.py', root, index: { find: () => node } };
        const item = provider.getItems(['n'], { x: 0, y: 0 }).find((i: any) => i.id === 'dialogram.rerunFromHere');
        expect(item.actions).toEqual([{ kind: 'dialogram.rerunFromHere', entityName: 'review' }]);
    });
});
