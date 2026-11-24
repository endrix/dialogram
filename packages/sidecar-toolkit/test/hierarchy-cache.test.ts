/**
 * One export of a workflow hierarchy per root, and every view read from it.
 *
 * Navigating a hierarchy in one editor asked the runtime for each view on its
 * own: a process per drill-down, each nested workflow elaborated standalone.
 * With a runtime that exports the whole hierarchy, the root is exported once
 * and kept while every file it came from is unchanged.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { URI } from 'vscode-uri';
import { HierarchyCache, fileHash, findInstance, graphsOf, outlineOf, type HierarchyEntry } from '../src/server/hierarchy-cache';
import { hierarchyRootAt } from '@dialogram/shared';
import { CliGraphModelSource } from '../src/server/cli-graph-model-source';

const graph = (label: string) => ({ version: '1', graph: { id: `wf:${label}`, nodes: [{ id: label, label }], edges: [] } });

function tree(top: string, block: string): HierarchyEntry {
    return {
        path: [], workflowName: 'top', sourcePath: top, nodeCount: 2,
        children: [
            {
                path: ['b1'], workflowName: 'block', sourcePath: block, nodeId: 'node:root:b1', nodeCount: 1,
                graph: graph('b1-view'),
                children: [{ path: ['b1', 'leaf'], workflowName: 'leaf', sourcePath: block, graph: graph('leaf-view'), children: [] }]
            },
            { path: ['b2'], workflowName: 'block', sourcePath: block, error: 'ValueError: no', children: [] }
        ]
    };
}

describe('the hierarchy tree', () => {
    const root = tree('/w/top.py', '/w/block.py');

    it('finds an instance by its path of instance names', () => {
        expect(findInstance(root, ['b1', 'leaf'])?.workflowName).toBe('leaf');
        expect(findInstance(root, [])).toBe(root);
        expect(findInstance(root, ['b9'])).toBeUndefined();
    });

    it('outlines it without its graphs, files as URIs', () => {
        const outline = outlineOf(root);
        expect(JSON.stringify(outline)).not.toContain('b1-view');
        expect(outline.children[0]).toMatchObject({ path: ['b1'], nodeId: 'node:root:b1', sourceUri: URI.file('/w/block.py').toString() });
        expect(outline.children[1].error).toBe('ValueError: no');
    });

    it('gives every instance\'s graph, root first, the export\'s own documents, once per export', () => {
        const exported = { ...graph('top-view'), hierarchy: tree('/w/top.py', '/w/block.py') };
        const graphs = graphsOf(exported);
        // b2 did not elaborate: it has no graph to give.
        expect(graphs.map(g => g.path)).toEqual([[], ['b1'], ['b1', 'leaf']]);
        expect((graphs[0].document.graph as any).id).toBe('wf:top-view');
        expect(graphs[0].document).not.toHaveProperty('hierarchy');
        expect(graphs[1]).toMatchObject({ workflowName: 'block', sourceUri: URI.file('/w/block.py').toString() });
        expect(graphs[1].document).toBe(exported.hierarchy.children[0].graph);
        expect(graphsOf(exported)).toBe(graphs);
    });
});

describe('the cache', () => {
    function cacheWith(hashes: Record<string, string>) {
        let runs = 0;
        const cache = new HierarchyCache(
            async () => {
                runs += 1;
                return JSON.stringify({ ...graph('top-view'), hierarchy: tree('/w/top.py', '/w/block.py') });
            },
            async file => hashes[file]
        );
        return { cache, runs: () => runs };
    }

    it('exports a root once while its files are unchanged', async () => {
        const { cache, runs } = cacheWith({ '/w/top.py': 'a', '/w/block.py': 'b' });

        await cache.get('/w/top.py', 'top', '/w');
        await cache.get('/w/top.py', 'top', '/w');

        expect(runs()).toBe(1);
    });

    it('exports it again when a nested workflow’s file changes', async () => {
        const hashes = { '/w/top.py': 'a', '/w/block.py': 'b' };
        const { cache, runs } = cacheWith(hashes);

        await cache.get('/w/top.py', 'top', '/w');
        hashes['/w/block.py'] = 'b2';
        await cache.get('/w/top.py', 'top', '/w');

        expect(runs()).toBe(2);
    });

    it('exports it again when the file of a class a workflow imports changes', async () => {
        // `Text` is declared in lib/text.py, none of the hierarchy's workflow
        // files: a port added to it has to be drawn too.
        const hashes: Record<string, string> = { '/w/top.py': 'a', '/w/block.py': 'b', '/w/lib/text.py': 't' };
        let runs = 0;
        const cache = new HierarchyCache(async () => {
            runs += 1;
            const doc = graph('top-view');
            (doc.graph.nodes[0] as any).metadata = { referencedSource: { file: '/w/lib/text.py', line: 5 } };
            return JSON.stringify({ ...doc, hierarchy: tree('/w/top.py', '/w/block.py') });
        }, async file => hashes[file]);

        await cache.get('/w/top.py', 'top', '/w');
        await cache.get('/w/top.py', 'top', '/w');
        expect(runs).toBe(1);
        hashes['/w/lib/text.py'] = 't2';
        await cache.get('/w/top.py', 'top', '/w');
        expect(runs).toBe(2);
    });

    it('exports it again from another folder, and runs each export from the folder it is asked for', async () => {
        const folders: string[] = [];
        const cache = new HierarchyCache(
            async (_file, _workflow, cwd) => {
                folders.push(cwd);
                return JSON.stringify({ ...graph('top-view'), hierarchy: tree('/w/top.py', '/w/block.py') });
            },
            async () => 'a'
        );

        await cache.get('/w/top.py', 'top', '/w/flows');
        await cache.get('/w/top.py', 'top', '/w/flows');
        // A workspace folder opened since moved the run root.
        await cache.get('/w/top.py', 'top', '/w');

        expect(folders).toEqual(['/w/flows', '/w']);
    });

    it('exports it again with other variables, and runs each export with the ones it is asked for', async () => {
        const given: Array<Record<string, string>> = [];
        const cache = new HierarchyCache(
            async (_file, _workflow, _cwd, variables) => {
                given.push(variables);
                return JSON.stringify({ ...graph('top-view'), hierarchy: tree('/w/top.py', '/w/block.py') });
            },
            async () => 'a'
        );

        await cache.get('/w/top.py', 'top', '/w', { X_ROOTS: '/a' });
        await cache.get('/w/top.py', 'top', '/w', { X_ROOTS: '/a' });
        // The folder setting changed: another export, not the one kept.
        await cache.get('/w/top.py', 'top', '/w', { X_ROOTS: '/b' });
        await cache.get('/w/top.py', 'top', '/w');

        expect(given).toEqual([{ X_ROOTS: '/a' }, { X_ROOTS: '/b' }, {}]);
    });

    it('returns nothing for an export that failed or is not one', async () => {
        expect(await new HierarchyCache(async () => undefined).get('/w/top.py', 'top', '/w')).toBeUndefined();
        expect(await new HierarchyCache(async () => '{"graph": {}}').get('/w/top.py', 'top', '/w')).toBeUndefined();
    });
});

describe('the hash of a large file', () => {
    // A process that may read any file cannot make one unreadable.
    it.skipIf(process.getuid?.() === 0)('is not remembered as missing after one read that failed', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-hash-'));
        try {
            // Large enough for its hash to be kept while it stays as it was (file-memo.ts).
            const file = path.join(dir, 'netlist.v');
            await fs.writeFile(file, 'a'.repeat(1024 * 1024));
            await fs.chmod(file, 0o000);
            expect(await fileHash(file)).toBeUndefined();
            // Readable again, its size, time and inode as they were: it is hashed, and the hash then kept.
            await fs.chmod(file, 0o644);
            const hash = await fileHash(file);
            expect(hash).toMatch(/^[0-9a-f]{64}$/);
            expect(await fileHash(file)).toBe(hash);
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
});

describe('a view read from the hierarchy', () => {
    async function source() {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hierarchy-view-'));
        const top = path.join(dir, 'top.py');
        const block = path.join(dir, 'block.py');
        await fs.writeFile(top, '@workflow\ndef top():\n    pass\n');
        await fs.writeFile(block, '@workflow\ndef block():\n    pass\n');
        let exports = 0;
        const fallback: any = {
            analysis: { pickDefaultWorkflowName: () => 'top' },
            attachDiagnostics: (doc: unknown) => doc
        };
        const cfg: any = {
            cliCommandDefault: 'runtime',
            cliGraphArgs: () => ['plan'],
            cliHierarchyArgs: (file: string, wf: string) => ['plan', file, '--workflow', wf, '--hierarchy']
        };
        const src: any = new CliGraphModelSource(cfg, fallback);
        src.exportHierarchy = async () => {
            exports += 1;
            return JSON.stringify({ ...graph('top-view'), hierarchy: tree(top, block) });
        };
        const trail = (...crumbs: object[]) => JSON.stringify(crumbs);
        return { src, top, block, trail, exports: () => exports };
    }

    it('serves the root and a nested view from one export, with the outline', async () => {
        const { src, top, block, trail, exports } = await source();
        const topUri = URI.file(top).toString();
        const blockUri = URI.file(block).toString();

        const rootDoc = await src.getGraph(topUri, { requestOptions: { networkName: 'top' } });
        const nestedDoc = await src.getGraph(blockUri, {
            requestOptions: {
                networkName: 'block',
                'wf:navTrail': trail(
                    { sourceUri: topUri, workflowName: 'top' },
                    { sourceUri: blockUri, workflowName: 'block', workflowInstanceName: 'b1' }
                )
            }
        });

        expect(rootDoc.graph.id).toBe('wf:top-view');
        expect(rootDoc.hierarchy.children.map((c: any) => c.path)).toEqual([['b1'], ['b2']]);
        expect(nestedDoc.graph.id).toBe('wf:b1-view');
        expect(nestedDoc.hierarchy.workflowName).toBe('top');
        // Both views carry the hierarchy's graphs, for a list of nodes across it.
        expect(rootDoc.hierarchyGraphs.map((g: any) => g.path)).toEqual([[], ['b1'], ['b1', 'leaf']]);
        expect(nestedDoc.hierarchyGraphs).toBe(rootDoc.hierarchyGraphs);
        expect(exports()).toBe(1);
    });

    it('plans again, with no hierarchy, when the file of a class a workflow imports changes', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-cache-'));
        const top = path.join(dir, 'top.py');
        const text = path.join(dir, 'text.py');
        const runs = path.join(dir, 'runs');
        await fs.writeFile(top, '@workflow\ndef top():\n    t = Text()\n');
        await fs.writeFile(text, 'class Text:\n    pass\n');
        const plan = path.join(dir, 'plan.cjs');
        const doc = { version: '1', graph: { id: 'wf:top', nodes: [{ id: 't', label: 't', metadata: { referencedSource: { file: text, line: 1 } } }], edges: [] } };
        await fs.writeFile(plan, `require('fs').appendFileSync(${JSON.stringify(runs)}, 'x'); process.stdout.write(${JSON.stringify(JSON.stringify(doc))});`);
        const fallback: any = { analysis: { pickDefaultWorkflowName: () => 'top' }, attachDiagnostics: (d: unknown) => d };
        const src: any = new CliGraphModelSource({ cliCommandDefault: 'runtime', cliGraphArgs: () => [] } as any, fallback);
        src.getCliInvocation = () => ({ cmd: process.execPath, argsPrefix: [plan] });
        const planned = async () => (await fs.readFile(runs, 'utf8')).length;
        const topUri = URI.file(top).toString();

        await src.getGraph(topUri, { requestOptions: { networkName: 'top' } });
        await src.getGraph(topUri, { requestOptions: { networkName: 'top' } });
        expect(await planned()).toBe(1);
        await fs.writeFile(text, 'class Text:\n    Extra = Port[str](direction="in")\n');
        await src.getGraph(topUri, { requestOptions: { networkName: 'top' } });
        expect(await planned()).toBe(2);
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('leaves an instance that did not elaborate to a plan of its own', async () => {
        const { src, top, block, trail } = await source();
        const viewFromHierarchy = src.viewFromHierarchy.bind(src);

        const doc = await viewFromHierarchy(URI.file(block).toString(), block, 'block', {
            'wf:navTrail': trail(
                { sourceUri: URI.file(top).toString(), workflowName: 'top' },
                { sourceUri: URI.file(block).toString(), workflowName: 'block', workflowInstanceName: 'b2' }
            )
        }, path.dirname(block));

        expect(doc).toBeUndefined();
    });

    it('leaves unsaved text being previewed to a plan of its own', async () => {
        const { src, top } = await source();
        const doc = await src.viewFromHierarchy(URI.file(top).toString(), top, 'top', { content: 'unsaved' }, path.dirname(top));
        expect(doc).toBeUndefined();
    });
});

/**
 * A unit answered by a past run (`c = inst(instance="wf-out/r1")`) runs
 * nothing with its parent, so the parent's export has nothing under it. A
 * workflow made by a factory inside it (`f = flow(design="d")()`) planned on
 * its own has no `design`; elaborated as the run did, from `inst` as a root,
 * it has.
 */
describe('a view under a unit answered by a past run', () => {
    async function source() {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recorded-hierarchy-'));
        const files = { top: path.join(dir, 'top.py'), inst: path.join(dir, 'inst.py'), flow: path.join(dir, 'flow.py') };
        for (const [name, file] of Object.entries(files)) {
            await fs.writeFile(file, `@workflow\ndef ${name}():\n    pass\n`);
        }
        const exported: Record<string, HierarchyEntry> = {
            top: { path: [], workflowName: 'top', sourcePath: files.top, children: [] },
            inst: {
                path: [], workflowName: 'inst', sourcePath: files.inst,
                children: [{ path: ['f'], workflowName: 'flow', sourcePath: files.flow, graph: graph('f-view'), children: [] }]
            }
        };
        const asked: string[] = [];
        const fallback: any = { analysis: { pickDefaultWorkflowName: () => 'top' }, attachDiagnostics: (doc: unknown) => doc };
        const cfg: any = {
            cliCommandDefault: 'runtime',
            cliGraphArgs: () => ['plan'],
            cliHierarchyArgs: (file: string, wf: string) => ['plan', file, '--workflow', wf, '--hierarchy']
        };
        const src: any = new CliGraphModelSource(cfg, fallback);
        src.exportHierarchy = async (_file: string, workflow: string) => {
            asked.push(workflow);
            return exported[workflow] ? JSON.stringify({ ...graph(`${workflow}-view`), hierarchy: exported[workflow] }) : undefined;
        };
        const uri = (file: string) => URI.file(file).toString();
        const toInst = [
            { sourceUri: uri(files.top), workflowName: 'top' },
            { sourceUri: uri(files.inst), workflowName: 'inst', workflowInstanceName: 'c', recordedRun: 'wf-out/r1' }
        ];
        const toFlow = [...toInst, { sourceUri: uri(files.flow), workflowName: 'flow', workflowInstanceName: 'f' }];
        return { src, files, uri, toInst, toFlow, asked };
    }

    it('reads the unit and the views under it from the hierarchy rooted at the unit', async () => {
        const { src, files, uri, toInst, toFlow, asked } = await source();

        const instDoc = await src.getGraph(uri(files.inst), { requestOptions: { networkName: 'inst', 'wf:navTrail': JSON.stringify(toInst) } });
        const flowDoc = await src.getGraph(uri(files.flow), { requestOptions: { networkName: 'flow', 'wf:navTrail': JSON.stringify(toFlow) } });

        expect(instDoc.graph.id).toBe('wf:inst-view');
        expect(flowDoc.graph.id).toBe('wf:f-view');
        expect([...asked].sort()).toEqual(['inst', 'top']);
    });

    it('keeps the outline and the node lists of the trail root, whose paths the trail has', async () => {
        const { src, files, uri, toFlow } = await source();

        const flowDoc = await src.getGraph(uri(files.flow), { requestOptions: { networkName: 'flow', 'wf:navTrail': JSON.stringify(toFlow) } });

        expect(flowDoc.hierarchy.workflowName).toBe('top');
        expect(flowDoc.hierarchyGraphs.map((g: any) => g.path)).toEqual([[]]);
    });

    it('reads a view through a unit with no past run from the trail root, as before', async () => {
        const { src, files, uri, toFlow, asked } = await source();
        const { recordedRun: _run, ...live } = toFlow[1] as { recordedRun?: string };

        const flowDoc = await src.viewFromHierarchy(uri(files.flow), files.flow, 'flow', {
            'wf:navTrail': JSON.stringify([toFlow[0], live, toFlow[2]])
        }, path.dirname(files.flow));

        // The trail root's export has nothing under `c`: a plan of its own.
        expect(flowDoc).toBeUndefined();
        expect(asked).toEqual(['top']);
    });

    it('takes the deepest unit answered by a past run, and none on the root crumb', () => {
        expect(hierarchyRootAt([{}, { recordedRun: 'a' }, {}, { recordedRun: ' b ' }, {}])).toBe(3);
        expect(hierarchyRootAt([{ recordedRun: 'a' }, {}, { recordedRun: '  ' }])).toBe(0);
        expect(hierarchyRootAt([])).toBe(0);
    });
});
