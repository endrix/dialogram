/**
 * Copy writes the clipboard shape paste reads. The two used to differ: copy
 * wrote the entity's name under `entityName` with its source text, while the
 * sidecar toolkit's paste looked for `name` and `typeName`, so a copied node
 * pasted as nothing. Cut and duplicate already wrote the paste shape.
 */
import { RequestClipboardDataAction } from '@eclipse-glsp/protocol';
import { describe, expect, it } from 'vitest';
import { parseClipboardPayload, WorkflowDiagramMetadata, WorkflowDiagramTypes, WORKFLOW_NETWORK_MODEL_KEY } from '@dialogram/shared';
import { WorkflowRequestClipboardDataActionHandler } from '../src/server/request-clipboard-data-action-handler';

function modelStateWith(elements: Record<string, any>, sourceUri?: string) {
    return {
        sourceUri,
        get: (key: string) => (key === WORKFLOW_NETWORK_MODEL_KEY ? { documentUri: sourceUri } : undefined),
        index: { get: (id: string) => elements[id] }
    };
}

function copyOf(handler: WorkflowRequestClipboardDataActionHandler, selectedElementIds: string[]) {
    return handler.execute(RequestClipboardDataAction.create({ selectedElementIds }, { requestId: 'req-1' }));
}

describe('WorkflowRequestClipboardDataActionHandler', () => {
    it('writes the payload the toolkit paste reads: names, not source text', async () => {
        const handler = new WorkflowRequestClipboardDataActionHandler();
        (handler as any).modelState = modelStateWith({
            add: {
                type: WorkflowDiagramTypes.NODE_ACTOR,
                args: { [WorkflowDiagramMetadata.ENTITY_NAME]: 'add', [WorkflowDiagramMetadata.ENTITY_TYPE]: 'Adder' }
            },
            inPort: {
                type: WorkflowDiagramTypes.NODE_BOUNDARY_INPUT,
                args: { [WorkflowDiagramMetadata.PORT_NAME]: 'a', [WorkflowDiagramMetadata.PORT_TYPE]: 'int' }
            },
            wire: {
                type: WorkflowDiagramTypes.EDGE_CONNECTION,
                args: { 'wf:from': 'src', 'wf:to': 'add', 'wf:outPort': 'out', 'wf:inPort': 'a' }
            }
        }, 'file:///hdl/top.sv');

        const [action] = await copyOf(handler, ['add', 'inPort', 'wire']);
        const payload = parseClipboardPayload((action as any).clipboardData);

        expect(payload).toEqual({
            version: 1,
            sourceUri: 'file:///hdl/top.sv',
            items: [
                { kind: 'entity', elementTypeId: WorkflowDiagramTypes.NODE_ACTOR, name: 'add', typeName: 'Adder' },
                { kind: 'boundaryPort', elementTypeId: WorkflowDiagramTypes.NODE_BOUNDARY_INPUT, direction: 'input', portName: 'a', portType: 'int' },
                { kind: 'connection', elementTypeId: WorkflowDiagramTypes.EDGE_CONNECTION, from: 'src', to: 'add', outPort: 'out', inPort: 'a' }
            ]
        });
        expect((action as any).responseId).toBe('req-1');
    });

    it('leaves out read-only elements and elements with no name', async () => {
        const handler = new WorkflowRequestClipboardDataActionHandler();
        (handler as any).modelState = modelStateWith({
            locked: {
                type: WorkflowDiagramTypes.NODE_ACTOR,
                args: { [WorkflowDiagramMetadata.ENTITY_NAME]: 'x', [WorkflowDiagramMetadata.ENTITY_TYPE]: 'X', [WorkflowDiagramMetadata.IS_READ_ONLY]: true }
            },
            nameless: { type: WorkflowDiagramTypes.NODE_ACTOR, args: {} }
        }, 'file:///hdl/top.sv');

        const [action] = await copyOf(handler, ['locked', 'nameless', 'missing']);
        expect(parseClipboardPayload((action as any).clipboardData)?.items).toEqual([]);
    });

    it('answers with empty clipboard data when the model has no source', async () => {
        const handler = new WorkflowRequestClipboardDataActionHandler();
        (handler as any).modelState = modelStateWith({}, undefined);

        const [action] = await copyOf(handler, ['anything']);
        expect((action as any).clipboardData).toEqual({});
        expect(parseClipboardPayload((action as any).clipboardData)).toBeUndefined();
    });
});

describe('parseClipboardPayload', () => {
    it('rejects data that is not a diagram payload', () => {
        expect(parseClipboardPayload(undefined)).toBeUndefined();
        expect(parseClipboardPayload({})).toBeUndefined();
        expect(parseClipboardPayload({ 'text/plain': 'hello' })).toBeUndefined();
        expect(parseClipboardPayload({ 'application/json': JSON.stringify({ version: 2, sourceUri: 'x', items: [] }) })).toBeUndefined();
    });
});
