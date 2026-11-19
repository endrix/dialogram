import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { GGraph, GNode } from '@eclipse-glsp/server';
import {
    wordsForPhase,
    type DiagramModelSource,
    type GraphDocument,
    type LoadingUpdate,
    type LoadPhase,
    type LoadPhaseFacts,
    type LoadPhaseWords
} from '@dialogram/shared';
import { LoadProgressReporter } from '../src/server/load-progress';
import { WorkflowSourceModelStorage } from '../src/server/source-model-storage';
import { WorkflowModelSubmissionHandler } from '../src/server/diagram-action-handlers';

/**
 * A product's say over the words the platform shows for its own steps of a
 * load, and over the name its diagnostics carry in the Problems panel.
 *
 * The platform's words assume the graph is the content: "Drawing the
 * diagram, 1 node, 0 edges" is wrong for a product whose graph is a frame
 * round content it streams afterwards. A product hands `loadPhaseWords`, and
 * the indicator says what it returns, or nothing at that step.
 */

const SOURCE = 'file:///w/Top.dsl';

const graph = (nodes: number, edges: number): GraphDocument =>
    ({
        version: '1.0',
        graph: {
            id: 'g',
            nodes: Array.from({ length: nodes }, (_, i) => ({ id: `n${i}` })),
            edges: Array.from({ length: edges }, (_, i) => ({ id: `e${i}` }))
        }
    }) as unknown as GraphDocument;

function reporterTo(told: LoadingUpdate[], phaseWords?: LoadPhaseWords): LoadProgressReporter {
    const reporter = new LoadProgressReporter() as any;
    reporter.sink = (_client: string, update: LoadingUpdate) => told.push(update);
    reporter.clientId = 'client-5';
    reporter.phaseWords = phaseWords;
    return reporter as LoadProgressReporter;
}

function storageWith(getGraph: DiagramModelSource['getGraph'], phaseWords?: LoadPhaseWords) {
    const told: LoadingUpdate[] = [];
    const storage = new WorkflowSourceModelStorage() as any;
    storage.injectedModelSource = { getGraph } satisfies DiagramModelSource;
    storage.loadProgress = reporterTo(told, phaseWords);
    storage.publishGraphDiagnostics = async () => undefined;
    storage.finishLoadFromDoc = async () => undefined;
    const load = (requestId: string) =>
        storage.loadSourceModel({ kind: 'requestModel', requestId, options: { sourceUri: SOURCE } }) as Promise<void>;
    return { load, told };
}

describe('the platform\'s words for its steps', () => {
    it('are its own when the product has none', async () => {
        const { load, told } = storageWith(async () => graph(1, 0));

        await load('open-1');

        expect(told).toEqual([
            { state: 'progress', message: 'Reading Top.dsl' },
            { state: 'progress', message: 'Drawing the diagram', detail: '1 node, 0 edges' }
        ]);
    });

    it('are the product\'s where it gives others, and nothing where it silences the step', async () => {
        const asked: Array<[LoadPhase, string, LoadPhaseFacts]> = [];
        const { load, told } = storageWith(
            async (_uri, options) => {
                options.progress?.({ message: 'Placing 4,000 cells', detail: 'stage 1 of 3' });
                return graph(1, 0);
            },
            (phase, words, facts) => {
                asked.push([phase, words.message, facts]);
                if (phase === 'reading') {
                    return { message: 'Opening the design', detail: ' Top.dsl ' };
                }
                if (phase === 'drawing') {
                    return false;
                }
                return undefined;
            }
        );

        await load('open-1');

        expect(told).toEqual([
            { state: 'progress', message: 'Opening the design', detail: 'Top.dsl' },
            // The product's own words while it reads are its own, and pass as before.
            { state: 'progress', message: 'Placing 4,000 cells', detail: 'stage 1 of 3' }
            // And "Drawing the diagram | 1 node, 0 edges" is not said.
        ]);
        expect(asked).toEqual([
            ['reading', 'Reading Top.dsl', { file: '/w/Top.dsl' }],
            ['drawing', 'Drawing the diagram', { file: '/w/Top.dsl', nodes: 1, edges: 0 }]
        ]);
    });

    it('name the laying out and the routing with what they are of', () => {
        const told: LoadingUpdate[] = [];
        const facts: Array<[LoadPhase, LoadPhaseFacts]> = [];
        const handler = new WorkflowModelSubmissionHandler() as any;
        handler.loadProgress = reporterTo(told, (phase, _words, given) => {
            facts.push([phase, given]);
            return phase === 'routing' ? false : { message: `Arranging the frame (${given.nodes})` };
        });
        const root = GGraph.builder().id('g').add(GNode.builder().id('n1').build()).add(GNode.builder().id('n2').build()).build();
        const modelState = { root, sourceUri: SOURCE };

        handler.tellLayingOut('laying-out', 'Laying out the diagram', modelState);
        handler.tellLayingOut('routing', 'Routing the connections', modelState);

        expect(told).toEqual([{ state: 'progress', message: 'Arranging the frame (2)' }]);
        expect(facts).toEqual([
            ['laying-out', { file: '/w/Top.dsl', nodes: 2, edges: 0 }],
            ['routing', { file: '/w/Top.dsl', nodes: 2, edges: 0 }]
        ]);
    });

    it('are the platform\'s, said nowhere, when nobody is waiting on the load', async () => {
        const hook = vi.fn(() => ({ message: 'never shown' }));
        const { load, told } = storageWith(async () => graph(1, 0), hook);

        await load('refresh-live-overlay-1');

        expect(told).toEqual([]);
        expect(hook).not.toHaveBeenCalled();
    });

    it('fall silent rather than fail a load when the product\'s hook throws', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            expect(wordsForPhase(() => { throw new Error('bad'); }, 'reading', { message: 'Reading x' }, {})).toBeUndefined();
        } finally {
            warn.mockRestore();
        }
        // An empty message is no words: nothing is said.
        expect(wordsForPhase(() => ({ message: '  ' }), 'reading', { message: 'Reading x' }, {})).toBeUndefined();
        // The hook cannot change the platform's own record of the words.
        const words = { message: 'Reading x' };
        wordsForPhase((_phase, given) => { given.message = 'mutated'; return undefined; }, 'reading', words, {});
        expect(words.message).toBe('Reading x');
    });
});

describe('the name a graph diagnostic carries', () => {
    async function publish(diagnosticSource: string | undefined, file: string): Promise<vscode.Diagnostic[]> {
        const storage = new WorkflowSourceModelStorage() as any;
        storage.diagnosticSource = diagnosticSource;
        await storage.publishGraphDiagnostics([{ message: 'unknown port', severity: 'error', code: 'P1', startLine: 3 }], file);
        return vscode.languages.createDiagnosticCollection('workflow-graph').get(vscode.Uri.file(file)) as vscode.Diagnostic[];
    }

    it('is the product\'s name, given one', async () => {
        const [diagnostic] = await publish('Fixture Viewer', '/w/named.dsl');
        expect(diagnostic.source).toBe('Fixture Viewer');
        expect(diagnostic.code).toBe('P1');
    });

    it('is the platform\'s word, as before, when the host names no product', async () => {
        const [diagnostic] = await publish(undefined, '/w/unnamed.dsl');
        expect(diagnostic.source).toBe('workflow');
    });
});
