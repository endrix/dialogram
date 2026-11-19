/**
 * The node list: a second outline beside the hierarchy, of one node family's
 * nodes wherever they are in the hierarchy (a workflow's viewers), under the
 * instances holding them (shared `NodeListSpec`, published as `wf:nodeList`).
 *
 * It is the hierarchy outline's panel with other rows: the same tree, filter
 * and floating panel, its button directly under the hierarchy's. A single
 * click on a node finds it in its view, as the hierarchy's node rows do. A
 * double click opens what a double click on that node opens, without its view
 * being opened: the row carries the node as the canvas would draw it
 * (`HierarchyOutlineEntry.detachedNode`), which the product's node openers
 * are asked to open. A node no opener can open now (`NodeOpener.canOpen`: a
 * viewer before any run) is dimmed, says why as its tooltip and takes no
 * click; the next load (a run's tokens) asks again.
 */
import { injectable, multiInject, optional } from 'inversify';
import type { GModelElement } from '@eclipse-glsp/sprotty';
import { NODE_LIST_ARG, type HierarchyOutlineEntry, type NodeListOutline } from '@dialogram/shared';
import { entryKey, HierarchyOutlinePanel, type OutlinePanelConfig } from './hierarchy-outline';
import { rowId } from './hierarchy-outline-tree';
import { detachedElement, NodeOpener, nodeOpenability, openNode, openersInOrder, type NodeOpenerContext } from './node-opener';

const NODE_LIST_PANEL: OutlinePanelConfig = {
    id: 'workflow-node-list-outline',
    storageKey: 'dialogram.nodeListOutline.open',
    arg: NODE_LIST_ARG,
    codicon: 'list-tree',
    under: ['workflow-hierarchy-outline-toggle', 'workflow-chat-toggle-btn'],
    className: 'workflow-node-list'
};

/** A title or codicon the product wrote, as plain words: it goes into markup. */
const PLAIN_TITLE = /^[\p{L}\p{N} ._-]{1,40}$/u;
const CODICON = /^[a-z0-9-]{1,40}$/;

@injectable()
export class NodeListOutlinePanel extends HierarchyOutlinePanel {
    /** What products open on a double click; see `node-opener.ts`. */
    @multiInject(NodeOpener) @optional()
    protected readonly contributedOpeners: readonly NodeOpener[] | undefined;

    private listTitle = 'Nodes';
    /** Why each node row cannot be opened now, by row id; asked again for each outline. */
    private readonly reasons = new Map<string, string | undefined>();
    /** The rows seen before: one new to the list is opened, one the reader closed stays closed. */
    private readonly seen = new Set<string>();

    protected override panelConfig(): OutlinePanelConfig {
        // Its own copy: the codicon is the product's, read with the list.
        return { ...NODE_LIST_PANEL, under: [...NODE_LIST_PANEL.under] };
    }

    protected override title(): string {
        return this.listTitle;
    }

    protected override parseOutline(raw: string): HierarchyOutlineEntry | undefined {
        const list = JSON.parse(raw) as NodeListOutline;
        if (!list || typeof list !== 'object' || !list.outline || !Array.isArray(list.outline.children)) {
            return undefined;
        }
        const title = typeof list.title === 'string' ? list.title.trim() : '';
        this.listTitle = PLAIN_TITLE.test(title) ? title : 'Nodes';
        if (typeof list.codicon === 'string' && CODICON.test(list.codicon)) {
            (this.config as { codicon: string }).codicon = list.codicon;
        }
        return list.outline;
    }

    protected override outlineChanged(outline: HierarchyOutlineEntry): void {
        this.reasons.clear();
        // A list of a few nodes is read open: every instance new to it is opened.
        const walk = (entry: HierarchyOutlineEntry): void => {
            const id = rowId(entry);
            if (entry.children.length > 0 && !this.seen.has(id)) {
                this.seen.add(id);
                this.expanded.add(id);
            }
            entry.children.forEach(walk);
        };
        walk(outline);
    }

    protected override unavailableReason(entry: HierarchyOutlineEntry): string | undefined {
        const own = super.unavailableReason(entry);
        if (own || entry.role !== 'node' || !entry.detachedNode) {
            return own;
        }
        const id = rowId(entry);
        if (!this.reasons.has(id)) {
            const said = nodeOpenability(this.openers(), this.elementOf(entry), this.contextOf());
            this.reasons.set(id, said === true ? undefined : said);
        }
        return this.reasons.get(id);
    }

    protected override actOnNode(entry: HierarchyOutlineEntry, double: boolean): void {
        this.select(entryKey(entry));
        if (!double || !entry.detachedNode) {
            this.focusNode(entry, double);
            return;
        }
        const opened = openNode(this.openers(), this.elementOf(entry), this.contextOf());
        if (!opened) {
            // No product opener takes it: what a double click on the node does, in its view.
            this.focusNode(entry, true);
            return;
        }
        for (const action of opened) {
            void Promise.resolve(action).then(resolved => this.dispatcher.dispatch(resolved as never));
        }
    }

    private openers(): NodeOpener[] {
        return openersInOrder(this.contributedOpeners);
    }

    private elementOf(entry: HierarchyOutlineEntry): GModelElement {
        return detachedElement(entry.detachedNode!);
    }

    /** What the canvas's double click tells an opener: the editor's file. */
    private contextOf(): NodeOpenerContext {
        return { sourceUri: this.editorContext?.sourceUri ?? this.outline?.sourceUri };
    }
}
