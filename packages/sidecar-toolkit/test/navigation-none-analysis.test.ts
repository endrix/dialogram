/**
 * A runtime that resolves navigation itself gets no Python caller scan.
 *
 * `discoverCrossFileWorkflowCallers` walks the workspace's `.py` files for
 * callers of a workflow; for a product whose "used by" comes from its own
 * hierarchy export, that walk finds nothing and costs a directory scan on
 * every load. `navigation: 'none'` on the runtime config answers empty instead.
 */
import { describe, expect, it } from 'vitest';
import { SidecarModelSource } from '../src/server/sidecar-model-source';
import type { SidecarRuntimeConfig } from '../src/server/sidecar-runtime-config';

const BASE: SidecarRuntimeConfig = {
    settingsNamespace: 'p',
    sidecarOperationPrefix: 'p',
    sidecarCommandSettingKey: 'sidecarCommand',
    sidecarCommandDefault: 'p-sidecar',
    cliCommandSettingKey: 'cliCommand',
    cliCommandDefault: 'p',
    operationKinds: { createEntityPort: 'p.createEntityPort', deleteEntityPort: 'p.deleteEntityPort' },
    acceptedOperationPrefixes: ['p'],
    graphAcquisition: 'sidecar-export',
    undoLabelSuffix: ' (p)',
    createNodeStrings: {
        newTypeNamePrompt: () => '', typeLabel: () => '', classNamePlaceholder: () => '',
        sidecarDisplayName: '', invalidCapabilitiesResponse: '', missingCapabilities: () => '', invalidListResponse: () => ''
    },
    createNodeBehavior: { capabilityProbeBeforeCreate: false, mergeProjectDiscoveredTypes: false, surfaceSidecarListErrors: false }
};

describe('navigation: none', () => {
    it('answers the caller scan and the source walk with nothing', async () => {
        const source = new SidecarModelSource({ ...BASE, navigation: 'none' });
        await expect(source.analysis.discoverCrossFileWorkflowCallers('/x/a.sv', 'top', ['/x/b.py'])).resolves.toEqual([]);
        await expect(source.analysis.collectSourceFilesUnderRoots(['/x'], '/x/a.sv')).resolves.toEqual([]);
    });

    it('leaves the Python scan in place by default', () => {
        const source = new SidecarModelSource(BASE);
        expect(source.analysis.discoverCrossFileWorkflowCallers.name).toBe('discoverCrossFileWorkflowCallers');
    });
});
