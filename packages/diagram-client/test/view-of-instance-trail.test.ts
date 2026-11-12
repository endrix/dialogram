/**
 * A view of the instance it is reached through (`wf:views` entry with
 * `of: 'instance'`), on the client's side of the trail.
 *
 * The view's crumb keeps the mark, and the trail the request carries has it,
 * so the server asks for the view by the path of instances, now and whenever
 * the trail leads back to the crumb.
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowNavigationUi } from '../src/navigation-ui';
import { WorkflowOpenViewActionHandler } from '../src/editing-action-handlers';

const ROOT = 'file:///w/decoder.py';
const UNIT = 'file:///w/interpolation.py';

/** A navigation UI with no page behind it: what `requestView` needs and no more. */
function navigation(): any {
    const ui: any = Object.create(WorkflowNavigationUi.prototype);
    ui.editorContext = { sourceUri: ROOT, diagramType: 'workflow-diagram' };
    ui.stacksBySourceUri = new Map();
    return ui;
}

const trailOf = (action: any): any[] => JSON.parse(action.options['wf:navTrail']);

afterEach(() => {
    delete (globalThis as any).__calDiagramContext;
});

describe('a view of the instance it is reached through', () => {
    it('is marked on its crumb, which the request carries', () => {
        (globalThis as any).__calDiagramContext = { workflowName: 'decoder' };
        const action = navigation().requestView(UNIT, 'Interpolation', 'interpolation', 'actor', 'Actor', 'instance');

        expect(action.options).toMatchObject({ sourceUri: UNIT, networkName: 'Interpolation', 'wf:view': 'actor' });
        expect(trailOf(action)).toEqual([
            { sourceUri: ROOT, workflowName: 'decoder' },
            { sourceUri: UNIT, workflowName: 'Interpolation', workflowInstanceName: 'interpolation', view: 'actor', viewLabel: 'Actor', viewOf: 'instance' }
        ]);
    });

    it('ends a trail that leads to it through every instance on the way: the editor’s own stack', () => {
        // The editor's document is the root; a nested unit was drilled into before.
        const NESTED = 'file:///w/motion.py';
        const ui = navigation();
        ui.stacksBySourceUri.set(ROOT, [
            { sourceUri: ROOT, workflowName: 'decoder' },
            { sourceUri: NESTED, workflowName: 'motion', workflowInstanceName: 'motion_Y' }
        ]);
        const action = ui.requestView(UNIT, 'Interpolation', 'interpolation', 'actor', 'Actor', 'instance');

        expect(trailOf(action)).toEqual([
            { sourceUri: ROOT, workflowName: 'decoder' },
            { sourceUri: NESTED, workflowName: 'motion', workflowInstanceName: 'motion_Y' },
            { sourceUri: UNIT, workflowName: 'Interpolation', workflowInstanceName: 'interpolation', view: 'actor', viewLabel: 'Actor', viewOf: 'instance' }
        ]);
        // And the stack the next request starts from is that trail, the mark with it.
        expect(ui.stacksBySourceUri.get(UNIT).at(-1)).toMatchObject({ view: 'actor', viewOf: 'instance' });
    });

    it('is not marked on the crumb of a view of the definition', () => {
        (globalThis as any).__calDiagramContext = { workflowName: 'decoder' };
        const action = navigation().requestView(UNIT, 'Interpolation', 'interpolation', 'synthesis', undefined);

        expect(trailOf(action)[1]).toEqual({ sourceUri: UNIT, workflowName: 'Interpolation', workflowInstanceName: 'interpolation', view: 'synthesis' });
    });

    it('is still marked when the trail comes back from the server', () => {
        const ui = navigation();
        const sent = [
            { sourceUri: ROOT, workflowName: 'decoder' },
            { sourceUri: UNIT, workflowName: 'Interpolation', workflowInstanceName: 'interpolation', view: 'actor', viewOf: 'instance' },
            // A mark the platform does not know, and one on a crumb that is no view, are dropped.
            { sourceUri: 'file:///w/other.py', workflowName: 'Other', workflowInstanceName: 'o', view: 'x', viewOf: 'something' },
            { sourceUri: 'file:///w/plain.py', workflowName: 'Plain', workflowInstanceName: 'p', viewOf: 'instance' }
        ];
        expect(ui.parseTrail(JSON.stringify(sent)).map((crumb: any) => crumb.viewOf)).toEqual([undefined, 'instance', undefined, undefined]);
    });

    it('is passed on by the handler of the node’s action', () => {
        const asked: unknown[][] = [];
        const handler: any = new WorkflowOpenViewActionHandler();
        handler.actionDispatcher = { dispatch: async () => undefined };
        handler.navigationUi = { requestView: (...args: unknown[]) => { asked.push(args); return {}; } };
        const base = { kind: 'dialogram.openView', view: 'actor', label: 'Actor', uri: UNIT, workflowName: 'Interpolation', workflowInstanceName: 'interpolation' };
        handler.handle({ ...base, viewOf: 'instance' });
        handler.handle(base);
        handler.handle({ ...base, viewOf: 'anything else' });

        expect(asked.map(args => args[5])).toEqual(['instance', undefined, undefined]);
    });
});
