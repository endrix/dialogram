import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GEdge, GGraph, GNode } from '@eclipse-glsp/server';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { WorkflowSourceModelStorage } from '@dialogram/diagram-server/server/diagram-glsp-module';
import {
    analyzeWorkflowRelationships,
    discoverCrossFileWorkflowCallers,
    buildViewerOverlayAstPathCandidates,
    buildViewerOverlayNodeIdentityCandidates,
    buildViewerOverlaySignatureCandidates,
    resolveWorkflowDefinitionRange,
    resolveViewerOverlayActiveEntityName
} from '../src/server/source-analysis';
import { SidecarModelSource, type SidecarRuntimeConfig } from '../src/index';
import { NEUTRAL_CREATE_NODE_CONFIG } from './fixtures/create-node-config';

/** Minimal runtime config for constructing a toolkit SidecarModelSource in these tests. */
function testCfg(overrides: Partial<SidecarRuntimeConfig> = {}): SidecarRuntimeConfig {
    return {
        settingsNamespace: 'wfLang',
        sidecarOperationPrefix: 'wfpy',
        sidecarCommandSettingKey: 'wfpySidecarCommand',
        sidecarCommandDefault: 'wfpy-sidecar',
        cliCommandSettingKey: 'wfpyCommand',
        cliCommandDefault: 'wfpy',
        cliPythonModule: undefined,
        operationKinds: { createEntityPort: 'op.createEntityPort', deleteEntityPort: 'op.deleteEntityPort' },
        acceptedOperationPrefixes: ['wfpy', 'calpy'],
        graphAcquisition: 'cli-plan',
        cliGraphArgs: (file: string) => ['plan', file, '--format', 'graph', '--best-effort'],
        ...NEUTRAL_CREATE_NODE_CONFIG,
        ...overrides
    };
}

const tempDirs: string[] = [];

async function mkTempDir(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

async function writeFile(filePath: string, content = ''): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
}


afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

describe('cross-file nested navigation and overlay matching', () => {
    it('derives entry workflows and same-file parent workflows from workflow definitions', () => {
        const relationships = analyzeWorkflowRelationships(`
from wfpy.core import workflow

@workflow()
def main():
    child()
    helper = "child() should not count inside strings"

@workflow()
def child():
    leaf()

@workflow()
def sibling():
    child()
    # leaf()

@workflow()
def leaf():
    return None
`);

        expect(relationships.workflowNames).toEqual(['main', 'child', 'sibling', 'leaf']);
        expect(relationships.entryWorkflowNames).toEqual(['main', 'sibling']);
        expect(relationships.callersByWorkflow.child).toEqual(['main', 'sibling']);
        expect(relationships.callersByWorkflow.leaf).toEqual(['child']);
    });

    it('resolves the selected workflow definition line from source text', () => {
        const sourceText = `from wfpy.core import workflow

@workflow()
def main():
    child()

@workflow()
def child():
    return None
`;

        expect(resolveWorkflowDefinitionRange(sourceText, 'main')).toEqual({
            start: { line: 3, character: 0 },
            end: { line: 3, character: 0 }
        });
        expect(resolveWorkflowDefinitionRange(sourceText, 'child')).toEqual({
            start: { line: 7, character: 0 },
            end: { line: 7, character: 0 }
        });
        expect(resolveWorkflowDefinitionRange(sourceText, 'missing')).toBeUndefined();
    });

    it('discovers cross-file callers through direct and module imports', async () => {
        const root = await mkTempDir('wf-lang-cross-file-callers-');
        const pkgDir = path.join(root, 'pkg');
        const targetFile = path.join(pkgDir, 'child.py');
        const directCallerFile = path.join(pkgDir, 'parent.py');
        const moduleCallerFile = path.join(pkgDir, 'module_parent.py');

        await writeFile(path.join(pkgDir, '__init__.py'), '');
        await writeFile(
            targetFile,
            `from wfpy.core import workflow

@workflow()
def child():
    return None
`
        );
        await writeFile(
            directCallerFile,
            `from wfpy.core import workflow
from .child import child

@workflow()
def main():
    child()
`
        );
        await writeFile(
            moduleCallerFile,
            `from wfpy.core import workflow
from . import child as child_mod

@workflow()
def alt():
    child_mod.child()
`
        );

        const callers = await discoverCrossFileWorkflowCallers(targetFile, 'child', [directCallerFile, moduleCallerFile]);
        expect(callers).toEqual([
            { sourceUri: `file://${directCallerFile}`, workflowName: 'main' },
            { sourceUri: `file://${moduleCallerFile}`, workflowName: 'alt' }
        ]);
    });

    it('discovers callers that import a submodule re-exported from its package (from pkg import child; child())', async () => {
        // Mirrors the real `from src.workflows import turnus_trace_project; turnus_trace_project()`
        // pattern: the file is named after its workflow and re-exported via the package __init__,
        // so it is imported from the *package* and called directly (not module-qualified).
        const root = await mkTempDir('wf-lang-cross-file-reexport-');
        const pkgDir = path.join(root, 'pkg');
        const targetFile = path.join(pkgDir, 'child.py');
        const reexportCallerFile = path.join(pkgDir, 'reexport_parent.py');

        await writeFile(path.join(pkgDir, '__init__.py'), 'from .child import child\n');
        await writeFile(
            targetFile,
            `from wfpy.core import workflow

@workflow()
def child():
    return None
`
        );
        await writeFile(
            reexportCallerFile,
            `from wfpy.core import workflow
from pkg import child

@workflow()
def main():
    child()
`
        );

        const callers = await discoverCrossFileWorkflowCallers(targetFile, 'child', [reexportCallerFile]);
        expect(callers).toEqual([
            { sourceUri: `file://${reexportCallerFile}`, workflowName: 'main' }
        ]);
    });

    it('loads root-workflow overlay when current nested workflow is in another file', async () => {
        const root = await mkTempDir('wf-lang-cross-file-overlay-');
        const rootFile = path.join(root, 'root.py');
        const nestedFile = path.join(root, 'nested.py');
        const baseOutDir = path.join(root, 'wf-out');
        const runOutDir = path.join(baseOutDir, 'run-1');
        const runLogPath = path.join(baseOutDir, 'run-log.jsonl');
        const overlayPath = path.join(runOutDir, 'run.wf-viewer.json');

        await writeFile(rootFile, '# root workflow stub\n');
        await writeFile(nestedFile, '# nested workflow stub\n');

        await writeFile(
            runLogPath,
            `${JSON.stringify({
                runId: 'run-1',
                workflowName: 'Root',
                sourcePath: rootFile,
                outDir: runOutDir,
                startedAt: '2026-02-18T10:00:00.000Z',
                finishedAt: '2026-02-18T10:00:01.000Z'
            })}\n`
        );

        await writeFile(
            overlayPath,
            JSON.stringify({
                version: 1,
                runId: 'run-1',
                workflowName: 'Root',
                sourcePath: rootFile,
                startedAt: '2026-02-18T10:00:00.000Z',
                finishedAt: '2026-02-18T10:00:01.000Z',
                outDir: runOutDir,
                running: false,
                edges: {
                    '/namespaces@0/workflows@0/structure/connections@0': {
                        queueId: 'q0',
                        outPort: 'Out',
                        inPort: 'In',
                        lastToken: '/tmp/token.txt'
                    }
                }
            })
        );

        const storage = new WorkflowSourceModelStorage() as any;
        storage.injectedModelSource = new SidecarModelSource(testCfg());
        storage.isLiveExecutionGlowEnabled = async () => false;
        storage.resolveRunOutputDir = async () => baseOutDir;

        const noHints = await storage.tryLoadLatestViewerOverlay(nestedFile, 'Root');
        expect(noHints).toBeUndefined();

        const withHints = await storage.tryLoadLatestViewerOverlay(nestedFile, 'Root', [nestedFile, rootFile]);
        expect(withHints).toBeDefined();
        expect(withHints?.runId).toBe('run-1');
        expect(withHints?.edges?.['/namespaces@0/workflows@0/structure/connections@0']?.lastToken).toBe('/tmp/token.txt');
    });

    it('uses the selected workflow definition in the current file for root go-to-source metadata', async () => {
        const root = await mkTempDir('wf-lang-root-source-nav-');
        const workflowFile = path.join(root, 'pipeline.py');
        await writeFile(
            workflowFile,
            `from wfpy.core import workflow

@workflow()
def main():
    child()

@workflow()
def child():
    return None
`
        );

        const storage = new WorkflowSourceModelStorage() as any;
        storage.injectedModelSource = new SidecarModelSource(testCfg());
        storage.storageOptions = { settingsNamespace: 'wfLang', operationPrefix: 'wfpy' };
        let updatedRoot: any;
        storage.modelState = {
            set: () => undefined,
            updateRoot: (rootModel: unknown) => {
                updatedRoot = rootModel;
            }
        };
        storage.layoutPersistence = {
            loadLayout: async () => undefined,
            loadEdgeRoutes: async () => undefined
        };
        storage.applyViewerOverlayToEdges = async () => undefined;
        storage.applyAgentContextToNodes = async () => undefined;
        storage.attachWorkflowRunHistory = async () => undefined;
        storage.applyAgentEnrichment = async () => undefined;
        storage.getWorkflowCallerReferences = async () => [];

        await storage.finishLoadFromDoc(
            {
                version: '1',
                graph: {
                    id: 'wf:main',
                    nodes: [
                        {
                            id: 'node:scope:root:child',
                            kind: 'workflow',
                            label: 'child',
                            scope: 'scope:root',
                            ports: [],
                            meta: {
                                source: {
                                    file: '/Users/endrix/git/streamblocks/wfpy/src/wfpy/core.py',
                                    line: 51
                                }
                            }
                        }
                    ],
                    edges: [],
                    subgraphs: []
                }
            },
            `file://${workflowFile}`,
            workflowFile,
            { networkName: 'main' }
        );

        expect(updatedRoot?.args?.['wf:workflowSourceUri']).toBe(workflowFile);
        expect(updatedRoot?.args?.['wf:workflowSourceRange']).toEqual({
            start: { line: 3, character: 0 },
            end: { line: 3, character: 0 }
        });
    });

    it('loads parent-run overlay for a nested child workflow selected from breadcrumbs', async () => {
        const root = await mkTempDir('wf-lang-nested-workflow-overlay-');
        const workflowFile = path.join(root, 'pipeline.py');
        const baseOutDir = path.join(root, 'wf-out');
        const runOutDir = path.join(baseOutDir, 'run-1');
        const runLogPath = path.join(baseOutDir, 'run-log.jsonl');
        const overlayPath = path.join(runOutDir, 'run.wf-viewer.json');

        await writeFile(workflowFile, '# pipeline workflow stub\n');

        await writeFile(
            runLogPath,
            `${JSON.stringify({
                runId: 'run-1',
                workflowName: 'Main',
                sourcePath: workflowFile,
                outDir: runOutDir,
                startedAt: '2026-04-27T10:00:00.000Z',
                finishedAt: '2026-04-27T10:00:01.000Z'
            })}\n`
        );

        await writeFile(
            overlayPath,
            JSON.stringify({
                version: 1,
                runId: 'run-1',
                workflowName: 'Main',
                sourcePath: workflowFile,
                startedAt: '2026-04-27T10:00:00.000Z',
                finishedAt: '2026-04-27T10:00:01.000Z',
                outDir: runOutDir,
                running: false,
                edges: {
                    [`${workflowFile}::/namespaces@0/workflows@1/structure/connections@0`]: {
                        queueId: 'q0',
                        outPort: 'Out',
                        inPort: 'In',
                        lastToken: '/tmp/loop-cp-token.txt'
                    }
                }
            })
        );

        const storage = new WorkflowSourceModelStorage() as any;
        storage.injectedModelSource = new SidecarModelSource(testCfg());
        storage.isLiveExecutionGlowEnabled = async () => false;
        storage.resolveRunOutputDir = async () => baseOutDir;

        const overlay = await storage.tryLoadLatestViewerOverlay(
            workflowFile,
            'loop_cp',
            [workflowFile],
            ['loop_cp', 'Main']
        );

        expect(overlay).toBeDefined();
        expect(overlay?.runId).toBe('run-1');
        expect(overlay?.edges?.[`${workflowFile}::/namespaces@0/workflows@1/structure/connections@0`]?.lastToken).toBe('/tmp/loop-cp-token.txt');
    });

    it('loads an explicitly selected historical run instead of the latest run', async () => {
        const root = await mkTempDir('wf-lang-run-selector-overlay-');
        const workflowFile = path.join(root, 'pipeline.py');
        const baseOutDir = path.join(root, 'wf-out');
        const run1OutDir = path.join(baseOutDir, 'run-1');
        const run2OutDir = path.join(baseOutDir, 'run-2');
        const runLogPath = path.join(baseOutDir, 'run-log.jsonl');

        await writeFile(workflowFile, '# pipeline workflow stub\n');
        await writeFile(
            runLogPath,
            [
                JSON.stringify({
                    runId: 'run-1',
                    workflowName: 'Main',
                    sourcePath: workflowFile,
                    outDir: run1OutDir,
                    startedAt: '2026-04-27T10:00:00.000Z',
                    finishedAt: '2026-04-27T10:00:01.000Z'
                }),
                JSON.stringify({
                    runId: 'run-2',
                    workflowName: 'Main',
                    sourcePath: workflowFile,
                    outDir: run2OutDir,
                    startedAt: '2026-04-27T11:00:00.000Z',
                    finishedAt: '2026-04-27T11:00:01.000Z'
                })
            ].join('\n') + '\n'
        );

        await writeFile(
            path.join(run1OutDir, 'run.wf-viewer.json'),
            JSON.stringify({
                version: 1,
                runId: 'run-1',
                workflowName: 'Main',
                sourcePath: workflowFile,
                startedAt: '2026-04-27T10:00:00.000Z',
                finishedAt: '2026-04-27T10:00:01.000Z',
                outDir: run1OutDir,
                running: false,
                edges: {
                    edge0: { queueId: 'q0', outPort: 'Out', inPort: 'In', lastToken: 'run-1-token' }
                }
            })
        );
        await writeFile(
            path.join(run2OutDir, 'run.wf-viewer.json'),
            JSON.stringify({
                version: 1,
                runId: 'run-2',
                workflowName: 'Main',
                sourcePath: workflowFile,
                startedAt: '2026-04-27T11:00:00.000Z',
                finishedAt: '2026-04-27T11:00:01.000Z',
                outDir: run2OutDir,
                running: false,
                edges: {
                    edge0: { queueId: 'q0', outPort: 'Out', inPort: 'In', lastToken: 'run-2-token' }
                }
            })
        );

        const storage = new WorkflowSourceModelStorage() as any;
        storage.injectedModelSource = new SidecarModelSource(testCfg());
        storage.isLiveExecutionGlowEnabled = async () => false;
        storage.resolveRunOutputDir = async () => baseOutDir;

        const latestOverlay = await storage.tryLoadLatestViewerOverlay(
            workflowFile,
            'Main',
            [workflowFile],
            ['Main']
        );
        expect(latestOverlay?.runId).toBe('run-2');

        const selectedOverlay = await storage.tryLoadLatestViewerOverlay(
            workflowFile,
            'Main',
            [workflowFile],
            ['Main'],
            'run-1'
        );
        expect(selectedOverlay?.runId).toBe('run-1');
        expect(selectedOverlay?.edges?.edge0?.lastToken).toBe('run-1-token');
    });

    it('discovers parent workflow runs when viewing a nested child workflow via breadcrumbs', async () => {
        const root = await mkTempDir('wf-lang-nested-run-history-');
        const workflowFile = path.join(root, 'pipeline.py');
        const nestedFile = path.join(root, 'src', 'workflows', 'nested.py');
        const baseOutDir = path.join(root, 'wf-out');
        const runOutDir = path.join(baseOutDir, 'run-1');
        const runLogPath = path.join(baseOutDir, 'run-log.jsonl');

        await writeFile(workflowFile, '# pipeline workflow stub\n');
        await writeFile(nestedFile, '# nested workflow stub\n');
        await writeFile(
            runLogPath,
            `${JSON.stringify({
                runId: 'run-1',
                workflowName: 'Main',
                sourcePath: workflowFile,
                outDir: runOutDir,
                startedAt: '2026-04-27T10:00:00.000Z',
                finishedAt: '2026-04-27T10:00:01.000Z'
            })}\n`
        );

        const storage = new WorkflowSourceModelStorage() as any;
        storage.injectedModelSource = new SidecarModelSource(testCfg());
        storage.resolveRunOutputDir = async (filePath: string) => path.join(path.dirname(filePath), 'wf-out');

        const runs = await storage.discoverWorkflowRunHistory(
            nestedFile,
            'loop_cp',
            ['loop_cp', 'Main'],
            [nestedFile, workflowFile]
        );

        expect(runs).toHaveLength(1);
        expect(runs[0]?.runId).toBe('run-1');
        expect(runs[0]?.label).toContain('run-1');
    });

    it('loads parent-run agent context for a nested child workflow selected from breadcrumbs', async () => {
        const root = await mkTempDir('wf-lang-nested-agent-context-');
        const workflowFile = path.join(root, 'pipeline.py');
        const baseOutDir = path.join(root, 'wf-out');
        const runOutDir = path.join(baseOutDir, 'run-1');
        const runLogPath = path.join(baseOutDir, 'run-log.jsonl');
        const agentContextPath = path.join(runOutDir, 'run.wf-agent-context.json');

        await writeFile(workflowFile, '# pipeline workflow stub\n');

        await writeFile(
            runLogPath,
            `${JSON.stringify({
                runId: 'run-1',
                workflowName: 'Main',
                sourcePath: workflowFile,
                outDir: runOutDir,
                startedAt: '2026-04-27T10:00:00.000Z',
                finishedAt: '2026-04-27T10:00:01.000Z'
            })}\n`
        );

        await writeFile(
            agentContextPath,
            JSON.stringify({
                version: 1,
                runId: 'run-1',
                workflowName: 'Main',
                sourcePath: workflowFile,
                agents: [
                    {
                        instanceName: 'optimizer',
                        entityName: 'OptimizeAgent',
                        fireCount: 2,
                        stateful: true,
                        contextBudget: 12,
                        truncationStrategy: 'sliding',
                        chatHistory: [
                            { role: 'user', content: 'optimize this kernel' },
                            { role: 'assistant', content: 'working on it' }
                        ]
                    }
                ]
            })
        );

        const storage = new WorkflowSourceModelStorage() as any;
        storage.injectedModelSource = new SidecarModelSource(testCfg());
        storage.resolveRunOutputDir = async () => baseOutDir;

        const withoutHints = await storage.tryLoadAgentContext(
            workflowFile,
            'kernel_optimizer_io_workflow',
            ['kernel_optimizer_io_workflow'],
            [workflowFile]
        );
        expect(withoutHints).toBeUndefined();

        const withHints = await storage.tryLoadAgentContext(
            workflowFile,
            'kernel_optimizer_io_workflow',
            ['kernel_optimizer_io_workflow', 'Main'],
            [workflowFile]
        );

        expect(withHints).toBeDefined();
        expect(withHints?.agents).toHaveLength(1);
        expect(withHints?.agents[0]?.instanceName).toBe('optimizer');
        expect(withHints?.agents[0]?.chatHistory?.[1]?.content).toBe('working on it');
    });

    it('parses serialized cross-file breadcrumb trail from request args', () => {
        const storage = new WorkflowSourceModelStorage() as any;
        storage.injectedModelSource = new SidecarModelSource(testCfg());

        const trail = storage.parseNavigationTrailArg(JSON.stringify([
            { sourceUri: 'file:///root.py', workflowName: 'Root' },
            { sourceUri: 'file:///nested.py', workflowName: 'Nested', workflowInstanceName: 'optimize' }
        ]));

        expect(trail).toEqual([
            { sourceUri: 'file:///root.py', workflowName: 'Root' },
            { sourceUri: 'file:///nested.py', workflowName: 'Nested', workflowInstanceName: 'optimize' }
        ]);
    });

    it('derives a CalPy graph fallback from a cross-file breadcrumb trail', () => {
        const storage = new WorkflowSourceModelStorage() as any;
        storage.injectedModelSource = new SidecarModelSource(testCfg());

        const fallback = storage.deriveTrailFallback('file:///tmp/layer.py', {
            'wf:navTrail': JSON.stringify([
                { sourceUri: 'file:///tmp/model.py', workflowName: 'qwen35_model' },
                { sourceUri: 'file:///tmp/layer.py', workflowName: 'decoder_layer', workflowInstanceName: 'decoder_block' }
            ])
        });

        expect(fallback).toEqual({
            graphSourceUri: 'file:///tmp/model.py',
            rootWorkflowName: 'qwen35_model',
            instancePath: ['decoder_block']
        });
    });

    it('does not derive a CalPy graph fallback without an instance path', () => {
        const storage = new WorkflowSourceModelStorage() as any;
        storage.injectedModelSource = new SidecarModelSource(testCfg());

        const fallback = storage.deriveTrailFallback('file:///tmp/layer.py', {
            'wf:navTrail': JSON.stringify([
                { sourceUri: 'file:///tmp/model.py', workflowName: 'qwen35_model' },
                { sourceUri: 'file:///tmp/layer.py', workflowName: 'decoder_layer' }
            ])
        });

        expect(fallback).toBeUndefined();
    });

    it('retries CalPy graph load via breadcrumb trail when initial response is partial missing-network graph', async () => {
        const storage = new WorkflowSourceModelStorage() as any;
        storage.injectedModelSource = new SidecarModelSource(testCfg());
        storage.storageOptions = { settingsNamespace: 'calLang', operationPrefix: 'calpy' };

        // The sidecar-attempt + breadcrumb-retry dispatch this test pins now lives in
        // `SidecarCliModelSource#getGraph` (extracted from `WorkflowSourceModelStorage` behind
        // the `DiagramModelSource` seam). Stub its `tryLoadGraphFromSidecar` directly and inject
        // the instance so `storage.loadSourceModelDocument`'s dispatch runs through it.
        const modelSource = new SidecarModelSource(testCfg({ settingsNamespace: 'calLang', sidecarOperationPrefix: 'calpy', graphAcquisition: 'sidecar-export' })) as any;
        storage.injectedModelSource = modelSource;

        const calls: Array<{ filePath: string; opts: Record<string, unknown> }> = [];
        let finishOpts: Record<string, unknown> | undefined;
        modelSource.tryLoadGraphFromSidecar = async (filePath: string, opts: Record<string, unknown>) => {
            calls.push({ filePath, opts });
            if (calls.length === 1) {
                return {
                    graph: {
                        network: 'decoder_block',
                        nodes: [],
                        edges: [],
                        partial: true,
                        errors: [{ message: 'no @network definitions found' }]
                    }
                };
            }
            return {
                graph: {
                    network: 'decoder_block',
                    nodes: [
                        {
                            id: 'n:linear0',
                            kind: 'actor',
                            label: 'linear0',
                            scope: 'scope:root',
                            ports: []
                        }
                    ],
                    edges: []
                }
            };
        };

        storage.finishLoadFromDoc = async (_doc: unknown, _sourceUri: string, _workflowFilePath: string, opts: Record<string, unknown>) => {
            finishOpts = opts;
        };
        storage.getWorkflowRelationshipInfo = async () => ({ workflowNames: [] });

        await storage.loadSourceModelDocument(
            {
                options: {
                    sourceUri: 'file:///tmp/layer.py',
                    networkName: 'decoder_block',
                    'wf:navTrail': JSON.stringify([
                        { sourceUri: 'file:///tmp/model.py', workflowName: 'qwen35_model' },
                        { sourceUri: 'file:///tmp/layer.py', workflowName: 'decoder_block', workflowInstanceName: 'decoder_block' }
                    ])
                }
            },
            'file:///tmp/layer.py'
        );

        expect(calls).toHaveLength(2);
        expect(calls[0].filePath).toBe('/tmp/layer.py');
        expect(calls[1].filePath).toBe('/tmp/model.py');
        expect(calls[1].opts['cal:graphSourceUri']).toBe('file:///tmp/model.py');
        expect(calls[1].opts['cal:rootWorkflow']).toBe('qwen35_model');
        expect(calls[1].opts['cal:instancePath']).toEqual(['decoder_block']);
        expect(finishOpts?.['cal:graphSourceUri']).toBe('file:///tmp/model.py');
        expect(finishOpts?.['cal:rootWorkflow']).toBe('qwen35_model');
        expect(finishOpts?.['cal:instancePath']).toEqual(['decoder_block']);
    });

    it('normalizes breadcrumb trail URIs while parsing request args', () => {
        const storage = new WorkflowSourceModelStorage() as any;
        storage.injectedModelSource = new SidecarModelSource(testCfg());

        const trail = storage.parseNavigationTrailArg(JSON.stringify([
            { sourceUri: 'file:///tmp/../tmp/root.py#section', workflowName: 'Root' },
            { sourceUri: 'file:///tmp/nested.py?x=1', workflowName: 'Nested' }
        ]));

        expect(trail).toEqual([
            { sourceUri: 'file:///tmp/root.py', workflowName: 'Root' },
            { sourceUri: 'file:///tmp/nested.py', workflowName: 'Nested' }
        ]);
    });

    it('derives overlay source-path hints from the breadcrumb trail', () => {
        const storage = new WorkflowSourceModelStorage() as any;
        storage.injectedModelSource = new SidecarModelSource(testCfg());

        const hints = storage.collectSourcePathHints('/tmp/nested.py', {
            'wf:navTrail': JSON.stringify([
                { sourceUri: 'file:///tmp/root.py', workflowName: 'Root' },
                { sourceUri: 'file:///tmp/nested.py?x=1', workflowName: 'Nested' }
            ])
        });

        expect(hints).toEqual(['/tmp/nested.py', '/tmp/root.py']);
    });

    it('derives workflow-name hints from the breadcrumb trail', () => {
        const storage = new WorkflowSourceModelStorage() as any;
        storage.injectedModelSource = new SidecarModelSource(testCfg());

        const hints = storage.collectWorkflowNameHints('loop_cp', {
            'wf:navTrail': JSON.stringify([
                { sourceUri: 'file:///tmp/pipeline.py', workflowName: 'Main' },
                { sourceUri: 'file:///tmp/pipeline.py', workflowName: 'loop_cp' }
            ])
        });

        expect(hints).toEqual(['loop_cp', 'Main']);
    });

    it('treats WF and boundary endpoints as equivalent signature candidates', () => {
        expect(buildViewerOverlaySignatureCandidates({
            fromEntity: 'WF',
            outPort: 'Kernel',
            toEntity: 'self',
            inPort: 'IN'
        })).toContain('boundary|Kernel|self|IN');

        expect(buildViewerOverlaySignatureCandidates({
            fromEntity: 'WF',
            outPort: 'Kernel',
            toEntity: 'self',
            inPort: 'IN'
        })).toContain('Kernel|Out|self|IN');

        expect(buildViewerOverlaySignatureCandidates({
            fromEntity: 'boundary',
            outPort: 'Kernel',
            toEntity: 'self',
            inPort: 'IN'
        })).toContain('WF|Kernel|self|IN');
    });

    it('builds node identity candidates from instance, type, and entity names', () => {
        expect(buildViewerOverlayNodeIdentityCandidates({
            'wf:entityInstanceName': 'optimizer',
            'cal:entityType': 'OptimizeAgentDynamicBsndOpenCode',
            'cal:entityName': 'optimizer'
        } as Record<string, unknown>)).toEqual([
            'optimizer',
            'OptimizeAgentDynamicBsndOpenCode'
        ]);

        expect(buildViewerOverlayNodeIdentityCandidates({
            'cal:entityType': 'CompileAndProfileDynamicBsndChunkO',
            'cal:entityName': 'loop_cp'
        } as Record<string, unknown>)).toEqual([
            'CompileAndProfileDynamicBsndChunkO',
            'loop_cp'
        ]);
    });

    it('resolves active entity from hierarchical overlay path for nested workflows', () => {
        expect(resolveViewerOverlayActiveEntityName(
            {
                entityInstanceName: 'semantic',
                entityInstancePath: ['loop_cp', 'semantic']
            },
            'chunk_o_optimize_workflow',
            []
        )).toBe('loop_cp');

        expect(resolveViewerOverlayActiveEntityName(
            {
                entityInstanceName: 'semantic',
                entityInstancePath: ['loop_cp', 'semantic']
            },
            'loop_cp',
            [
                { sourceUri: 'file:///tmp/root.py', workflowName: 'chunk_o_optimize_workflow' },
                { sourceUri: 'file:///tmp/root.py', workflowName: 'loop_cp' }
            ]
        )).toBe('semantic');

        expect(resolveViewerOverlayActiveEntityName(
            {
                entityInstanceName: 'optimizer',
                entityInstancePath: ['optimize', 'optimizer']
            },
            'kernel_optimizer_io_workflow',
            [
                { sourceUri: 'file:///tmp/root.py', workflowName: 'chunk_o_optimize_composed_workflow' },
                {
                    sourceUri: 'file:///tmp/wf_kernel_optimizer_io.py',
                    workflowName: 'kernel_optimizer_io_workflow',
                    workflowInstanceName: 'optimize'
                }
            ]
        )).toBe('optimizer');
    });

    it('resolves active entities from array-format overlay (parallel execution)', () => {
        expect(resolveViewerOverlayActiveEntityName(
            [
                {
                    entityInstanceName: 'task_a',
                    entityInstancePath: ['task_a']
                },
                {
                    entityInstanceName: 'task_b',
                    entityInstancePath: ['task_b']
                }
            ],
            'parallel_workflow',
            []
        )).toBe('task_a');  // first matching entry wins

        expect(resolveViewerOverlayActiveEntityName(
            [
                {
                    entityInstanceName: 'semantic',
                    entityInstancePath: ['loop_cp', 'semantic']
                }
            ],
            'chunk_o_optimize_workflow',
            []
        )).toBe('loop_cp');
    });

    it('prefers source-scoped overlay key candidates to avoid cross-file AST path collisions', () => {
        const nestedSource = '/tmp/project/nested.py';
        const astPath = '/namespaces@0/workflows@0/structure/connections@2';
        const args = {
            'wf:sourcePath': nestedSource,
            'cal:astPath': astPath
        } as Record<string, unknown>;

        const candidates = buildViewerOverlayAstPathCandidates(args);
        expect(candidates[0]).toBe(`${nestedSource}::${astPath}`);
        expect(candidates).toContain(astPath);

        const overlayEdges: Record<string, { lastToken?: unknown }> = {
            [astPath]: { lastToken: '/tmp/wrong-inferDynamicStateShape.mlir' },
            [`${nestedSource}::${astPath}`]: { lastToken: '/tmp/correct-canonicalize_5.mlir' }
        };

        const picked = candidates
            .map(key => overlayEdges[key])
            .find(v => v !== undefined);

        expect(picked?.lastToken).toBe('/tmp/correct-canonicalize_5.mlir');
    });

    it('prefers queue trace overlayAstPath over plain astPath when both are present', async () => {
        const root = await mkTempDir('wf-lang-queue-overlay-');
        const outDir = path.join(root, 'wf-out', 'run-1');
        const queueTracePath = path.join(outDir, 'run.wf-queues.json');

        await writeFile(
            queueTracePath,
            JSON.stringify({
                version: 1,
                runId: 'run-1',
                workflowName: 'Root',
                sourcePath: '/tmp/root.py',
                startedAt: '2026-03-02T10:00:00.000Z',
                finishedAt: '2026-03-02T10:00:01.000Z',
                outDir,
                steps: [
                    {
                        step: 1,
                        workflowName: 'Root',
                        actorInstanceName: 'actor',
                        actorKind: 'internal',
                        actorFireCount: 1,
                        queueSizes: [
                            {
                                astPath: '/namespaces@0/workflows@0/structure/connections@0',
                                overlayAstPath: '/tmp/nested.py::/namespaces@0/workflows@0/structure/connections@0',
                                fromEntity: 'a',
                                outPort: 'Out',
                                toEntity: 'b',
                                inPort: 'In',
                                size: 1,
                                lastToken: '/tmp/token.mlir'
                            }
                        ]
                    }
                ],
                leftovers: []
            })
        );

        const storage = new WorkflowSourceModelStorage() as any;
        storage.injectedModelSource = new SidecarModelSource(testCfg());
        const trace = await storage.tryLoadQueueTraceAtStep(outDir, 0);

         expect(trace?.queues?.[0]?.astPath).toBe('/tmp/nested.py::/namespaces@0/workflows@0/structure/connections@0');
        expect(trace?.queues?.[0]?.lastToken).toBe('/tmp/token.mlir');
    });

    it('applies viewer tokens to boundary-connected edges through WF boundary aliases', async () => {
        const edge = GEdge.builder()
            .id('edge:weights-out')
            .type('edge:connection')
            .sourceId('weight_gen_port_weights')
            .targetId('weights_port_weights')
            .build();
        edge.args = {
            'wf:from': 'weight_gen',
            'wf:outPort': 'weights',
            'wf:to': 'boundary',
            'wf:inPort': 'weights'
        } as any;

        const root = GGraph.builder().id('root').addChildren(edge).build();

        const storage = new WorkflowSourceModelStorage() as any;
        storage.injectedModelSource = new SidecarModelSource(testCfg());
        storage.tryLoadLatestViewerOverlay = async () => ({
            runId: 'run-1',
            outDir: '/tmp/run-1',
            running: false,
            active: [],
            edges: {
                'queue:weight_gen.weights-->WF.weights': {
                    queueId: 'weight_gen.weights-->WF.weights',
                    fromEntity: 'weight_gen',
                    outPort: 'weights',
                    toEntity: 'WF',
                    inPort: 'weights',
                    lastToken: '/tmp/weights.exdf'
                }
            }
        });
        storage.isLiveExecutionGlowEnabled = async () => false;
        storage.tryLoadQueueTraceAtStep = async () => undefined;

        await storage.applyViewerOverlayToEdges(root, '/tmp/root.py', 'Root', [], ['Root']);

        expect(edge.args?.[WorkflowDiagramMetadata.VIEWER_LAST_TOKEN]).toBe('/tmp/weights.exdf');
    });

    it('applies viewer tokens to source-boundary edges through legacy boundary-label aliases', async () => {
        const edge = GEdge.builder()
            .id('edge:trace-json-in')
            .type('edge:connection')
            .sourceId('trace_json_port_trace_json')
            .targetId('trace_project_port_trace_json')
            .build();
        edge.args = {
            'wf:from': 'boundary',
            'wf:outPort': 'trace_json',
            'wf:to': 'trace_project',
            'wf:inPort': 'trace_json'
        } as any;

        const root = GGraph.builder().id('root').addChildren(edge).build();

        const storage = new WorkflowSourceModelStorage() as any;
        storage.injectedModelSource = new SidecarModelSource(testCfg());
        storage.tryLoadLatestViewerOverlay = async () => ({
            runId: 'run-1',
            outDir: '/tmp/run-1',
            running: false,
            active: [],
            edges: {
                'queue:trace_json.Out-->trace_project.trace_json': {
                    queueId: 'trace_json.Out-->trace_project.trace_json',
                    fromEntity: 'trace_json',
                    outPort: 'Out',
                    toEntity: 'trace_project',
                    inPort: 'trace_json',
                    lastToken: '/tmp/trace.jsonl'
                }
            }
        });
        storage.isLiveExecutionGlowEnabled = async () => false;
        storage.tryLoadQueueTraceAtStep = async () => undefined;

        await storage.applyViewerOverlayToEdges(root, '/tmp/root.py', 'Root', [], ['Root']);

        expect(edge.args?.[WorkflowDiagramMetadata.VIEWER_LAST_TOKEN]).toBe('/tmp/trace.jsonl');
    });

    it('keeps ancestor fallback glow for unmatched live-active entities when another entity matches directly', async () => {
        const directNode = GNode.builder()
            .id('direct-node')
            .type('node:actor')
            .build();
        directNode.args = {
            [WorkflowDiagramMetadata.ENTITY_NAME]: 'direct_task'
        } as any;

        const childNode = GNode.builder()
            .id('nested-child')
            .type('node:actor')
            .build();
        childNode.args = {
            [WorkflowDiagramMetadata.ENTITY_NAME]: 'inner_worker'
        } as any;

        const workflowNode = GNode.builder()
            .id('nested-workflow')
            .type('node:workflow')
            .addChildren(childNode)
            .build();
        workflowNode.args = {
            [WorkflowDiagramMetadata.IS_NETWORK_INSTANCE]: true,
            [WorkflowDiagramMetadata.REFERENCED_URI]: '/tmp/nested.py',
            [WorkflowDiagramMetadata.REFERENCED_ENTITY_NAME]: 'Nested'
        } as any;

        const root = GGraph.builder().id('root').addChildren(directNode, workflowNode).build();

        const storage = new WorkflowSourceModelStorage() as any;
        storage.injectedModelSource = new SidecarModelSource(testCfg());
        storage.tryLoadLatestViewerOverlay = async () => ({
            runId: 'run-1',
            outDir: '/tmp/run-1',
            running: true,
            active: [
                { entityInstanceName: 'direct_task' },
                { entityInstanceName: 'nested_task' }
            ],
            edges: {}
        });
        storage.isLiveExecutionGlowEnabled = async () => true;
        storage.tryLoadQueueTraceAtStep = async () => undefined;
        storage.findUniqueAncestorWorkflowNodeForActiveInstance = async (_root: unknown, activeName: string) => {
            return activeName === 'nested_task' ? workflowNode : undefined;
        };

        await storage.applyViewerOverlayToEdges(root, '/tmp/root.py', 'Root', [], ['Root']);

        expect(directNode.args?.[WorkflowDiagramMetadata.IS_EXECUTING]).toBe(true);
        expect(directNode.cssClasses).toContain('cal-node-active');
        expect(workflowNode.args?.[WorkflowDiagramMetadata.IS_EXECUTING]).toBe(true);
        expect(workflowNode.cssClasses).toContain('cal-node-active');
    });
});
