/**
 * The agent's tools for the chat's `/untangle` (untangle-session.ts):
 *
 * - `untangle-start` lays the diagram out with Layout Diagram, the drawing to
 *   beat, and says which definitions have several instances;
 * - `untangle-try` lays it out with Free Ports (port orders the agent gives
 *   for some definitions, the probe's for the rest) or Untangled, at most
 *   {@link MAX_TRIES} times, each with its crossings and its picture;
 * - `untangle-propose` puts one try to the person, in a card with its picture
 *   and the files it would change. The person's answer is the platform's to
 *   carry out, not the agent's: Apply writes the port orders and saves the
 *   layout (apply-port-orders-handler.ts), Discard draws the diagram as it
 *   was; either way the chat is told, with the two drawings to compare.
 *
 * A try is drawn on the person's diagram (fitted to the view, which is what
 * the picture shows) and saved nowhere.
 */
import {
    McpDiagramScopedInputSchema,
    OperationMcpDiagramToolHandler,
    type McpToolResult
} from '@eclipse-glsp/server-mcp';
import { GNode, RequestExportAction } from '@eclipse-glsp/server';
import { inject, injectable, optional } from 'inversify';
import * as vscode from 'vscode';
import * as z from 'zod/v4';
import { edgeCrossings } from '@dialogram/diagram-server/model/edge-crossings';
import { forgetProbe, type SideOrder } from '@dialogram/diagram-server/model/definition-port-order';
import { LayoutPreview, type PreviewLayout } from '@dialogram/diagram-server/operations/layout-preview';
import { DIAGRAM_CHAT_HOST, type DiagramChatFigure, type DiagramChatHost } from '@dialogram/diagram-server/server/diagram-chat-host';
import { applyLayoutGeometry } from '@dialogram/diagram-server/server/layout-snapshot';
import { entityFileOf, PORT_USES_QUERY, usesAcrossProject } from '../operations/entity-port-write';
import { SidecarInvoker } from '../operations/sidecar-invoker';
import {
    APPLY_PORT_ORDERS_OPERATION_KIND,
    REORDER_ENTITY_PORTS_OP,
    type ApplyPortOrdersOperation,
    type PortOrderWrite
} from './apply-port-orders-handler';
import {
    beginUntangle,
    drawnDefinitions,
    endUntangle,
    MAX_TRIES,
    orderToWrite,
    reordered,
    sidesText,
    writable,
    untangleOf,
    type DrawnDefinition,
    type UntangleState,
    type UntangleTry
} from './untangle-session';

/** How long a picture of the diagram may take: the webview may be in the background. */
const PICTURE_TIMEOUT_MS = 20000;

function fileName(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
}

function plural(count: number, one: string, many = `${one}s`): string {
    return `${count} ${count === 1 ? one : many}`;
}

/** The definitions of a drawing, for the agent: those with several instances, then the others reordered. */
function definitionsText(definitions: readonly DrawnDefinition[], withAlone: boolean): string[] {
    const shared = definitions.filter(each => each.instances.length > 1);
    const lines: string[] = [];
    if (shared.length > 0) {
        lines.push('Definitions with several instances (all instances of one are drawn in one port order):');
        for (const each of shared) {
            lines.push(`- ${each.name} (${each.instances.join(', ')}): ${sidesText(each.drawn)}`
                + (reordered(each) ? ` (declared: ${sidesText(each.declared)})` : '')
                + (each.disagree ? ' — its instances could not all take one order' : '')
                + (each.split ? ' — drawn with other ports elsewhere: its order is not written' : ''));
            if (withAlone && each.alone) {
                const alone = Object.entries(each.alone).map(([instance, sides]) => `${instance} ${sidesText(sides)}`);
                lines.push(`  each on its own would take: ${alone.join(' | ')}`);
            }
        }
    } else {
        lines.push('No definition has several instances here.');
    }
    const single = definitions.filter(each => each.instances.length === 1 && reordered(each));
    if (single.length > 0) {
        lines.push(`One instance each, drawn in another order than declared: ${single.map(each => `${each.name} (${sidesText(each.drawn)})`).join('; ')}`);
    }
    return lines;
}

/** What the tools share: the preview, the picture, the session. */
@injectable()
abstract class UntangleToolHandler<T extends z.infer<typeof McpDiagramScopedInputSchema>> extends OperationMcpDiagramToolHandler<T> {
    @inject(LayoutPreview)
    protected preview!: LayoutPreview;

    @inject(SidecarInvoker)
    protected sidecar!: SidecarInvoker;

    @inject(DIAGRAM_CHAT_HOST)
    @optional()
    protected chat?: DiagramChatHost;

    /** The diagram as drawn now, as a PNG (base64); nothing when it cannot be taken. */
    protected async picture(): Promise<string | undefined> {
        try {
            const response = await this.requestAction(
                RequestExportAction.create('png', { formatOptions: {} as unknown }),
                PICTURE_TIMEOUT_MS,
                `${this.name} picture`
            );
            return response.encoding === 'base64' ? response.data : undefined;
        } catch (error) {
            this.logger.warn(`${this.name}: no picture of the diagram (${error instanceof Error ? error.message : String(error)})`);
            return undefined;
        }
    }

    protected result(lines: readonly string[], picture?: string): McpToolResult {
        return {
            isError: false,
            content: [
                { type: 'text', text: lines.join('\n') },
                ...(picture ? [{ type: 'image' as const, data: picture, mimeType: 'image/png' }] : [{ type: 'text' as const, text: '(No picture: the diagram could not be drawn as one.)' }])
            ]
        };
    }

    protected running(): { state: UntangleState } | { refused: McpToolResult } {
        const state = untangleOf(this.modelState);
        if (!state) {
            return { refused: this.error('No untangle is going on in this diagram: call untangle-start first.') };
        }
        if (state.proposed !== undefined) {
            return { refused: this.error(`Try ${state.proposed} is put to the person, who applies or discards it in the chat: nothing more to do.`) };
        }
        return { state };
    }
}

export const UntangleStartInputSchema = McpDiagramScopedInputSchema;
export type UntangleStartInput = z.infer<typeof UntangleStartInputSchema>;

@injectable()
export class UntangleStartMcpToolHandler extends UntangleToolHandler<UntangleStartInput> {
    static readonly NAME = 'untangle-start';
    readonly name = UntangleStartMcpToolHandler.NAME;
    override readonly title = 'Untangle: Start';
    readonly description =
        'Begin untangling the diagram: lays it out with Layout Diagram, the drawing to beat, and answers its ' +
        'edge crossings, its picture and the definitions that have several instances. Then try layouts with ' +
        `untangle-try (at most ${MAX_TRIES} in all) and put the best to the person with untangle-propose. ` +
        'Nothing is saved until the person applies a try. Calling it again starts over from the drawing the ' +
        'diagram had, the tries made counting, and withdraws a try put to the person that they did not answer.';
    readonly inputSchema = UntangleStartInputSchema;

    protected async createResult(_params: UntangleStartInput): Promise<McpToolResult> {
        const sourceUri = this.modelState.sourceUri;
        if (!sourceUri) {
            return this.error('This diagram has no source file.');
        }
        if (!(await this.sidecar.supportsOp(sourceUri, REORDER_ENTITY_PORTS_OP))) {
            return this.error("This diagram's source cannot be given a port order: untangling is not available here.");
        }
        // A try put to the person and not answered (its card lost with the
        // panel closed) is withdrawn: answered later, it finds this untangle
        // gone and does nothing. The tries made count, so starting over gives
        // no more than ${MAX_TRIES} in all.
        const going = untangleOf(this.modelState);
        const root = this.modelState.root;
        const original = going?.original ?? this.preview.geometry();
        if (going) {
            applyLayoutGeometry(root, original);
        }
        forgetProbe(root);
        await this.preview.run('default');
        await this.preview.show();
        const crossings = edgeCrossings(root);
        const picture = await this.picture();
        const definitions = drawnDefinitions(root);
        const tries = going?.tries ?? [];
        beginUntangle(this.modelState, { root, original, baseline: { crossings, picture, definitions }, tries });
        const left = MAX_TRIES - tries.length;
        return this.result([
            `Layout Diagram: ${plural(crossings, 'edge crossing')} (the picture). Nothing is saved.`,
            ...definitionsText(definitions, false),
            '',
            left === MAX_TRIES
                ? `Next: untangle-try with layout "free-ports". You have ${MAX_TRIES} tries.`
                : left > 0
                    ? `Started over; ${plural(tries.length, 'try', 'tries')} made, ${plural(left, 'try', 'tries')} left (untangle-try), or untangle-propose with one made.`
                    : `Started over; all ${MAX_TRIES} tries are made: untangle-propose with the best of them.`
        ], picture);
    }
}

export const UntangleTryInputSchema = McpDiagramScopedInputSchema.extend({
    layout: z
        .enum(['free-ports', 'untangled'])
        .describe('free-ports: each node\'s ports in the order that crosses least, one order for all the instances of a definition. untangled: the ports in the order they had when the untangle began.'),
    orders: z
        .record(
            z.string(),
            z.object({
                left: z.array(z.string()).optional().describe('The left side\'s port names (inputs), top to bottom: each of them once.'),
                right: z.array(z.string()).optional().describe('The right side\'s port names (outputs), top to bottom: each of them once.')
            })
        )
        .optional()
        .describe('free-ports only: the port order to give a definition, by its name. Definitions not named take the order Free Ports finds; a side not given too.')
});
export type UntangleTryInput = z.infer<typeof UntangleTryInputSchema>;

@injectable()
export class UntangleTryMcpToolHandler extends UntangleToolHandler<UntangleTryInput> {
    static readonly NAME = 'untangle-try';
    readonly name = UntangleTryMcpToolHandler.NAME;
    override readonly title = 'Untangle: Try a Layout';
    readonly description =
        `Try a layout, one of at most ${MAX_TRIES}: drawn on the diagram, not saved. Answers its edge crossings, ` +
        'its picture, and each definition\'s port order as drawn; after free-ports, also the order each instance of ' +
        'a definition would take on its own, the candidates to try for it. Keep a change only when the crossings ' +
        'drop, or, within a few, when the picture reads better: shorter edges, a left-to-right flow, no edge under a node.';
    readonly inputSchema = UntangleTryInputSchema;

    protected async createResult({ layout, orders }: UntangleTryInput): Promise<McpToolResult> {
        const running = this.running();
        if ('refused' in running) {
            return running.refused;
        }
        const { state } = running;
        if (state.tries.length >= MAX_TRIES) {
            return this.error(`All ${MAX_TRIES} tries are used: put the best of them to the person with untangle-propose.`);
        }
        const named = Object.entries(orders ?? {});
        if (layout === 'untangled' && named.length > 0) {
            return this.error('Port orders are for free-ports: untangled keeps every port where it was when the untangle began.');
        }
        const given: Record<string, SideOrder> = {};
        for (const [name, sides] of named) {
            const matching = state.baseline.definitions.filter(each => each.name === name);
            const definition = matching[0];
            if (!definition) {
                return this.error(`No definition '${name}' here to give a port order: ${state.baseline.definitions.map(each => each.name).join(', ') || 'none'}.`);
            }
            if (matching.length > 1) {
                return this.error(`'${name}' names ${matching.length} definitions here, drawn with different ports: one order cannot be given to it by name.`);
            }
            for (const [side, names] of [['left', sides.left], ['right', sides.right]] as const) {
                const ports = side === 'left' ? definition.declared.west : definition.declared.east;
                if (names && [...names].sort().join('\u0000') !== [...ports].sort().join('\u0000')) {
                    return this.error(`The ${side} side of '${name}' has the ports ${ports.join(', ') || 'none'}: name each of them once.`);
                }
            }
            given[name] = { ...(sides.left ? { west: sides.left } : {}), ...(sides.right ? { east: sides.right } : {}) };
        }
        const root = this.modelState.root;
        forgetProbe(root);
        // Each try starts from the drawing the untangle began on: a port keeps
        // the row it is drawn on through a layout, and the try before this
        // one may have moved it.
        applyLayoutGeometry(root, state.original);
        await this.preview.run(layout as PreviewLayout, given);
        await this.preview.show();
        const crossings = edgeCrossings(root);
        const picture = await this.picture();
        const attempt: UntangleTry = {
            n: state.tries.length + 1,
            layout: layout as PreviewLayout,
            given,
            crossings,
            picture,
            geometry: this.preview.geometry(),
            definitions: drawnDefinitions(root)
        };
        state.tries.push(attempt);
        const best = state.tries.reduce((a, b) => (b.crossings < a.crossings ? b : a));
        const left = MAX_TRIES - state.tries.length;
        return this.result([
            `Try ${attempt.n} of ${MAX_TRIES} (${layout}${named.length > 0 ? `, your orders for ${named.map(([name]) => name).join(', ')}` : ''}): `
                + `${plural(crossings, 'edge crossing')}. Layout Diagram: ${state.baseline.crossings}. Best so far: try ${best.n}, ${best.crossings}.`,
            ...definitionsText(attempt.definitions, layout === 'free-ports'),
            '',
            left > 0
                ? `${plural(left, 'try', 'tries')} left. When no change helps, or none is left: untangle-propose with the best try.`
                : 'No try left: untangle-propose with the best try.'
        ], picture);
    }
}

export const UntangleProposeInputSchema = McpDiagramScopedInputSchema.extend({
    try: z.number().int().min(1).describe('The try to put to the person: its number, as untangle-try answered it.')
});
export type UntangleProposeInput = z.infer<typeof UntangleProposeInputSchema>;

@injectable()
export class UntangleProposeMcpToolHandler extends UntangleToolHandler<UntangleProposeInput> {
    static readonly NAME = 'untangle-propose';
    readonly name = UntangleProposeMcpToolHandler.NAME;
    override readonly title = 'Untangle: Propose a Try';
    readonly description =
        'Put one try to the person, in the chat: its picture, its crossings and the source files whose port ' +
        'order it changes, with Apply and Discard. The person decides and the platform carries it out: after ' +
        'this call, say in one line which try you proposed and why, and stop.';
    readonly inputSchema = UntangleProposeInputSchema;

    protected async createResult({ try: n }: UntangleProposeInput): Promise<McpToolResult> {
        const running = this.running();
        if ('refused' in running) {
            return running.refused;
        }
        const { state } = running;
        const chosen = state.tries[n - 1];
        if (!chosen) {
            return this.error(`There is no try ${n}: ${state.tries.length === 0 ? 'none was made yet' : `tries 1 to ${state.tries.length} were made`}.`);
        }
        const sourceUri = this.modelState.sourceUri!;
        if (!this.chat?.canAsk(sourceUri)) {
            return this.error('No chat panel is open on this diagram to put the try to the person.');
        }
        await this.preview.show(chosen.geometry);
        const writes = this.writesOf(chosen);
        const card = await this.card(state, chosen, writes, sourceUri);
        state.proposed = n;
        void this.ask(state, chosen, writes, card, sourceUri);
        return this.success(
            `Try ${n} (${plural(chosen.crossings, 'crossing')}) is put to the person with its picture and the files it changes. `
            + 'They apply or discard it in the chat; the platform carries it out. Say in one line which try you proposed and why, and stop.'
        );
    }

    /** The port orders `chosen` draws that its sources do not declare. */
    private writesOf(chosen: UntangleTry): PortOrderWrite[] {
        const writes: PortOrderWrite[] = [];
        for (const definition of chosen.definitions) {
            if (!reordered(definition) || !writable(definition)) {
                continue;
            }
            const node = this.modelState.index.find(definition.elementId);
            if (node instanceof GNode) {
                writes.push({ entity: definition.name, elementId: definition.elementId, order: orderToWrite(node, definition.drawn) });
            }
        }
        return writes;
    }

    private async card(state: UntangleState, chosen: UntangleTry, writes: readonly PortOrderWrite[], sourceUri: string): Promise<{
        title: string; text: string; choices: string[]; figures: DiagramChatFigure[]; apply: string; files: string[];
    }> {
        const byFile = new Map<string, string[]>();
        const usedElsewhere = new Set<string>();
        const followsUses = await this.sidecar.hasFeature(sourceUri, PORT_USES_QUERY);
        for (const write of writes) {
            const fileUri = entityFileOf(this.modelState, sourceUri, { entityType: write.entity, elementId: write.elementId });
            const definition = chosen.definitions.find(each => each.elementId === write.elementId)!;
            const changes = (['west', 'east'] as const)
                .filter(side => definition.drawn[side].join() !== definition.declared[side].join())
                .map(side => `${side === 'west' ? 'left' : 'right'} ${definition.declared[side].join(', ')} → ${definition.drawn[side].join(', ')}`);
            const file = vscode.Uri.parse(fileUri).fsPath;
            byFile.set(file, [...(byFile.get(file) ?? []), `  ${write.entity}: ${changes.join('; ')}`]);
            if (followsUses) {
                const uses = await usesAcrossProject(this.sidecar, sourceUri, fileUri, write.entity);
                for (const use of uses?.usedIn ?? []) {
                    if (vscode.Uri.file(use.file).toString() !== vscode.Uri.parse(sourceUri).toString()) {
                        usedElsewhere.add(`${use.workflow} (${fileName(use.file)})`);
                    }
                }
            }
        }
        const files = [...byFile.keys()];
        const head = `${plural(chosen.crossings, 'edge crossing')}, against ${state.baseline.crossings} with Layout Diagram.`;
        const text = writes.length === 0
            ? `${head}\nApply saves this layout; no port order changes.`
            : [
                head,
                `Apply saves this layout and writes the port order of ${plural(writes.length, 'definition')} in ${plural(files.length, 'file')}:`,
                ...files.flatMap(file => [fileName(file), ...byFile.get(file)!]),
                ...(usedElsewhere.size > 0 ? [`Also drawn in the new order: ${[...usedElsewhere].join(', ')}.`] : []),
                'Undo puts the files and the layout back.'
            ].join('\n');
        const apply = writes.length === 0 ? 'Apply' : `Apply to ${plural(files.length, 'file')}`;
        return {
            title: `Untangle: try ${chosen.n}`,
            text,
            choices: [apply, 'Discard'],
            figures: chosen.picture ? [{ data: chosen.picture, caption: `Try ${chosen.n}: ${plural(chosen.crossings, 'crossing')}` }] : [],
            apply,
            files
        };
    }

    /** The person's answer, carried out; then the chat is told, with the two drawings. */
    private async ask(
        state: UntangleState,
        chosen: UntangleTry,
        writes: PortOrderWrite[],
        card: { title: string; text: string; choices: string[]; figures: DiagramChatFigure[]; apply: string },
        sourceUri: string
    ): Promise<void> {
        const chat = this.chat!;
        try {
            const answer = await chat.confirm(sourceUri, { title: card.title, text: card.text, choices: card.choices, figures: card.figures });
            if (untangleOf(this.modelState) !== state) {
                // The diagram was reloaded meanwhile, or the untangle started
                // over: this try is nothing to apply any more.
                if (answer?.choice === card.apply) {
                    await chat.post(sourceUri, {
                        text: `Untangle try ${chosen.n} not applied: the diagram was reloaded, or the untangle started over, while it waited. Nothing was written.`
                    });
                }
                return;
            }
            if (answer?.choice !== card.apply) {
                endUntangle(this.modelState);
                await this.preview.show(state.original);
                await chat.post(sourceUri, { text: `Untangle discarded: the diagram is drawn as it was, and nothing was written.` });
                return;
            }
            const operation: ApplyPortOrdersOperation = { kind: APPLY_PORT_ORDERS_OPERATION_KIND, isOperation: true, writes };
            await this.actionDispatcher.dispatch(operation);
            const applied = state.applied;
            endUntangle(this.modelState);
            if (!applied?.ok) {
                await this.preview.show(state.original);
                await chat.post(sourceUri, { text: `Untangle not applied: ${applied?.message ?? 'nothing was written.'}` });
                return;
            }
            const written = applied.files.map(fileName);
            await chat.post(sourceUri, {
                text: `Untangle applied: try ${chosen.n}, ${plural(chosen.crossings, 'edge crossing')} against ${state.baseline.crossings} with Layout Diagram. `
                    + (written.length > 0 ? `Port orders written in ${written.join(', ')}; the layout is saved.` : 'The layout is saved; no port order changed.'),
                figures: [
                    ...(state.baseline.picture ? [{ data: state.baseline.picture, caption: `Layout Diagram: ${plural(state.baseline.crossings, 'crossing')}` }] : []),
                    ...(chosen.picture ? [{ data: chosen.picture, caption: `Untangled (try ${chosen.n}): ${plural(chosen.crossings, 'crossing')}` }] : [])
                ]
            });
        } catch (error) {
            this.logger.error(`untangle: the answer could not be carried out (${error instanceof Error ? error.message : String(error)})`);
            endUntangle(this.modelState);
            await chat.post(sourceUri, { text: `Untangle failed: ${error instanceof Error ? error.message : String(error)}` }).catch(() => false);
        }
    }
}

export const UntangleEndInputSchema = McpDiagramScopedInputSchema;
export type UntangleEndInput = z.infer<typeof UntangleEndInputSchema>;

/**
 * The untangle's end when no try was put to the person: the diagram drawn as
 * it was. The chat calls it when the turn of `/untangle` ends, whatever ended
 * it (the agent stopping short, the person stopping it, an error): a try left
 * drawn would otherwise be saved with the next node moved.
 */
@injectable()
export class UntangleEndMcpToolHandler extends UntangleToolHandler<UntangleEndInput> {
    static readonly NAME = 'untangle-end';
    readonly name = UntangleEndMcpToolHandler.NAME;
    override readonly title = 'Untangle: End';
    readonly description =
        'End an untangle no try of which was put to the person: the diagram is drawn as it was before, and ' +
        'nothing is saved. Called by the chat when the turn ends; a try put to the person stays theirs to answer.';
    readonly inputSchema = UntangleEndInputSchema;

    protected async createResult(_params: UntangleEndInput): Promise<McpToolResult> {
        const state = untangleOf(this.modelState);
        if (!state) {
            return this.success('No untangle is going on in this diagram.');
        }
        if (state.proposed !== undefined) {
            return this.success(`Try ${state.proposed} is put to the person, who applies or discards it in the chat.`);
        }
        endUntangle(this.modelState);
        await this.preview.show(state.original);
        return this.success('The untangle ended with no try put to the person: the diagram is drawn as it was, and nothing was saved.');
    }
}
