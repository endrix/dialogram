/**
 * The kind of an edge, when a sidecar's `connect` can make more than one.
 *
 * A workflow connection is one thing, so `connect` never said what kind of
 * edge it made. A specification's clauses are joined by typed edges (refines,
 * verifies, depends-on), and a sidecar for them lists the kinds in its
 * capabilities (`edgeRoles`); the create-edge handler then asks which, and
 * sends `args.role`. A sidecar that lists none is treated as before.
 */
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';

import { parseCapabilitiesDiagnostic, parseEdgeRoles } from '../src/sidecar-capabilities.js';
import { CreateEdgeOperationHandler } from '../src/server/operations/create-edge-handler.js';
import { SidecarInvoker } from '../src/server/operations/sidecar-invoker';
import { DeleteElementOperationHandler } from '../src/server/operations/delete-handler.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROLES = [
    { id: 'refines', label: 'Refines: this clause narrows the target' },
    { id: 'verifies', label: 'Verifies: this clause checks the target' },
    { id: 'depends-on', label: 'Depends on', description: 'this clause needs the target' }
];

describe('edge roles in the capabilities', () => {
    it('reads edgeRoles, dropping an entry without an id and defaulting a missing label to the id', () => {
        expect(parseEdgeRoles([...ROLES, { label: 'no id' }, { id: ' bare ' }, 7])).toEqual([
            ...ROLES,
            { id: 'bare', label: 'bare' }
        ]);
        expect(parseEdgeRoles(undefined)).toBeUndefined();
        expect(parseEdgeRoles([])).toBeUndefined();
    });

    it('carries them on the parsed capabilities, and leaves them out when the sidecar lists none', () => {
        const withRoles = parseCapabilitiesDiagnostic(
            { protocolVersion: 2, supportedOps: ['connect'], features: {}, edgeRoles: ROLES },
            'ndf'
        );
        expect(withRoles?.edgeRoles).toEqual(ROLES);
        const without = parseCapabilitiesDiagnostic({ protocolVersion: 2, supportedOps: ['connect'], features: {} }, 'wfpy');
        expect(without).toBeDefined();
        expect(without?.edgeRoles).toBeUndefined();
    });
});

/** A model with two clause nodes, each with one pin, as the NDF diagram draws them. */
function modelState() {
    const node = (name: string) => ({
        id: name,
        type: 'node:actor',
        args: { [WorkflowDiagramMetadata.ENTITY_NAME]: name }
    });
    const port = (id: string, name: string, parent: unknown) => ({
        id,
        type: 'port:in',
        parent,
        args: { [WorkflowDiagramMetadata.PORT_NAME]: name }
    });
    const a = node('Frame admission');
    const b = node('Forwarding intent');
    const elements = new Map<string, unknown>([
        ['a_out', port('a_out', 'out', a)],
        ['b_in', port('b_in', 'in', b)]
    ]);
    return {
        root: { args: { sourceUri: 'file:///spec/docs/forwarding.md', [WorkflowDiagramMetadata.WORKFLOW_NAME]: 'DOC-FORWARDING' } },
        index: { get: (id: string) => elements.get(id) }
    };
}

/** A sidecar invoker whose capabilities answer is `capabilities`, counting the asks. */
function invokerWith(capabilities: unknown, asks = { count: 0 }, answers: Array<boolean> = []): any {
    const invoker: any = {
        edgeRolesByCommand: new Map(),
        sidecarOp: (op: string) => `ndf.${op}`,
        undoLabelSuffix: () => ' (ndf)',
        sidecarCommand: () => 'ndf-sidecar',
        sendSidecarCapabilitiesDetailed: async () => {
            asks.count++;
            const ok = answers.length > 0 ? answers.shift()! : true;
            return ok ? { ok: true, response: { status: 'ok', diagnostic: capabilities } } : { ok: false, message: 'no answer' };
        }
    };
    invoker.edgeRoles = SidecarInvoker.prototype.edgeRoles.bind(invoker);
    return invoker;
}

function handlerWith(capabilities: unknown, sent: Array<{ op: string; args: Record<string, unknown> }>, invoker = invokerWith(capabilities)) {
    const handler = new CreateEdgeOperationHandler();
    (handler as any).modelState = modelState();
    (handler as any).sidecar = invoker;
    (handler as any).sendSidecarOp = async (_uri: string, payload: { op: string; args: Record<string, unknown> }) => {
        sent.push(payload);
        return true;
    };
    return handler;
}

async function connect(handler: CreateEdgeOperationHandler, args?: Record<string, unknown>) {
    const command = handler.createCommand({
        kind: 'createEdge',
        elementTypeId: 'edge:connection',
        sourceElementId: 'a_out',
        targetElementId: 'b_in',
        ...(args ? { args } : {})
    } as any);
    expect(command).toBeTruthy();
    // The edits are computed when the command runs; that is where the sidecar is asked.
    return (command as any).options?.computeEdits?.() ?? (command as any).computeEdits?.();
}

describe('the create-edge handler and the kind of edge', () => {
    it('sends connect without a role when the sidecar lists no roles, as before', async () => {
        const sent: Array<{ op: string; args: Record<string, unknown> }> = [];
        const windowAny = vscode.window as any;
        const original = windowAny.showQuickPick;
        let asked = false;
        windowAny.showQuickPick = async () => {
            asked = true;
            return undefined;
        };
        try {
            await connect(handlerWith({ protocolVersion: 2, supportedOps: ['connect'], features: {} }, sent));
        } finally {
            windowAny.showQuickPick = original;
        }
        expect(asked).toBe(false);
        expect(sent).toEqual([{
            op: 'ndf.connect',
            args: {
                workflow: 'DOC-FORWARDING',
                from_port: { type: 'actor', actor: 'Frame admission', port: 'out' },
                to_port: { type: 'actor', actor: 'Forwarding intent', port: 'in' }
            }
        }]);
    });

    it('asks which kind when the sidecar lists several, and sends the pick as args.role', async () => {
        const sent: Array<{ op: string; args: Record<string, unknown> }> = [];
        const windowAny = vscode.window as any;
        const original = windowAny.showQuickPick;
        let offered: Array<{ label: string; description?: string }> = [];
        windowAny.showQuickPick = async (items: Array<{ label: string; description?: string; id: string }>) => {
            offered = items;
            return items.find(item => item.id === 'verifies');
        };
        try {
            await connect(handlerWith({ protocolVersion: 2, supportedOps: ['connect'], features: {}, edgeRoles: ROLES }, sent));
        } finally {
            windowAny.showQuickPick = original;
        }
        expect(offered.map(item => item.label)).toEqual(['refines', 'verifies', 'depends-on']);
        expect(offered[0].description).toBe('Refines: this clause narrows the target');
        expect(sent).toHaveLength(1);
        expect(sent[0].args.role).toBe('verifies');
    });

    it('makes no connection when the pick is dismissed', async () => {
        const sent: Array<{ op: string; args: Record<string, unknown> }> = [];
        const windowAny = vscode.window as any;
        const original = windowAny.showQuickPick;
        windowAny.showQuickPick = async () => undefined;
        try {
            const edits = await connect(handlerWith({ protocolVersion: 2, supportedOps: ['connect'], features: {}, edgeRoles: ROLES }, sent));
            expect(edits).toBeUndefined();
        } finally {
            windowAny.showQuickPick = original;
        }
        expect(sent).toEqual([]);
    });

    it('takes a role given on the operation, and the only role offered, without asking', async () => {
        const windowAny = vscode.window as any;
        const original = windowAny.showQuickPick;
        let asked = 0;
        windowAny.showQuickPick = async () => {
            asked += 1;
            return undefined;
        };
        try {
            const given: Array<{ op: string; args: Record<string, unknown> }> = [];
            await connect(handlerWith({ protocolVersion: 2, supportedOps: ['connect'], features: {}, edgeRoles: ROLES }, given), { role: 'depends-on' });
            expect(given[0].args.role).toBe('depends-on');

            const only: Array<{ op: string; args: Record<string, unknown> }> = [];
            await connect(handlerWith({ protocolVersion: 2, supportedOps: ['connect'], features: {}, edgeRoles: [ROLES[0]] }, only));
            expect(only[0].args.role).toBe('refines');

            const headless: Array<{ op: string; args: Record<string, unknown> }> = [];
            await connect(handlerWith({ protocolVersion: 2, supportedOps: ['connect'], features: {}, edgeRoles: ROLES }, headless), { headless: true });
            expect(headless[0].args.role).toBeUndefined();
        } finally {
            windowAny.showQuickPick = original;
        }
        expect(asked).toBe(0);
    });
    it('asks the sidecar what it offers once per session, not on every connect', async () => {
        const asks = { count: 0 };
        const capabilities = { supportedOps: ['connect'], edgeRoles: [{ id: 'refines' }] };
        const invoker = invokerWith(capabilities, asks);
        const sent: Array<{ op: string; args: Record<string, unknown> }> = [];
        await connect(handlerWith(capabilities, sent, invoker));
        await connect(handlerWith(capabilities, sent, invoker));
        expect(sent.map(payload => payload.args.role)).toEqual(['refines', 'refines']);
        expect(asks.count).toBe(1);
    });

    it('asks again after an ask that failed', async () => {
        const asks = { count: 0 };
        const invoker = invokerWith({ supportedOps: ['connect'], edgeRoles: [{ id: 'refines' }] }, asks, [false, true]);
        expect(await invoker.edgeRoles('file:///spec/a.md')).toBeUndefined();
        expect((await invoker.edgeRoles('file:///spec/a.md'))?.map((r: any) => r.id)).toEqual(['refines']);
        expect(asks.count).toBe(2);
    });

    it('never asks the person when an agent makes the edge (headless)', async () => {
        const sent: Array<{ op: string; args: Record<string, unknown> }> = [];
        const capabilities = { supportedOps: ['connect'], edgeRoles: [{ id: 'refines' }, { id: 'verifies' }] };
        await connect(handlerWith(capabilities, sent), { headless: true });
        expect(sent).toHaveLength(1);
        expect(sent[0].args.role).toBeUndefined();
    });
});

describe('the delete handler and the kind of edge', () => {
    async function deleteEdge(capabilities: unknown): Promise<Array<{ op: string; args: Record<string, unknown> }>> {
        const file = path.join(mkdtempSync(path.join(tmpdir(), 'edge-roles-')), 'doc.md');
        writeFileSync(file, '# doc\n');
        const edge = {
            id: 'e1',
            type: WorkflowDiagramTypes.EDGE_CONNECTION,
            args: { 'wf:from': 'A', 'wf:to': 'B', 'wf:outPort': 'out', 'wf:inPort': 'in', [WorkflowDiagramMetadata.EDGE_ROLE]: 'refines' }
        };
        const sent: Array<{ op: string; args: Record<string, unknown> }> = [];
        const handler = new DeleteElementOperationHandler() as any;
        handler.modelState = {
            root: { args: { sourceUri: pathToFileURL(file).href, 'wf:workflowName': 'DOC' } },
            index: { get: (id: string) => (id === 'e1' ? edge : undefined) }
        };
        handler.sidecar = invokerWith(capabilities);
        handler.sidecar.sendSidecarOp = async (_uri: string, payload: { op: string; args: Record<string, unknown> }) => {
            sent.push(payload);
            return true;
        };
        const workspaceAny = vscode.workspace as any;
        const original = workspaceAny.openTextDocument;
        workspaceAny.openTextDocument = async () => ({ getText: () => '# doc\n' });
        try {
            const command = handler.createCommand({ kind: 'deleteElement', elementIds: ['e1'] });
            await ((command as any).options?.computeEdits?.() ?? (command as any).computeEdits?.());
        } finally {
            workspaceAny.openTextDocument = original;
        }
        return sent;
    }

    it("sends the edge's role when the sidecar makes edges of several kinds", async () => {
        const sent = await deleteEdge({ supportedOps: ['deleteEdge'], edgeRoles: [{ id: 'refines' }, { id: 'verifies' }] });
        expect(sent.map(payload => payload.args.role)).toEqual(['refines']);
    });

    it('sends no role to a sidecar that lists none, as before', async () => {
        const sent = await deleteEdge({ supportedOps: ['deleteEdge'] });
        expect(sent).toHaveLength(1);
        expect(sent[0].args.role).toBeUndefined();
    });
});
