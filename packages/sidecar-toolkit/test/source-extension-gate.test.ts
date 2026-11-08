/**
 * The operation handlers that write to a diagram's source used to accept only a
 * `.py` source, so the palette never created a node, and the property panel never
 * added an entity port, in a Verilog, VHDL or NDF diagram. The gate now reads the
 * profile's `sourceExtensions`.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Container } from 'inversify';
import { ModelState } from '@eclipse-glsp/server';
import { LayoutPersistenceService } from '@dialogram/diagram-server/services/layout-persistence-service';
import { WorkflowDiagramTypes } from '@dialogram/shared';
import { createSidecarServerModule } from '../src/server/sidecar-server-module.js';
import { SidecarInvoker } from '../src/server/operations/sidecar-invoker.js';
import { CreateNodeOperationHandler } from '../src/server/operations/create-node-handler.js';
import { createEntityPortCrudHandlers } from '../src/server/operations/entity-port-crud-handler.js';
import { handlesSource, type SidecarRuntimeConfig } from '../src/server/sidecar-runtime-config.js';
import { createSidecarDiagramProfile, type SidecarProfileInput } from '../src/sidecar-diagram-profile.js';
import { NEUTRAL_CREATE_NODE_CONFIG } from './fixtures/create-node-config.js';

function verilogConfig(overrides: Partial<SidecarRuntimeConfig> = {}): SidecarRuntimeConfig {
    return {
        settingsNamespace: 'hdl',
        sidecarOperationPrefix: 'hdl',
        sidecarCommandSettingKey: 'sidecarCommand',
        sidecarCommandDefault: 'hdl-sidecar',
        cliCommandSettingKey: 'cliCommand',
        cliCommandDefault: 'hdl',
        operationKinds: { createEntityPort: 'hdl.createEntityPort', deleteEntityPort: 'hdl.deleteEntityPort' },
        acceptedOperationPrefixes: ['hdl'],
        graphAcquisition: 'cli-plan',
        sourceExtensions: ['.sv', '.v'],
        ...NEUTRAL_CREATE_NODE_CONFIG,
        ...overrides
    };
}

function containerFor(cfg: SidecarRuntimeConfig, sourceUri: string): Container {
    const container = new Container();
    container.load(createSidecarServerModule(cfg));
    container.bind(ModelState).toConstantValue({ sourceUri, root: { args: { sourceUri } } } as any);
    container.bind(LayoutPersistenceService).toConstantValue(new LayoutPersistenceService());
    return container;
}

describe('handlesSource', () => {
    it('accepts a source with one of the configured extensions, whatever its case', () => {
        const cfg = { sourceExtensions: ['.sv', '.v'] };
        expect(handlesSource(cfg, 'file:///hdl/top.sv')).toBe(true);
        expect(handlesSource(cfg, 'file:///hdl/TOP.V')).toBe(true);
        expect(handlesSource(cfg, 'file:///hdl/top.py')).toBe(false);
        expect(handlesSource(cfg, 'file:///hdl/top.svh')).toBe(false);
    });

    it('accepts every source when the config names no extension', () => {
        expect(handlesSource({}, 'file:///any/file.xyz')).toBe(true);
        expect(handlesSource({ sourceExtensions: [] }, 'file:///any/file.xyz')).toBe(true);
    });
});

describe('the source gate of the editing handlers', () => {
    const createNode = { kind: 'createNode', elementTypeId: WorkflowDiagramTypes.NODE_TASK, location: { x: 0, y: 0 } } as any;

    it('lets the palette create a node in a Verilog diagram', () => {
        const container = containerFor(verilogConfig(), 'file:///hdl/top.sv');
        const handler = container.resolve(CreateNodeOperationHandler);
        expect(handler.createCommand(createNode)).toBeDefined();
    });

    it('still refuses a source the product does not edit', () => {
        const container = containerFor(verilogConfig(), 'file:///hdl/top.py');
        const handler = container.resolve(CreateNodeOperationHandler);
        expect(handler.createCommand(createNode)).toBeUndefined();
    });

    it('keeps the Python product on its own sources', () => {
        const python = verilogConfig({ sourceExtensions: ['.py'] });
        expect(containerFor(python, 'file:///wf/flow.py').resolve(CreateNodeOperationHandler).createCommand(createNode)).toBeDefined();
        expect(containerFor(python, 'file:///wf/flow.sv').resolve(CreateNodeOperationHandler).createCommand(createNode)).toBeUndefined();
    });

    it('lets the property panel add an entity port in a VHDL diagram', () => {
        const cfg = verilogConfig({ sourceExtensions: ['.vhd', '.vhdl'] });
        const [CreateHandler] = createEntityPortCrudHandlers(cfg.operationKinds);
        const container = containerFor(cfg, 'file:///hdl/top.vhd');
        const handler = container.resolve(CreateHandler) as any;
        const op = { kind: cfg.operationKinds.createEntityPort, entityType: 'Counter', portDirection: 'input', portName: 'clk', portType: 'std_logic' };
        expect(handler.createCommand(op)).toBeDefined();
        expect((containerFor(cfg, 'file:///hdl/top.py').resolve(CreateHandler) as any).createCommand(op)).toBeUndefined();
    });
});

describe('the profile carries its source extensions to the server', () => {
    const input = {
        key: 'sv',
        displayName: 'SystemVerilog',
        settingsNamespace: 'sv',
        customEditorViewType: 'sv.diagram',
        glspClientId: 'sv.client',
        glspClientName: 'sv',
        commands: {} as SidecarProfileInput['commands'],
        operationKinds: { createEntityPort: 'sv.createEntityPort', deleteEntityPort: 'sv.deleteEntityPort' },
        sidecarOperationPrefix: 'sv',
        sidecarCommandSettingKey: 'sidecarCommand',
        sidecarCommandDefault: 'hdl-sidecar',
        cliCommandSettingKey: 'cliCommand',
        cliCommandDefault: 'hdl',
        acceptedOperationPrefixes: ['sv'],
        graphAcquisition: 'cli-plan',
        undoLabelSuffix: ' (sv)',
        sourceExtension: '.sv',
        sourceExtensions: ['.sv', '.v'],
        chat: { name: 'sv', fullName: 'SystemVerilog', skill: 'sv' },
        ...NEUTRAL_CREATE_NODE_CONFIG
    } as unknown as SidecarProfileInput;

    it('so the invoker the handlers inject answers for the product, not for Python', () => {
        const profile = createSidecarDiagramProfile(input);
        const container = new Container();
        for (const module of profile.serverModules ?? []) {
            container.load(module);
        }
        const invoker = container.get(SidecarInvoker);
        expect(invoker.handlesSource('file:///hdl/top.v')).toBe(true);
        expect(invoker.handlesSource('file:///hdl/top.py')).toBe(false);
    });
});
