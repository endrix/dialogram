import { describe, expect, it } from 'vitest';

import {
    SidecarRuntimeService,
    type SidecarRuntimeConfig
} from '../src/server/sidecar-runtime-config.js';
import { SidecarInvoker } from '../src/server/operations/sidecar-invoker.js';

/**
 * Routing contract for the product-neutral create-node vocabulary/behavior added in SP2c-3.
 * The toolkit carries NO product strings/branches; the consuming extension supplies them as
 * config. These tests prove the config values flow through {@link SidecarRuntimeService} and
 * {@link SidecarInvoker} unchanged, for both a wfpy-shaped and a calpy-shaped config.
 */
function baseConfig(overrides: Partial<SidecarRuntimeConfig>): SidecarRuntimeConfig {
    return {
        settingsNamespace: 'wfLang',
        sidecarOperationPrefix: 'sc',
        sidecarCommandSettingKey: 'sidecarCommand',
        sidecarCommandDefault: 'sc-sidecar',
        cliCommandSettingKey: 'cliCommand',
        cliCommandDefault: 'sc',
        operationKinds: { createEntityPort: 'sc.createEntityPort', deleteEntityPort: 'sc.deleteEntityPort' },
        acceptedOperationPrefixes: ['sc'],
        graphAcquisition: 'cli-plan',
        undoLabelSuffix: ' (suffix-from-config)',
        createNodeStrings: {
            newTypeNamePrompt: kind => `prompt:${kind}`,
            typeLabel: kind => `label:${kind}`,
            classNamePlaceholder: kind => `placeholder:${kind}`,
            sidecarDisplayName: 'Display Name From Config',
            invalidCapabilitiesResponse: 'invalid-capabilities-from-config',
            missingCapabilities: ops => `missing:${ops.join(',')}`,
            invalidListResponse: (action, field) => `invalid-list:${action}:${field}`
        },
        createNodeBehavior: {
            capabilityProbeBeforeCreate: false,
            mergeProjectDiscoveredTypes: true,
            surfaceSidecarListErrors: false
        },
        ...overrides
    };
}

function invokerFor(config: SidecarRuntimeConfig): SidecarInvoker {
    return new SidecarInvoker(new SidecarRuntimeService(config));
}

describe('sidecar runtime strings/behavior routing', () => {
    it('routes the undo-label suffix from config', () => {
        const invoker = invokerFor(baseConfig({ undoLabelSuffix: ' (wfpy)' }));
        expect(invoker.undoLabelSuffix()).toBe(' (wfpy)');
    });

    it('routes create-node vocabulary from config (wfpy-shaped)', () => {
        const invoker = invokerFor(baseConfig({
            createNodeStrings: {
                newTypeNamePrompt: () => 'New class name',
                typeLabel: kind => (kind === 'workflow' ? 'workflow' : 'task'),
                classNamePlaceholder: kind => (kind === 'workflow' ? 'MyWorkflow' : 'MyTask'),
                sidecarDisplayName: 'Workflow sidecar',
                invalidCapabilitiesResponse: 'nope',
                missingCapabilities: ops => `Missing: ${ops.join(', ')}`,
                invalidListResponse: (action, field) => `bad ${action} ${field}`
            }
        }));
        const strings = invoker.createNodeStrings();
        expect(strings.typeLabel('workflow')).toBe('workflow');
        expect(strings.classNamePlaceholder('task')).toBe('MyTask');
        expect(strings.sidecarDisplayName).toBe('Workflow sidecar');
    });

    it('routes create-node vocabulary + behavior from config (calpy-shaped)', () => {
        const invoker = invokerFor(baseConfig({
            settingsNamespace: 'calLang',
            sidecarOperationPrefix: 'calpy',
            acceptedOperationPrefixes: ['calpy'],
            createNodeStrings: {
                newTypeNamePrompt: kind => (kind === 'workflow' ? 'New network name' : 'New class name'),
                typeLabel: kind => (kind === 'workflow' ? 'network' : 'actor'),
                classNamePlaceholder: kind => (kind === 'workflow' ? 'MyNetwork' : 'MyActor'),
                sidecarDisplayName: 'CalPy sidecar',
                invalidCapabilitiesResponse: 'CalPy sidecar returned an invalid capabilities response while preparing node creation.',
                missingCapabilities: ops => `CalPy node creation is not available yet. Missing sidecar operations: ${ops.join(', ')}`,
                invalidListResponse: (action, field) => `CalPy sidecar returned an invalid response while trying to ${action}. Missing diagnostic.${field}.`
            },
            createNodeBehavior: {
                capabilityProbeBeforeCreate: true,
                mergeProjectDiscoveredTypes: false,
                surfaceSidecarListErrors: true
            }
        }));
        const strings = invoker.createNodeStrings();
        expect(strings.newTypeNamePrompt('workflow')).toBe('New network name');
        expect(strings.typeLabel('task')).toBe('actor');
        expect(invoker.createNodeBehavior()).toEqual({
            capabilityProbeBeforeCreate: true,
            mergeProjectDiscoveredTypes: false,
            surfaceSidecarListErrors: true
        });
    });
});
