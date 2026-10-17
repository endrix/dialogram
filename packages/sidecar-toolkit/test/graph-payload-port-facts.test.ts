import { describe, expect, it } from 'vitest';
import { SidecarModelSource, type SidecarRuntimeConfig } from '../src/index';
import { NEUTRAL_CREATE_NODE_CONFIG } from './fixtures/create-node-config';

const CFG: SidecarRuntimeConfig = {
    settingsNamespace: 'wfLang',
    sidecarOperationPrefix: 'wfpy',
    sidecarCommandSettingKey: 'wfpySidecarCommand',
    sidecarCommandDefault: 'wfpy-sidecar',
    cliCommandSettingKey: 'wfpyCommand',
    cliCommandDefault: 'wfpy',
    cliPythonModule: undefined,
    operationKinds: { createEntityPort: 'op.createEntityPort', deleteEntityPort: 'op.deleteEntityPort' },
    ...NEUTRAL_CREATE_NODE_CONFIG,
    acceptedOperationPrefixes: ['wfpy'],
    graphAcquisition: 'sidecar-export'
};

describe('graph payload port facts', () => {
    it('passes a port\'s role, bundle, side and width through to the document', () => {
        const doc = new SidecarModelSource(CFG).graphPayloadToDoc({
            network: 'top',
            nodes: [{
                id: 'node:scope:root:u', kind: 'instance', label: 'u', scope: 'scope:root',
                ports: [
                    { id: 'p:valid', name: 's_valid', direction: 'in', type: 'logic', group: 's', width: 1 },
                    { id: 'p:ready', name: 's_ready', direction: 'out', type: 'logic', group: 's', side: 'west' },
                    { id: 'p:sda', name: 'sda', direction: 'out', type: 'wire', role: 'bidirectional' },
                    { id: 'p:plain', name: 'q', direction: 'out', type: 'logic', side: 42, width: 'wide' }
                ],
                metadata: {}
            }],
            edges: []
        }) as any;
        const ports = doc.graph.nodes[0].ports;
        expect(ports[0]).toMatchObject({ name: 's_valid', direction: 'in', group: 's', width: 1 });
        expect(ports[0].side).toBeUndefined();
        expect(ports[1]).toMatchObject({ name: 's_ready', direction: 'out', group: 's', side: 'west' });
        expect(ports[2]).toMatchObject({ name: 'sda', role: 'bidirectional' });
        // Values of the wrong type are dropped, not passed along.
        expect(ports[3].side).toBeUndefined();
        expect(ports[3].width).toBeUndefined();
    });
});
