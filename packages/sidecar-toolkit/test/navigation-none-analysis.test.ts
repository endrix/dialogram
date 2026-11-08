/**
 * Only a Python runtime gets the Python caller scan.
 *
 * `discoverCrossFileWorkflowCallers` walks the workspace's `.py` files for
 * callers of a workflow; for a product whose "used by" comes from its own
 * hierarchy export, that walk finds nothing and costs a directory scan on
 * every load. Unless the runtime config names `navigation: 'python'`, both
 * workspace walks answer empty.
 */
import { describe, expect, it } from 'vitest';
import { SidecarModelSource } from '../src/server/sidecar-model-source';
import { collectPythonFilesUnderRoots, discoverCrossFileWorkflowCallers } from '../src/server/source-analysis';
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

    it('answers empty by default too: the Python scan is for a product that names it', async () => {
        const source = new SidecarModelSource(BASE);
        await expect(source.analysis.discoverCrossFileWorkflowCallers('/x/a.py', 'top', ['/x/b.py'])).resolves.toEqual([]);
    });

    it('runs the Python scan and walk when the product names it', () => {
        const source = new SidecarModelSource({ ...BASE, navigation: 'python' });
        expect(source.analysis.discoverCrossFileWorkflowCallers).toBe(discoverCrossFileWorkflowCallers);
        expect(source.analysis.collectSourceFilesUnderRoots).toBe(collectPythonFilesUnderRoots);
    });
});
