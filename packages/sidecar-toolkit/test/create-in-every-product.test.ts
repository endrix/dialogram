/**
 * The create-node and entity-port handlers used to accept only a `.py` source,
 * so the palette never created a node, and the property panel never added an
 * entity port, in a Verilog, VHDL or NDF diagram. Like every other handler
 * that writes to the source, they now ask only that the model has one.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Container } from 'inversify';
import { ModelState } from '@eclipse-glsp/server';
import { LayoutPersistenceService } from '@dialogram/diagram-server/services/layout-persistence-service';
import { WorkflowDiagramTypes } from '@dialogram/shared';
import { createSidecarServerModule } from '../src/server/sidecar-server-module.js';
import { CreateNodeOperationHandler } from '../src/server/operations/create-node-handler.js';
import { createEntityPortCrudHandlers } from '../src/server/operations/entity-port-crud-handler.js';
import type { SidecarRuntimeConfig } from '../src/server/sidecar-runtime-config.js';
import { NEUTRAL_CREATE_NODE_CONFIG } from './fixtures/create-node-config.js';

const HDL_CONFIG: SidecarRuntimeConfig = {
    settingsNamespace: 'hdl',
    sidecarOperationPrefix: 'hdl',
    sidecarCommandSettingKey: 'sidecarCommand',
    sidecarCommandDefault: 'hdl-sidecar',
    cliCommandSettingKey: 'cliCommand',
    cliCommandDefault: 'hdl',
    operationKinds: { createEntityPort: 'hdl.createEntityPort', deleteEntityPort: 'hdl.deleteEntityPort' },
    acceptedOperationPrefixes: ['hdl'],
    graphAcquisition: 'cli-plan',
    ...NEUTRAL_CREATE_NODE_CONFIG
};

function containerFor(sourceUri: string | undefined): Container {
    const container = new Container();
    container.load(createSidecarServerModule(HDL_CONFIG));
    container.bind(ModelState).toConstantValue({ sourceUri, root: { args: { sourceUri } } } as any);
    container.bind(LayoutPersistenceService).toConstantValue(new LayoutPersistenceService());
    return container;
}

const createNode = { kind: 'createNode', elementTypeId: WorkflowDiagramTypes.NODE_TASK, location: { x: 0, y: 0 } } as any;

describe('the palette creates a node in every product', () => {
    it.each(['file:///hdl/top.sv', 'file:///hdl/top.vhd', 'file:///spec/docs/forwarding.md', 'file:///wf/flow.py'])(
        'for the source %s',
        sourceUri => {
            const handler = containerFor(sourceUri).resolve(CreateNodeOperationHandler);
            expect(handler.createCommand(createNode)).toBeDefined();
        }
    );

    it('but not for a model without a source', () => {
        const handler = containerFor(undefined).resolve(CreateNodeOperationHandler);
        expect(handler.createCommand(createNode)).toBeUndefined();
    });
});

describe('the property panel adds an entity port in every product', () => {
    const [CreateHandler] = createEntityPortCrudHandlers(HDL_CONFIG.operationKinds);
    const op = { kind: HDL_CONFIG.operationKinds.createEntityPort, entityType: 'Counter', portDirection: 'input', portName: 'clk', portType: 'std_logic' };

    it.each(['file:///hdl/top.vhd', 'file:///hdl/top.sv'])('for the source %s', sourceUri => {
        const handler = containerFor(sourceUri).resolve(CreateHandler) as any;
        expect(handler.createCommand(op)).toBeDefined();
    });

    it('but not for a model without a source', () => {
        const handler = containerFor(undefined).resolve(CreateHandler) as any;
        expect(handler.createCommand(op)).toBeUndefined();
    });
});
