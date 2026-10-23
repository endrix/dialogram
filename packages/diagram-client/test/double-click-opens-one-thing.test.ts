/**
 * A double-click opens one thing.
 *
 * Two listeners answer a double-click on a node that is not a network
 * instance: the network navigation listener opens its first view, or its
 * definition when the product asks (`doubleClickOpensSource`), and the viewer
 * listener opened its definition as a preview. Both ran, so a specification
 * clause opened its refinement trace and its heading at once. The viewer
 * listener now stands back whenever the other one opens something.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { ViewerMouseListener } from '../src/viewer-mouse-listener';

const node = (type: string, extra: Record<string, unknown>): any => ({
    id: 'clause',
    type,
    args: {
        [WorkflowDiagramMetadata.REFERENCED_URI]: 'file:///w/spec/pipeline.md',
        [WorkflowDiagramMetadata.REFERENCED_SOURCE_RANGE]: { start: { line: 9, character: 0 }, end: { line: 9, character: 0 } },
        ...extra
    },
    children: []
});

const viewerAnswer = (element: unknown): unknown[] => {
    const listener: any = new ViewerMouseListener();
    listener.editorContext = { sourceUri: 'file:///w/spec/pipeline.md' };
    return listener.doubleClick(element, {} as MouseEvent);
};

const behaviour = (clientBehavior: Record<string, unknown>): void => {
    (globalThis as any).diagramIdentifier = { clientBehavior };
};

afterEach(() => {
    delete (globalThis as any).diagramIdentifier;
});

describe('the viewer listener on a double-click', () => {
    const views = { [WorkflowDiagramMetadata.VIEWS]: [{ id: 'refines', label: 'Refinement trace' }] };

    it('stands back for a node whose first view opens', () => {
        behaviour({});
        expect(viewerAnswer(node(WorkflowDiagramTypes.NODE_ACTOR, views))).toEqual([]);
        expect(viewerAnswer(node(WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR, { ...views, [WorkflowDiagramMetadata.IS_EXTERNAL_ACTOR]: true }))).toEqual([]);
    });

    it('stands back when the product opens a node’s definition itself', () => {
        behaviour({ doubleClickOpensSource: true });
        expect(viewerAnswer(node(WorkflowDiagramTypes.NODE_ACTOR, {}))).toEqual([]);
    });

    it('still opens the definition of a node nothing else opens', () => {
        behaviour({});
        const [action] = viewerAnswer(node(WorkflowDiagramTypes.NODE_ACTOR, {})) as any[];
        expect(action?.kind).toBe('navigateToExternalTarget');
    });
});
