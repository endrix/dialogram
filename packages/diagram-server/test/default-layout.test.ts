/**
 * A product's default layout.
 *
 * Layout Diagram, and the layout a diagram gets when it first opens, run with
 * the graph's own options. A product that prefers Untangled or Free Ports says
 * so once (`StorageRuntimeOptions.defaultLayout`), and every diagram it loads
 * carries that layout's options. The two menu layouts still name what they
 * do: each says the port order, so Untangled on a graph that defaults to Free
 * Ports keeps the declared order.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { URI } from 'vscode-uri';
import { PORT_ORDER_DECLARED, PORT_ORDER_FREE, PORT_ORDER_OPTION } from '../src/server/elk-layout-engine';
import {
    UNTANGLED_ELK_OPTIONS,
    WorkflowLayoutFreePortsOperationHandler,
    WorkflowLayoutUntangledOperationHandler,
    tunedLayoutOptions
} from '../src/operations/layout-tuned-handler';
import { WorkflowSourceModelStorage } from '../src/server/source-model-storage';
import type { DefaultLayout } from '../src/server/storage-runtime-options';

/** Load a one-node graph through the storage and return the root it hands the model state. */
async function loadedRoot(defaultLayout?: DefaultLayout): Promise<any> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'default-layout-'));
    const file = path.join(dir, 'flow.py');
    await fs.writeFile(file, '# flow\n');
    const uri = URI.file(file).toString();
    const state = new Map<string, unknown>();
    let root: any;

    const storage: any = new (WorkflowSourceModelStorage as any)();
    storage.storageOptions = { settingsNamespace: 'wf', operationPrefix: 'wf', defaultLayout };
    storage.ensureModelSource = () => undefined;
    storage.modelState = {
        set: (k: string, v: unknown) => state.set(k, v),
        get: (k: string) => state.get(k),
        updateRoot: (r: unknown) => { root = r; }
    };
    storage.layoutPersistence = { loadLayout: async () => undefined, loadEdgeRoutes: async () => undefined };

    const doc = {
        version: '1',
        graph: {
            id: 'wf:flow',
            nodes: [{ id: 'node:a', kind: 'task', label: 'a', scope: 'root', ports: [] }],
            edges: []
        }
    };
    try {
        await storage.finishLoadFromDoc(doc, uri, file, { sourceUri: uri, networkName: 'flow' }, undefined);
    } catch {
        // Past the root the load needs a live session; the root is what this tests.
    }
    await fs.rm(dir, { recursive: true, force: true });
    return root;
}

describe('the tuned layouts', () => {
    it('both say the port order', () => {
        expect(tunedLayoutOptions('free-ports')).toEqual({ ...UNTANGLED_ELK_OPTIONS, [PORT_ORDER_OPTION]: PORT_ORDER_FREE });
        expect(tunedLayoutOptions('untangled')).toEqual({ ...UNTANGLED_ELK_OPTIONS, [PORT_ORDER_OPTION]: PORT_ORDER_DECLARED });
    });

    it('are each themselves on a graph that defaults to the other', () => {
        // A tuned layout runs with its options over the graph's (see the handler).
        const untangled = (new WorkflowLayoutUntangledOperationHandler() as any).graphOptions();
        const freePorts = (new WorkflowLayoutFreePortsOperationHandler() as any).graphOptions();

        expect({ ...tunedLayoutOptions('free-ports'), ...untangled }[PORT_ORDER_OPTION]).toBe(PORT_ORDER_DECLARED);
        expect({ ...tunedLayoutOptions('untangled'), ...freePorts }[PORT_ORDER_OPTION]).toBe(PORT_ORDER_FREE);
    });
});

describe('a loaded diagram', () => {
    it('carries the product’s default layout as graph options', async () => {
        const root = await loadedRoot('free-ports');

        expect(root, 'the load never reached the model state').toBeDefined();
        expect(root.layoutOptions).toMatchObject(tunedLayoutOptions('free-ports'));
    });

    it('carries none of them when the product names no default', async () => {
        const root = await loadedRoot(undefined);

        expect(root).toBeDefined();
        expect(root.layoutOptions?.[PORT_ORDER_OPTION]).toBeUndefined();
        expect(root.layoutOptions?.['elk.layered.nodePlacement.strategy']).toBeUndefined();
    });
});
