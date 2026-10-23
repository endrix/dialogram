/**
 * Step 1 of the headless renderer: a graph document in, a laid-out GModel
 * schema out.
 *
 * The pipeline the diagram server runs on open: `GraphGModelSource.transform`
 * (with the product's node families), `convertToGModelRoot`, then the
 * `WorkflowElkLayoutEngine` with the `WorkflowLayoutConfigurator`, under one of
 * the layouts the editor offers (Default, Untangled, Free Ports) plus any ELK
 * options asked for. Nothing is re-implemented, so the geometry is the
 * editor's. Bundled and run by `render.mjs`; the configuration arrives as a
 * JSON file:
 *
 *   { "doc": "<graph document path>", "out": "<schema path>",
 *     "families": [NodeFamilySpec...], "layout": "default|untangled|free-ports",
 *     "elk": { "<option>": "<value>" } }
 */
import 'reflect-metadata';
import { readFileSync, writeFileSync } from 'node:fs';
import ELK from 'elkjs/lib/elk.bundled.js';
import { DefaultElementFilter } from '@eclipse-glsp/layout-elk';
import { GraphGModelSource } from '@dialogram/diagram-server/model/graph-gmodel-source';
import { convertToGModelRoot } from '@dialogram/diagram-server/server/gmodel-convert';
import { PORT_ORDER_FREE, PORT_ORDER_OPTION, WorkflowElkLayoutEngine } from '@dialogram/diagram-server/server/elk-layout-engine';
import { WorkflowLayoutConfigurator } from '@dialogram/diagram-server/server/layout-configurator';
import { UNTANGLED_ELK_OPTIONS } from '@dialogram/diagram-server/operations/layout-tuned-handler';

interface Config {
    doc: string;
    out: string;
    families?: unknown[];
    layout?: 'default' | 'untangled' | 'free-ports';
    elk?: Record<string, string>;
}

/** The graph options of each layout the editor's Layout menu offers. */
const LAYOUTS: Record<string, Record<string, string>> = {
    default: {},
    untangled: { ...UNTANGLED_ELK_OPTIONS },
    'free-ports': { ...UNTANGLED_ELK_OPTIONS, [PORT_ORDER_OPTION]: PORT_ORDER_FREE }
};

function index(element: any, map = new Map<string, any>()): Map<string, any> {
    map.set(element.id, element);
    for (const child of element.children ?? []) {
        index(child, map);
    }
    return map;
}

/** The element as plain data, the way GLSP's serializer writes a model for the client. */
function createSchema(element: any): any {
    const schema: Record<string, unknown> = {};
    for (const key of Object.keys(element)) {
        if (key === 'parent' || key === 'children' || typeof element[key] === 'function') {
            continue;
        }
        schema[key] = element[key];
    }
    schema.children = (element.children ?? []).map(createSchema);
    return schema;
}

async function main(): Promise<void> {
    const config = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Config;
    const doc = JSON.parse(readFileSync(config.doc, 'utf8'));
    const started = Date.now();
    const transformed = new GraphGModelSource({ nodeFamilies: config.families ?? [] } as any).transform(doc);
    const root: any = convertToGModelRoot(transformed as any);
    const layout = LAYOUTS[config.layout ?? 'default'];
    if (!layout) {
        throw new Error(`unknown layout '${config.layout}' (default, untangled, free-ports)`);
    }
    root.layoutOptions = { ...(root.layoutOptions ?? {}), ...layout, ...(config.elk ?? {}) };
    const byId = index(root);
    const modelState: any = { root, index: { get: (id: string) => byId.get(id), findByClass: (id: string) => byId.get(id) } };
    await new WorkflowElkLayoutEngine(
        () => new (ELK as any)({ algorithms: ['layered'] }),
        new DefaultElementFilter(),
        new WorkflowLayoutConfigurator(),
        modelState
    ).layout();
    writeFileSync(config.out, JSON.stringify(createSchema(root)));
    const nodes = [...byId.values()].filter(e => typeof e.type === 'string' && e.type.startsWith('node')).length;
    const edges = [...byId.values()].filter(e => typeof e.type === 'string' && e.type.startsWith('edge')).length;
    console.log(`${nodes} nodes, ${edges} edges, laid out (${config.layout ?? 'default'}) in ${Date.now() - started} ms`);
}

main().catch(error => {
    console.error(error?.stack ?? error);
    process.exit(1);
});
