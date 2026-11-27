import { inject, injectable, multiInject, optional, postConstruct } from 'inversify';
import { findNodeIdByGraphId } from './producer-ids';
import { ISelectionListener, IActionDispatcher, TYPES } from '@eclipse-glsp/client';
import { renderDocumentMarkdownSafe } from './markdown';
import { html, render, nothing, type TemplateResult } from 'lit';
import { createRef, ref } from 'lit/directives/ref.js';
import type { GModelRoot } from '@eclipse-glsp/sprotty';
import { CenterAction, DeleteElementOperation, SelectAction } from '@eclipse-glsp/protocol';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes, portTypesUsed } from '@dialogram/shared';
import {
    WorkflowCreateBoundaryPortOperation,
    WorkflowPromptLabelEditAction,
    WorkflowEditAnnotationsAction,
    WorkflowUpdateDefinitionAnnotationOperation,
    WorkflowUpdateEntityParameterOperation,
    WorkflowUpdateDefinitionParameterOperation,
    WorkflowUpdateEntityPortOperation,
    WorkflowUpdateEdgeCapacityOperation
} from './editing-action-handlers';
import { VscodeUi } from './vscode-ui';
import { ppField, ppNumberField, ppReadonlyRow } from './property-fields';
import { type PropertyElement, readNumberArg, readStringArg } from './property-model';
import { PropertyPanelChrome } from './property-panel-chrome';
import { clientBehavior, operationKind } from './profile';
import { classifyLink, decodeURIComponentSafe, openTargetOf, referenceAction, type PanelLink } from './open-target';
import { producerFields, type ProducerField } from './producer-fields';
import { AnnotationEditor } from './annotation-editor';
import { lastPerKey } from './contributions';
import { NodeSectionContribution, type NodeInfoRow, type NodeSectionContext } from './node-section';
import { createPropertySection, shortenPath } from './property-section';
import { isReadOnlyView } from './read-only-view';
import { elementPanelSignature, networkPanelSignature } from './panel-signature';
import { DiagramSurfaceHost, SURFACE_MOUNTED_EVENT, type SurfaceSelectionCause } from './diagram-surface-host';
import type { SurfaceSelection, SurfaceValue, SurfaceValuePart } from './diagram-surface';

/**
 * IGModelRootListener interface — fire on every model root change
 * (imported as a structural type to avoid deep import path issues).
 */
export interface IGModelRootListener {
    modelRootChanged(root: Readonly<GModelRoot>): void;
}

/**
 * The file a node's entity is defined in, when the producer said it is
 * (`REFERENCED_IS_DEFINITION`); a `REFERENCED_URI` alone is only where the
 * node is written (a module that re-exports the class, say).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function definitionUriOf(node: any): string | undefined {
    const uri = node?.args?.[WorkflowDiagramMetadata.REFERENCED_URI];
    return node?.args?.[WorkflowDiagramMetadata.REFERENCED_IS_DEFINITION] === true && typeof uri === 'string' && uri.trim() !== ''
        ? uri
        : undefined;
}

/**
 * What a merging annotation card changed: `argUpdates`, the arguments whose
 * value differs from `shown` (the card as drawn) or that it did not show;
 * `argRemovals`, the ones the source has (`loaded`, as the producer gave
 * them) that the card showed with a value and no longer has. A default the
 * card filled in is no removal when cleared: the source never had it. GUI-only
 * keys are neither.
 */
export function changedArgs(
    loaded: ReadonlyMap<string, string>,
    shown: ReadonlyMap<string, string>,
    pairs: ReadonlyArray<readonly [string, string]>,
    guiOnlyKeys: ReadonlySet<string>
): { argUpdates: Record<string, string>; argRemovals: string[] } {
    const argUpdates: Record<string, string> = {};
    const kept = new Set<string>();
    for (const [key, value] of pairs) {
        kept.add(key);
        if (String(shown.get(key) ?? '').trim() !== value) {
            argUpdates[key] = value;
        }
    }
    const hasValue = (map: ReadonlyMap<string, string>, key: string) => String(map.get(key) ?? '').trim() !== '';
    const argRemovals = [...loaded.keys()]
        .map(key => String(key ?? '').trim())
        .filter(key => key !== '' && !guiOnlyKeys.has(key) && !kept.has(key) && hasValue(loaded, key) && hasValue(shown, key));
    return { argUpdates, argRemovals };
}

/** How long a Save that had nothing to send says so on its button. */
const NOTHING_TO_SAVE_MS = 1500;

/** The panel's fields text is typed into: not a list or a box, which commit as they are chosen. */
const TEXT_FIELDS = 'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="number"], input[type="email"], input[type="url"], input[type="tel"], input[type="password"]';
/**
 * The mark of a field whose `change` commits it: the producer's fields carry
 * it ({@link PropertyPanel.buildProducerFieldsSection}), and so must a
 * product's own field in the panel that commits on change.
 */
const COMMITS_ON_CHANGE = '[data-commits-on="change"]';

@injectable()
export class PropertyPanel implements ISelectionListener, IGModelRootListener {
    
    @inject(TYPES.IActionDispatcher)
    protected readonly actionDispatcher!: IActionDispatcher;

    /** The editors products contributed for annotation cards; see `annotation-editor.ts`. */
    @multiInject(AnnotationEditor) @optional()
    protected readonly contributedAnnotationEditors: readonly AnnotationEditor[] | undefined;

    /** What products add to a node's panel; see `node-section.ts`. */
    @multiInject(NodeSectionContribution) @optional()
    protected readonly contributedNodeSections: readonly NodeSectionContribution[] | undefined;

    /** A diagram surface's selection, shown as a node's is; see `diagram-surface.ts`. */
    @inject(DiagramSurfaceHost) @optional()
    protected readonly surfaceHost: DiagramSurfaceHost | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected lastRoot: any | undefined;

    /** Window management (show/hide/pin, docked resize, floating mode, header drag). */
    protected readonly chrome = new PropertyPanelChrome(() => this.lastRenderedNodeId);

    constructor() {
        this.initialize();
    }

    protected initialize(): void {
        this.chrome.initialize();
        this.initializeLinks();
        this.initializeEditTracking();
    }

    /** A model skipped while something in the panel was typed into (`redrawIfChanged`). */
    private redrawPending = false;
    /** The last key typed in the panel was Enter: what was typed is committed, not being typed. */
    private panelCommitted = false;
    /**
     * Text typed into a field of the panel since the panel was last drawn,
     * and not committed (by an Enter the field takes, which it marks by
     * preventing the key's default, or a change of a field marked
     * `data-commits-on="change"`; a search field holds nothing): a field
     * keeps it after the focus leaves,
     * and a cleared selection does not draw over it
     * (`showViewOnSelectionCleared`).
     */
    private typedNotCommitted = false;

    /**
     * What the panel's own fields are doing: a value committed with Enter
     * (the field keeps the focus) lets the model it makes be drawn; a model
     * skipped while a field was typed into is drawn when the focus leaves
     * the panel.
     */
    protected initializeEditTracking(): void {
        document.addEventListener('keydown', event => {
            if (!(event.target as Element | null)?.closest?.('#property-panel')) {
                return;
            }
            if (event.key === 'Enter') {
                this.panelCommitted = true;
            } else if (event.key.length === 1 || event.key === 'Backspace' || event.key === 'Delete') {
                this.panelCommitted = false;
            }
        }, true);
        // Enter commits what is typed only where the field takes it, and each
        // field whose Enter commits prevents its default (`sourceField`, Enter
        // or Ctrl+Enter in a field of lines; `ppNumberField`; the producer's
        // fields; the parameter forms' names): heard here after the field, as
        // the keydown bubbles. An Enter in a field that commits nothing on it
        // (an annotation's argument row, a form's other fields) leaves it.
        document.addEventListener('keydown', event => {
            if (event.key === 'Enter' && event.defaultPrevented && (event.target as Element | null)?.closest?.('#property-panel')) {
                this.typedNotCommitted = false;
            }
        });
        document.addEventListener('input', event => {
            const target = event.target as HTMLElement | null;
            // A search field filters what the panel shows and holds nothing to commit.
            if (target?.closest?.('#property-panel') && (target.isContentEditable || !!target.matches?.(TEXT_FIELDS))
                && !target.matches?.('input[type="search"]')) {
                this.typedNotCommitted = true;
            }
        }, true);
        // A field committed otherwise than with Enter (its value changed and
        // the focus kept): the model it makes is drawn. The producer's fields
        // commit on a change; the panel's own commit on Enter or by their
        // button, and a change (the focus leaving) commits nothing of theirs.
        document.addEventListener('change', event => {
            const target = event.target as Element | null;
            if (target?.closest?.('#property-panel')) {
                this.panelCommitted = true;
                if (target.matches?.(COMMITS_ON_CHANGE)) {
                    this.typedNotCommitted = false;
                }
            }
        }, true);
        document.addEventListener('focusout', event => {
            if (!this.redrawPending || !(event.target as Element | null)?.closest?.('#property-panel')) {
                return;
            }
            // The focus has not landed yet: look once it has.
            setTimeout(() => {
                if (this.redrawPending && this.lastRoot && !this.typingInPanel() && !this.showViewWhileNothingShown()) {
                    this.redrawIfChanged(this.lastRoot);
                }
            }, 0);
        }, true);
    }

    /**
     * After injection: the node sections' one-time setup, and the surface's
     * selection and mounting heard. A surface may mount after the first model
     * came, and the panel then looks again (`showViewWhileNothingShown`).
     */
    @postConstruct()
    protected installNodeSections(): void {
        const host = { redrawIfShowing: (elementId: string) => this.redrawIfShowing(elementId) };
        for (const contribution of this.nodeSections()) {
            contribution.install?.(host);
        }
        if (this.surfaceHost) {
            this.surfaceHost.onSelectionChanged((selection, cause) => this.surfaceSelectionChanged(selection, cause));
            document.addEventListener(SURFACE_MOUNTED_EVENT, () => this.showViewWhileNothingShown());
        }
    }

    /** Whether the panel shows the surface's selection (`showSurfaceSelection`). */
    private showingSurface = false;

    /**
     * With nothing selected and nothing else shown, over a mounted surface
     * that hears clicks, the panel shows the view's own properties: the
     * double click on the background that shows them elsewhere is the
     * surface's there (`WhitespaceRootPropertiesMouseListener`, by the same
     * test), and the page's hint would stay in their place with no gesture
     * to replace it. So does a view with facts of its own where the product
     * asks (`clientBehavior.viewFactsWhileNothingSelected`). A node or a
     * surface selection the panel shows is left as it is, and nothing is
     * selected by this. Not while something in the panel is typed into: the
     * focus leaving the panel draws them. True when it drew them.
     */
    protected showViewWhileNothingShown(): boolean {
        const host = this.surfaceHost;
        const hearsClicks = !!host?.mounted() && typeof host.surface()?.click === 'function';
        if (this.shown || this.showingSurface || !this.lastRoot || host?.currentSelection()) {
            return false;
        }
        if (!hearsClicks && !this.showsViewFacts(this.lastRoot)) {
            return false;
        }
        if (this.typingInPanel()) {
            this.redrawPending = true;
            return false;
        }
        this.redrawPending = false;
        this.showNoSelection();
        return true;
    }

    /**
     * The surface's selection changed: shown as a node is, and, when it is
     * cleared by Escape or by the surface, the panel goes back to the view's
     * own properties, since what it showed is no longer selected anywhere.
     * Over a surface that hears clicks, those are also what the panel shows
     * from the first model on, while nothing is selected
     * (`showViewWhileNothingShown`). A node selected instead clears it too,
     * and the node's panel is already drawn then: nothing to do. A click on
     * nothing keeps what the panel shows, as a click that deselects a node
     * does, unless the product asks for the view's facts then
     * (`showViewOnSelectionCleared`).
     */
    surfaceSelectionChanged(selection: SurfaceSelection | undefined, cause: SurfaceSelectionCause): void {
        if (selection) {
            this.showSurfaceSelection(selection);
            return;
        }
        if (cause !== 'graph' && cause !== 'click' && this.showingSurface) {
            this.showNoSelection();
        } else if (cause === 'click' && this.showingSurface) {
            this.showViewOnSelectionCleared();
        }
    }

    /**
     * Whether the panel shows `root`'s own facts while nothing is selected:
     * the product asks (`clientBehavior.viewFactsWhileNothingSelected`) and
     * the view states some (`graph.meta.facts`, on the root as `wf:facts`).
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected showsViewFacts(root: any): boolean {
        return clientBehavior().viewFactsWhileNothingSelected === true
            && this.normalizeFacts(root?.args?.[WorkflowDiagramMetadata.FACTS]).length > 0;
    }

    /**
     * A selection the reader cleared with a click on nothing, of a node or of
     * a surface: where {@link showsViewFacts}, the panel shows the view's own
     * properties in place of what is no longer selected. Not while a
     * surface's selection is there (the reader has just made it: the panel
     * shows it), nor while a field of the panel has the focus or holds text
     * typed and not committed: the panel is left as it is then. The pin
     * keeps the panel visible, as its button says, and keeps no content:
     * pinned or not, the panel shows the view's facts.
     */
    protected showViewOnSelectionCleared(): void {
        const root = this.lastRoot;
        if (!root || !this.showsViewFacts(root) || this.surfaceHost?.currentSelection()) {
            return;
        }
        if (this.typingInPanel() || this.typedNotCommitted) {
            return;
        }
        // Already the view's: drawn again, it would lose its scroll.
        if (this.shown && this.shown.id === undefined) {
            return;
        }
        this.showNoSelection();
    }

    /**
     * Draw what a surface selected: Basic Info (its name and kind, as a
     * node's), then its sections, rows as the producer's facts are drawn. A
     * value's links go back to the surface (`followLink`), not to the host:
     * they are the surface's own strings and carry no `href`, so the panel's
     * link handling leaves them alone.
     */
    protected showSurfaceSelection(selection: SurfaceSelection): void {
        const content = document.getElementById('property-content');
        if (!content) {
            return;
        }
        content.innerHTML = '';
        this.typedNotCommitted = false;
        this.lastRenderedNodeId = undefined;
        // Nothing of the model's: a model change neither redraws nor replaces it.
        this.shown = undefined;
        this.showingSurface = true;
        const row = (label: string, value: SurfaceValue) => html`<div class="pp-arow">
            <span class="pp-akey">${label}</span>
            <span class="pp-aval pp-aval-wrap">${this.surfaceValue(value)}</span>
        </div>`;
        // Where it is written, as a node's Opens row: an `href`, so the panel's
        // own link handling opens the file at the line.
        const source = selection.source;
        const sourcePath = source ? decodeURIComponentSafe(source.uri.replace(/^file:\/\//, '')) : '';
        const opens = source
            ? html`<div class="pp-arow">
                  <span class="pp-akey">Opens</span>
                  <span class="pp-aval pp-aval-wrap">
                      <a href=${source.line ? `${source.uri}#L${source.line}` : source.uri} title=${sourcePath}
                          >${shortenPath(sourcePath)}${source.line ? `:${source.line}` : ''}</a>
                  </span>
              </div>`
            : nothing;
        content.appendChild(this.litSection('Basic Info', {
            body: html`${row('Name', selection.title)}${selection.kind ? row('Type', selection.kind) : nothing}${opens}${selection.note
                ? html`<div class="pp-surface-note">${selection.note}</div>`
                : nothing}`,
            extraClass: 'pp-surface-selection'
        }));
        for (const section of selection.sections ?? []) {
            content.appendChild(this.litSection(section.title, {
                body: html`${section.rows.map(r => row(r.label, r.value))}${section.more
                    ? html`<div class="pp-surface-more">and ${section.more} more</div>`
                    : nothing}`,
                collapsed: section.collapsed
            }));
        }
        if (this.chrome.pinned) {
            this.chrome.show();
        }
    }

    private surfaceValue(value: SurfaceValue): TemplateResult | string {
        if (!Array.isArray(value)) {
            return String(value);
        }
        const follow = (event: Event, link: string) => {
            event.preventDefault();
            event.stopPropagation();
            this.surfaceHost?.followLink(link);
        };
        return html`${(value as readonly SurfaceValuePart[]).map(part => part.link === undefined
            ? html`<span title=${part.title ?? nothing}>${part.text}</span>`
            : html`<a class="pp-surface-link" role="link" tabindex="0" title=${part.title ?? nothing}
                    data-surface-link=${part.link}
                    @click=${(event: Event) => follow(event, part.link!)}
                    @keydown=${(event: KeyboardEvent) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            follow(event, part.link!);
                        }
                    }}>${part.text}</a>`)}`;
    }

    /**
     * One contribution per id, in the order the ids were first bound; a later
     * binding replaces the earlier one.
     */
    protected nodeSections(): readonly NodeSectionContribution[] {
        return lastPerKey(this.contributedNodeSections, contribution => contribution.id);
    }

    /** Draw a node again if the panel is open on it, without the editors asking for discovery again. */
    protected redrawIfShowing(elementId: string): void {
        if (elementId !== this.lastRenderedNodeId) {
            return;
        }

        const panel = document.getElementById('property-panel');
        const isVisible = !!panel && !panel.classList.contains('collapsed');
        if (!isVisible || !this.lastRoot) {
            return;
        }

        const element = (this.lastRoot as any).index?.getById(elementId);
        if (!element) {
            return;
        }

        this.updateContent(element, { requestAgentDiscovery: false });
    }

    /**
     * Links anywhere in the panel lead somewhere instead of nowhere: a webview
     * does not navigate, so a click on an anchor in a rendered body or a
     * producer's fact did nothing. One listener, on the document because the
     * panel's content is rebuilt on every selection.
     */
    protected initializeLinks(): void {
        document.addEventListener('click', event => {
            const anchor = (event.target as Element | null)?.closest?.('a[href]');
            if (!anchor || !anchor.closest('#property-panel')) {
                return;
            }
            const link = classifyLink(anchor.getAttribute('href'), anchor.getAttribute('title'));
            if (!link) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            this.followLink(link);
        }, true);
    }

    /**
     * `#<id>` selects that element and brings it into view (the panel then
     * shows it); anything else goes to the host, resolved against the file the
     * shown node came from.
     */
    /** The element a link names: by the diagram's id, or by the producer's (`wf:graphNodeId`). */
    protected elementIdFor(id: string): string | undefined {
        return this.lastRoot ? findNodeIdByGraphId(this.lastRoot, id) : undefined;
    }

    protected followLink(link: PanelLink): void {
        if (link.kind === 'element') {
            const id = this.elementIdFor(link.id);
            if (!id && link.fallback) {
                this.followLink({ kind: 'reference', href: link.fallback });
                return;
            }
            if (!id) {
                VscodeUi.instance.infoMessage(`${link.id} is not in this diagram.`);
                return;
            }
            void this.actionDispatcher.dispatchAll([
                SelectAction.create({ selectedElementsIDs: [id], deselectedElementsIDs: true }),
                CenterAction.create([id], { animate: true, retainZoom: true })
            ]);
            return;
        }
        const node = this.lastRenderedNodeId ? this.lastRoot?.index?.getById(this.lastRenderedNodeId) : undefined;
        const base = (node?.args?.[WorkflowDiagramMetadata.REFERENCED_URI] as string | undefined)
            ?? (this.lastRoot?.args?.['wf:workflowSourceUri'] as string | undefined)
            ?? (this.lastRoot?.args?.[WorkflowDiagramMetadata.REFERENCED_URI] as string | undefined);
        void this.actionDispatcher.dispatch(referenceAction(link, base));
    }

    /**
     * The node the panel shows, for the in-place updates of its sections while
     * the model changes (`NodeSectionContribution.modelChanged`).
     */
    private lastRenderedNodeId: string | undefined;

    /**
     * What the panel shows: the element (none: the network), the node to
     * show if that element is gone (a port's), and the signature of what was
     * drawn, to draw it again when an edit changes it (`panel-signature.ts`).
     */
    private shown: { id?: string; fallbackId?: string; signature: string } | undefined;

    /**
     * One editor per annotation name, in the order the names were first bound.
     * A later binding for a name replaces the earlier one, so a module that
     * loads later can replace an editor an earlier one bound.
     */
    protected annotationEditors(): readonly AnnotationEditor[] {
        return lastPerKey(this.contributedAnnotationEditors, editor => editor.annotationName);
    }

    /** The editor for an annotation name, if one is bound. */
    protected annotationEditorFor(name: string): AnnotationEditor | undefined {
        return this.annotationEditors().find(editor => editor.annotationName === name);
    }

    protected isNetworkRuntime(): boolean {
        return clientBehavior().networkPropertySections === true;
    }

    // ── IGModelRootListener ─────────────────────────────────────────────
    // Fires on EVERY model root change (SetModelAction / UpdateModelAction),
    // unlike selectionChanged which only fires when the selected set changes.
    // This is how a node section stays up to date in place while a run
    // streams (`NodeSectionContribution.modelChanged`).
    modelRootChanged(root: Readonly<GModelRoot>): void {
        this.lastRoot = root;
        if (this.showViewWhileNothingShown() || this.redrawIfChanged(root)) {
            return;
        }
        if (!this.lastRenderedNodeId) {
            return;
        }
        const panel = document.getElementById('property-panel');
        const isVisible = panel && !panel.classList.contains('collapsed');
        if (!isVisible) {
            return;
        }
        // Look up the currently displayed node in the new root.
        const element = (root as any).index?.getById(this.lastRenderedNodeId);
        if (!element || !element.type?.startsWith('node')) {
            return;
        }
        const content = document.getElementById('property-content');
        if (!content) {
            return;
        }
        for (const contribution of this.nodeSections()) {
            contribution.modelChanged?.(element, content);
        }
    }

    /**
     * Draw the panel again when what it shows changed in the new model (an
     * edit: a port renamed, retyped, added or taken out, a node renamed);
     * true when it did. What it showed and is gone (renamed: its id is
     * another) gives way to its node, for a port, or to the network. Not
     * while something in the panel is being typed into: the next change
     * draws it.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected redrawIfChanged(root: any): boolean {
        const shown = this.shown;
        const content = document.getElementById('property-content');
        if (!shown || !content) {
            return false;
        }
        if (this.typingInPanel()) {
            this.redrawPending = true;
            return false;
        }
        this.redrawPending = false;
        let element = shown.id === undefined ? undefined : root?.index?.getById?.(shown.id);
        if (shown.id !== undefined && !element && shown.fallbackId !== undefined) {
            element = root?.index?.getById?.(shown.fallbackId);
        }
        const now = element ? elementPanelSignature(element, root) : shown.id === undefined ? networkPanelSignature(root) : undefined;
        if (now === shown.signature) {
            return false;
        }
        const scrolled = content.scrollTop;
        this.panelCommitted = false;
        if (element) {
            if (this.chrome.lastSelectedElement?.id === element.id) {
                this.chrome.lastSelectedElement = element;
            }
            this.updateContent(element, { requestAgentDiscovery: false });
        } else {
            this.showNoSelection();
        }
        content.scrollTop = scrolled;
        return true;
    }

    protected typingInPanel(): boolean {
        const active = document.activeElement as HTMLElement | null;
        // Text being typed: not a choice made in a list or a box ticked,
        // which commit as they are made and keep the focus.
        return !this.panelCommitted
            && !!active?.closest?.('#property-panel')
            && (active.isContentEditable || !!active.matches?.(TEXT_FIELDS));
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    selectionChanged(root: any, selectedElements: string[], deselectedElements?: string[]): void {
        this.lastRoot = root;

        // Always update content if panel is visible (regardless of pinned state)
        const panel = document.getElementById('property-panel');
        const isVisible = panel && !panel.classList.contains('collapsed');
        
        if (selectedElements.length === 0) {
            // Keep current property content on single-click deselection.
            // Root/workflow properties are now shown explicitly on background double-click.
            // Where the product asks, a view's facts instead (showViewOnSelectionCleared);
            // not for a selection the model took away (its element is gone from it),
            // which redrawIfChanged gives way to its node, or to the view.
            if (!(deselectedElements ?? []).some(id => !root?.index?.getById?.(id))) {
                this.showViewOnSelectionCleared();
            }
            return;
        }

        // Find the selected element in the model
        const selectedId = selectedElements[0];
        const element = root.index.getById(selectedId);
        
        if (element) {
            this.chrome.lastSelectedElement = element;
            // Full update for the selected element.
            this.updateContent(element);
            // Only auto-show if pinned
            if (this.chrome.pinned) {
                this.chrome.show();
            }
            // In floating mode, reposition near the newly selected node
            if (this.chrome.floatingMode && panel) {
                this.chrome.positionPanelNearElement(panel);
            }
        } else if (isVisible) {
            this.showNoSelection();
        }
    }

    /**
     * Switch the currently visible panel to root/workflow properties.
     * Triggered by an explicit whitespace double-click gesture.
     */
    public showRootPropertiesFromWhitespaceDoubleClick(): void {
        const panel = document.getElementById('property-panel');
        const isVisible = !!panel && !panel.classList.contains('collapsed');
        if (!isVisible) {
            return;
        }
        this.showNoSelection();
    }

    protected showNoSelection(): void {
        this.lastRenderedNodeId = undefined;
        this.showingSurface = false;
        const content = document.getElementById('property-content');
        if (content) {
            content.innerHTML = '';

            const root = this.lastRoot;
            this.shown = root ? { signature: networkPanelSignature(root) } : undefined;
            if (!root) {
                content.innerHTML =
                    '<div class="no-selection">' +
                    '<span class="codicon codicon-inspect"></span>' +
                    '<div class="no-selection-title">No selection</div>' +
                    '<div class="no-selection-hint">Select a node, port, or edge to view and edit its properties.</div>' +
                    '</div>';
                return;
            }

            this.updateContentForNetwork(root, content);
        }
    }

    protected updateContent(element: PropertyElement, options: { requestAgentDiscovery?: boolean } = {}): void {
        const content = document.getElementById('property-content');
        if (!content) return;

        const requestAgentDiscovery = options.requestAgentDiscovery !== false;

        content.innerHTML = '';
        this.typedNotCommitted = false;
        this.showingSurface = false;
        this.shown = {
            id: element.id,
            fallbackId: element.type?.startsWith('port') ? element.parent?.id : undefined,
            signature: elementPanelSignature(element as any, this.lastRoot)
        };

        // Track the rendered node for the sections' in-place updates, and let the
        // sections prepare a selected node (not a selected port's) before it is drawn.
        // A state of an automaton is no unit of a network: it has no sections of theirs.
        if (element.type?.startsWith('node') && element.type !== WorkflowDiagramTypes.NODE_STATE) {
            this.lastRenderedNodeId = element.id;
            for (const contribution of this.nodeSections()) {
                contribution.prepare?.(element, this.lastRoot);
            }
        } else {
            this.lastRenderedNodeId = undefined;
        }

        if (element.type.startsWith('edge')) {
            this.updateContentForEdge(element, content);
        } else if (element.type === WorkflowDiagramTypes.NODE_STATE) {
            this.updateContentForState(element, content);
        } else if (element.type.startsWith('node')) {
            this.updateContentForNode(element, content, requestAgentDiscovery);
        } else if (element.type.startsWith('port')) {
            // For ports, show the parent node's properties but highlight the port
            const parent = element.parent;
            if (parent && parent.type.startsWith('node')) {
                this.updateContentForNode(parent, content, requestAgentDiscovery);
                this.highlightSelectedPort(element, content);
            }
        } else {
            // Fallback for other elements
            const basicSection = createPropertySection('Basic Information');
            this.addProperty(basicSection, 'Type', element.type);
            this.addProperty(basicSection, 'ID', element.id);
            content.appendChild(basicSection);
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected updateContentForNode(node: any, content: HTMLElement, requestAgentDiscovery = true): void {
        const args = node.args || {};
        const usesNetworkModel = this.isNetworkRuntime();
        
        const isBoundaryInput = node.type === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT;
        const isBoundaryOutput = node.type === WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT;
        const isBoundary = isBoundaryInput || isBoundaryOutput;

        let entityName = args[WorkflowDiagramMetadata.ENTITY_NAME] as string;
        if (!entityName && isBoundary) {
            entityName = args[WorkflowDiagramMetadata.PORT_NAME] as string;
        }
        if (!entityName) {
            entityName = node.id;
        }

        const entityType = args[WorkflowDiagramMetadata.ENTITY_TYPE] as string || (isBoundary ? 'Port' : 'unknown');
        const isNetworkInstance = args[WorkflowDiagramMetadata.IS_NETWORK_INSTANCE] as boolean || false;
        const isExternalTask =
            node.type === WorkflowDiagramTypes.NODE_EXTERNAL_TASK ||
            args?.[WorkflowDiagramMetadata.IS_EXTERNAL_ACTOR] === true;
        const editableEntityParams = this.normalizeEditableEntityParameters(args[WorkflowDiagramMetadata.ENTITY_PARAMETERS]);
        const hasEditableNetworkParams = usesNetworkModel && !isBoundary && editableEntityParams.length > 0;
        
        // Get parameters
        const entityParams = args[WorkflowDiagramMetadata.ENTITY_PARAMETERS] as any[] || [];
        const defParams = args[WorkflowDiagramMetadata.ENTITY_DEFINITION_PARAMETERS] as any[] || [];
        
        // Find ports
        const children = node.children || [];
        const ports = children.filter((c: any) => c.type.startsWith('port'));
        const inputPorts = ports.filter((p: any) => p.args?.[WorkflowDiagramMetadata.IS_INPUT_PORT] === true);
        const outputPorts = ports.filter((p: any) => p.args?.[WorkflowDiagramMetadata.IS_INPUT_PORT] === false);
        
        // Basic Info Section
        // The product's words for the kind (an Actor, a Module), else the
        // platform's.
        const words = clientBehavior().kindLabels;
        let typeLabel = isNetworkInstance
            ? (words?.network ?? (usesNetworkModel ? 'Network' : 'Workflow'))
            : `${isExternalTask ? 'External ' : ''}${words?.instance ?? 'Task'}`;
        let typeBadge = entityType;

        if (isBoundaryInput) {
            typeLabel = 'Input Port';
            const isArray = args[WorkflowDiagramMetadata.IS_ARRAY_PORT] as boolean || false;
            const arraySize = args[WorkflowDiagramMetadata.ARRAY_SIZE] as string;
            typeBadge = (args[WorkflowDiagramMetadata.PORT_TYPE] as string || 'any') + (isArray ? `[${arraySize || ''}]` : '');
        } else if (isBoundaryOutput) {
            typeLabel = 'Output Port';
            const isArray = args[WorkflowDiagramMetadata.IS_ARRAY_PORT] as boolean || false;
            const arraySize = args[WorkflowDiagramMetadata.ARRAY_SIZE] as string;
            typeBadge = (args[WorkflowDiagramMetadata.PORT_TYPE] as string || 'any') + (isArray ? `[${arraySize || ''}]` : '');
        }

        const contributions = this.nodeSections();
        const sectionContext: NodeSectionContext = { entityName };
        const infoRows = contributions.flatMap(contribution => contribution.infoRows?.(node) ?? []);

        content.appendChild(
            this.buildBasicInfoSection(node, {
                entityName,
                typeLabel,
                typeBadge,
                isBoundary,
                isNetworkInstance,
                entityType,
                infoRows,
            })
        );

        // Fields the producer lets a person edit, in any profile: a select
        // where it listed the values, an input with suggestions where it
        // offered some, a plain input otherwise.
        const fields = producerFields(args[WorkflowDiagramMetadata.ENTITY_PARAMETERS]);
        if (fields.length > 0) {
            content.appendChild(this.buildProducerFieldsSection(node.id, fields));
        }

        const factsSection = this.buildFactsSection(args);
        if (factsSection) {
            content.appendChild(factsSection);
        }

        const sections = clientBehavior().propertySections;
        if (sections?.annotations !== false) {
            content.appendChild(this.buildDefinitionAnnotationsSection(node.id, args, undefined, requestAgentDiscovery));
        }

        for (const contribution of contributions) {
            const section = contribution.afterAnnotations?.(node, sectionContext);
            if (section) {
                content.appendChild(section);
            }
        }

        // A network model's parameters are its factory signature (`def Net(name: type = default)`),
        // so they get a real definition editor (name + type + default) instead of the value-only
        // instance editor. Gate on the factory name being present: the definition op targets the
        // factory function, so without it we keep the value-only instance-kwarg editor (no regression).
        const hasNetworkFactory = typeof args[WorkflowDiagramMetadata.NETWORK_FACTORY_NAME] === 'string'
            && (args[WorkflowDiagramMetadata.NETWORK_FACTORY_NAME] as string).trim() !== '';
        const isNetworkModel = usesNetworkModel && isNetworkInstance && hasNetworkFactory;

        if (isNetworkModel) {
            content.appendChild(this.buildNetworkDefinitionParamsSection(node.id, args));
        } else if (!hasEditableNetworkParams && fields.length === 0 && sections?.parameters !== false) {
            content.appendChild(this.buildDefinitionParametersSection(node.id, args));
        }

        if (!isNetworkModel && hasEditableNetworkParams) {
            const editableParamsSection = this.buildEditableEntityParametersSection(node.id, args);
            if (editableParamsSection) {
                content.appendChild(editableParamsSection);
            }
        }

        // Instance Parameters Section
        if (!usesNetworkModel && defParams.length > 0) {
            content.appendChild(this.buildInstanceParametersSection(node, entityParams, defParams));
        }

        // Input / Output port sections.
        //
        // Not for a boundary node: it IS a port — the network's own interface —
        // so offering it "Input Ports (0)" and "Output Ports (0)", each with an
        // add button, describes something that cannot exist. Its own type and
        // direction are already on the Basic Info section above.
        // Nor, empty, for the frame of an open node that keeps no pins: its
        // ports are not drawn while it is open, which is not having none.
        const listsEmptyPorts = !!entityType && node.type !== WorkflowDiagramTypes.NODE_GROUP;
        if (!isBoundary && sections?.ports !== false) {
            if (inputPorts.length > 0 || listsEmptyPorts) {
                content.appendChild(this.buildEntityPortsSection(node, entityType, 'input', inputPorts));
            }
            if (outputPorts.length > 0 || listsEmptyPorts) {
                content.appendChild(this.buildEntityPortsSection(node, entityType, 'output', outputPorts));
            }
        }

        for (const contribution of contributions) {
            const section = contribution.last?.(node, sectionContext);
            if (section) {
                content.appendChild(section);
            }
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected async promptAndUpdateEntityPort(
        _node: any,
        entityType: string,
        portDirection: 'input' | 'output',
        portElement: any,
        field: 'name' | 'type',
        currentValue: string
    ): Promise<void> {
        const portName = (portElement?.args?.[WorkflowDiagramMetadata.PORT_NAME] as string | undefined) ?? '';
        const portElementId = String(portElement?.id ?? '');
        const entityDocumentUri = definitionUriOf(_node);

        if (!entityType || !portName || !portElementId) {
            void VscodeUi.instance.errorMessage('Port metadata missing; cannot edit.');
            return;
        }

        const title = field === 'name' ? 'Rename Port' : 'Change Port Type';
        const next = await VscodeUi.instance.inputBox({
            prompt: title,
            value: currentValue
        });
        if (next === undefined) {
            return;
        }

        const trimmed = next.trim();
        if (!trimmed) {
            return;
        }

        await this.actionDispatcher.dispatch(
            WorkflowUpdateEntityPortOperation.create({
                entityType,
                entityDocumentUri,
                portDirection,
                portName,
                portElementId,
                field,
                newValue: trimmed
            })
        );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected highlightSelectedPort(port: any, content: HTMLElement): void {
        // Clear previous highlight
        const allPortItems = Array.from(content.querySelectorAll<HTMLElement>('.port-item, .pp-prow'));
        for (const item of allPortItems) {
            item.classList.remove('selected');
        }

        const portId = port?.id;
        const portName = port?.args?.[WorkflowDiagramMetadata.PORT_NAME] as string | undefined;

        let match: HTMLElement | undefined;
        if (portId !== undefined) {
            match = allPortItems.find(i => i.dataset.portId === String(portId));
        }
        if (!match && portName) {
            match = allPortItems.find(i => i.dataset.portName === String(portName));
        }

        if (match) {
            match.classList.add('selected');
            // Keep the selected port visible without jumping the panel.
            match.scrollIntoView({ block: 'nearest' });
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected buildDefinitionAnnotationsSection(
        elementId: string,
        args: any,
        emptyText?: string,
        requestAgentDiscovery = true
    ): HTMLElement {
        const defAnnotations = (args?.[WorkflowDiagramMetadata.ENTITY_DEFINITION_ANNOTATIONS] as any[]) || [];

        const annSection = createPropertySection(
            Array.isArray(defAnnotations) ? `Annotations (${defAnnotations.length})` : 'Annotations',
            { collapsed: !Array.isArray(defAnnotations) || defAnnotations.length === 0 }
        );
        const annHeader = annSection.querySelector('.property-section-header');
        if (annHeader) {
            const actions = document.createElement('div');
            actions.className = 'section-actions';

            for (const editor of this.annotationEditors()) {
                const quickAdd = editor.quickAdd;
                if (!quickAdd) {
                    continue;
                }
                const addBtn = document.createElement('button');
                addBtn.type = 'button';
                addBtn.className = 'mini-btn';
                addBtn.title = quickAdd.title;
                addBtn.textContent = quickAdd.label;
                addBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    void this.actionDispatcher.dispatch(
                        WorkflowUpdateDefinitionAnnotationOperation.create({
                            isOperation: true,
                            elementId,
                            action: 'upsert',
                            annotationName: editor.annotationName,
                            annotationText: quickAdd.annotationText
                        })
                    );
                });
                actions.appendChild(addBtn);
            }

            const wizardBtn = document.createElement('button');
            wizardBtn.type = 'button';
            wizardBtn.className = 'mini-btn';
            wizardBtn.title = 'Open the annotation wizard';
            wizardBtn.textContent = 'Wizard…';
            wizardBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                void this.actionDispatcher.dispatch({
                    kind: WorkflowEditAnnotationsAction.KIND,
                    elementId
                } as any);
            });

            actions.appendChild(wizardBtn);
            annHeader.appendChild(actions);
        }

        const annContent = annSection.querySelector('.property-section-content');
        if (annContent) {
            const list = document.createElement('div');
            list.className = 'annotation-list';

            const annotations = Array.isArray(defAnnotations) ? defAnnotations : [];
            if (annotations.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'annotation-empty';
                empty.textContent = emptyText ?? 'No annotations on the referenced definition.';
                annContent.appendChild(empty);
            } else {
                for (const a of annotations) {
                    const name = (a?.name as string) ?? '';
                    if (!name) {
                        continue;
                    }

                    const argsArr = (a?.arguments as any[]) ?? [];
                    const argsMap = new Map<string, string>();
                    // What the producer works out and the class does not write
                    // (a source's port): shown, never written back.
                    const derivedArgs: Array<[string, string]> = [];
                    for (const arg of argsArr) {
                        if (arg?.name) {
                            const entry: [string, string] = [String(arg.name), String(arg.value ?? '').trim()];
                            if (arg.derived === true) {
                                derivedArgs.push(entry);
                            } else {
                                argsMap.set(...entry);
                            }
                        }
                    }
                    // An annotation the class does not write (the viewer of a
                    // source): nothing on the class to save or remove.
                    if (a?.derived === true) {
                        list.appendChild(this.derivedAnnotationItem(name, [...argsMap.entries(), ...derivedArgs],
                            'Not written on the class: worked out from it. Nothing here to save or remove.'));
                        continue;
                    }

                    const editor = this.annotationEditorFor(name);

                    const item = document.createElement('div');
                    item.className = 'annotation-item';

                    const header = document.createElement('div');
                    header.className = 'annotation-header';

                    const title = document.createElement('div');
                    title.className = 'annotation-title';
                    title.textContent = `@${name}`;

                    const btns = document.createElement('div');
                    btns.className = 'annotation-actions';

                    const removeBtn = document.createElement('button');
                    removeBtn.type = 'button';
                    removeBtn.className = 'mini-btn danger';
                    removeBtn.title = 'Remove this annotation';
                    removeBtn.textContent = 'Remove';
                    removeBtn.addEventListener('click', () => {
                        void this.actionDispatcher.dispatch(
                            WorkflowUpdateDefinitionAnnotationOperation.create({
                                isOperation: true,
                                elementId,
                                action: 'remove',
                                annotationName: name
                            })
                        );
                    });

                    // What the source has, as the producer gave it: only these can be removed.
                    const loadedArgs = new Map(argsMap);
                    // The card as drawn: Save sends what differs. Until the editor has drawn
                    // it (a save it makes while drawing), that is what was loaded.
                    let shownArgs = new Map(argsMap);

                    const saveBtn = document.createElement('button');
                    saveBtn.type = 'button';
                    saveBtn.className = 'mini-btn';
                    saveBtn.title = 'Save changes to the referenced definition';
                    saveBtn.textContent = 'Save';
                    let saveLabelTimer: ReturnType<typeof setTimeout> | undefined;
                    saveBtn.addEventListener('click', () => {
                        // An editor's GUI-only arguments are its own state, not
                        // parameters: neither the text nor the updates carry them.
                        const guiOnlyKeys = new Set(editor?.guiOnlyArgs ?? []);
                        const pairs = Array.from(argsMap.entries())
                            .map(([k, v]) => [String(k ?? '').trim(), String(v ?? '').trim()] as const)
                            .filter(([k, v]) => k !== '' && v !== '' && !guiOnlyKeys.has(k));

                        const text = editor?.formatAnnotation
                            ? editor.formatAnnotation(argsMap, pairs)
                            : this.annotationTextOf(name, pairs);

                        // An editor that merges sends what the card changed beside the text:
                        // the arguments set or edited since it was drawn, and the ones it
                        // cleared. The server keeps every other argument as the source has
                        // it, so a value the card only showed (a default it was given) is
                        // not written, and nothing changed is nothing sent.
                        if (editor?.mergeArgUpdates) {
                            const { argUpdates, argRemovals } = changedArgs(loadedArgs, shownArgs, pairs, guiOnlyKeys);
                            if (Object.keys(argUpdates).length === 0 && argRemovals.length === 0) {
                                // Said where the click was, not silently dropped.
                                saveBtn.textContent = 'No changes';
                                clearTimeout(saveLabelTimer);
                                saveLabelTimer = setTimeout(() => { saveBtn.textContent = 'Save'; }, NOTHING_TO_SAVE_MS);
                                return;
                            }
                            void this.actionDispatcher.dispatch(
                                WorkflowUpdateDefinitionAnnotationOperation.create({
                                    isOperation: true,
                                    elementId,
                                    action: 'upsert',
                                    annotationName: name,
                                    annotationText: text,
                                    argUpdates,
                                    // Only when there is one: a producer older than removals
                                    // still takes every other Save.
                                    ...(argRemovals.length > 0 ? { argRemovals } : {})
                                })
                            );
                        } else {
                            void this.actionDispatcher.dispatch(
                                WorkflowUpdateDefinitionAnnotationOperation.create({
                                    isOperation: true,
                                    elementId,
                                    action: 'upsert',
                                    annotationName: name,
                                    annotationText: text
                                })
                            );
                        }
                    });

                    btns.appendChild(saveBtn);
                    btns.appendChild(removeBtn);
                    header.appendChild(title);
                    header.appendChild(btns);

                    const body = document.createElement('div');
                    body.className = 'annotation-body';

                    editor?.render({
                        elementId,
                        args: argsMap,
                        body,
                        dispatcher: this.actionDispatcher,
                        root: this.lastRoot,
                        requestDiscovery: requestAgentDiscovery,
                        save: () => saveBtn.click()
                    });
                    // The card as drawn, the editor's own defaults in it. What it sets later is
                    // the user's doing (a pick, an edit), and is sent.
                    shownArgs = new Map(argsMap);

                    const reserved = new Set(editor?.reservedArgs ?? []);
                    // Remaining args = genuinely custom annotation args (no dedicated control
                    // above). Each renders as an editable key/value row with its own remove button;
                    // a full-width "+ Add Argument" affordance (matching the card editors) appends a
                    // fresh blank row. Keys already surfaced by a GUI control are reserved above and
                    // intentionally not repeated here.
                    const customArgsContainer = document.createElement('div');
                    body.appendChild(customArgsContainer);

                    const appendArgRow = (initialKey: string, initialValue: string, focusKey: boolean): void => {
                        const row = document.createElement('div');
                        row.className = 'annotation-add-row';
                        let currentKey = initialKey;

                        const keyInp = document.createElement('input');
                        keyInp.className = 'annotation-input annotation-add-key';
                        keyInp.placeholder = 'argName';
                        keyInp.value = initialKey;

                        const valInp = document.createElement('input');
                        valInp.className = 'annotation-input annotation-add-value';
                        valInp.placeholder = 'value (expression)';
                        valInp.value = initialValue;

                        const commit = (): void => {
                            const newKey = keyInp.value.trim();
                            // Renaming the key moves the binding; clearing it removes the arg.
                            if (currentKey && currentKey !== newKey) argsMap.delete(currentKey);
                            currentKey = newKey;
                            if (newKey) argsMap.set(newKey, valInp.value);
                        };
                        keyInp.addEventListener('input', commit);
                        valInp.addEventListener('input', commit);

                        const rm = document.createElement('button');
                        rm.type = 'button';
                        rm.className = 'mini-btn icon-only danger';
                        rm.innerHTML = '<span class="codicon codicon-close"></span>';
                        rm.title = 'Remove this argument';
                        rm.setAttribute('aria-label', 'Remove this argument');
                        rm.addEventListener('click', () => { if (currentKey) argsMap.delete(currentKey); row.remove(); });

                        row.appendChild(keyInp);
                        row.appendChild(valInp);
                        row.appendChild(rm);
                        customArgsContainer.appendChild(row);
                        if (focusKey) keyInp.focus();
                    };

                    for (const [k, v] of argsMap.entries()) {
                        if (reserved.has(k)) continue;
                        appendArgRow(k, v, false);
                    }
                    if (derivedArgs.length > 0) {
                        body.appendChild(this.derivedArgumentRows(derivedArgs, 'Worked out, not written on the class: not saved with it.'));
                    }

                    const addArgBtn = document.createElement('button');
                    addArgBtn.type = 'button';
                    addArgBtn.textContent = '+ Add Argument';
                    addArgBtn.style.cssText = 'background: none; border: 1px dashed var(--vscode-panel-border, #555); color: var(--vscode-foreground); padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; width: 100%; margin-top: 8px;';
                    addArgBtn.addEventListener('click', () => appendArgRow('', '', true));
                    body.appendChild(addArgBtn);

                    item.appendChild(header);
                    item.appendChild(body);
                    list.appendChild(item);
                }

                annContent.appendChild(list);
            }
        }

        return annSection;
    }

    /**
     * A field holding source text: an input, or -- for text of several
     * lines (a triple-quoted string, a call written over lines) -- a
     * textarea, which keeps the line breaks an input would drop, so an
     * Update of it unchanged writes back what the source has. Enter commits
     * an input; in a textarea it starts a line, and Ctrl/Cmd+Enter commits.
     */
    protected sourceField(
        value: string,
        options: {
            className: string;
            fieldRef?: ReturnType<typeof createRef<HTMLInputElement | HTMLTextAreaElement>>;
            placeholder?: string;
            ariaLabel?: string;
            onInput?: () => void;
            onCommit: (e: Event) => void;
        }
    ): TemplateResult {
        const field = options.fieldRef ?? createRef<HTMLInputElement | HTMLTextAreaElement>();
        const onKeydown = (e: KeyboardEvent): void => {
            const lines = e.target instanceof HTMLTextAreaElement;
            if (e.key === 'Enter' && (!lines || e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                options.onCommit(e);
            }
        };
        if (value.includes('\n')) {
            // Its height is its rows' and room for a scroll bar under them: the
            // field's class sets a one-line control's.
            return html`<textarea ${ref(field)} class=${`${options.className} source-lines`}
                style="height: auto; padding: 4px 8px 14px;"
                rows=${Math.min(value.split('\n').length, 8)} .value=${value}
                placeholder=${options.placeholder ?? ''} aria-label=${options.ariaLabel ?? nothing}
                title="Ctrl+Enter to commit" @input=${() => options.onInput?.()} @keydown=${onKeydown}></textarea>`;
        }
        return html`<input ${ref(field)} class=${options.className} .value=${value}
            placeholder=${options.placeholder ?? ''} aria-label=${options.ariaLabel ?? nothing}
            @input=${() => options.onInput?.()} @keydown=${onKeydown} />`;
    }

    /**
     * `@name(k=v, …)`: on one line when it fits one (88 columns, the
     * common formatters' width), one argument a line otherwise.
     */
    protected annotationTextOf(name: string, pairs: ReadonlyArray<readonly [string, string]>): string {
        if (pairs.length === 0) {
            return `@${name}`;
        }
        const oneLine = `@${name}(${pairs.map(([k, v]) => `${k}=${v}`).join(', ')})`;
        if (oneLine.length <= 88 && !oneLine.includes('\n')) {
            return oneLine;
        }
        return `@${name}(\n${pairs.map(([k, v]) => `    ${k}=${v}`).join(',\n')}\n)`;
    }

    /** Arguments shown as they are, `name = value`, with what they are (`note`). */
    protected derivedArgumentRows(args: Array<[string, string]>, note: string): HTMLElement {
        const rows = document.createElement('div');
        rows.className = 'annotation-derived';
        for (const [name, value] of args) {
            const row = document.createElement('div');
            row.className = 'annotation-derived-arg';
            row.textContent = `${name} = ${value}`;
            rows.appendChild(row);
        }
        const said = document.createElement('div');
        said.className = 'annotation-derived-note';
        said.textContent = note;
        rows.appendChild(said);
        return rows;
    }

    /** An annotation the producer works out, shown with its arguments and no actions. */
    protected derivedAnnotationItem(name: string, args: Array<[string, string]>, note: string): HTMLElement {
        const item = document.createElement('div');
        item.className = 'annotation-item';
        const header = document.createElement('div');
        header.className = 'annotation-header';
        const title = document.createElement('div');
        title.className = 'annotation-title';
        title.textContent = `@${name}`;
        header.appendChild(title);
        const body = document.createElement('div');
        body.className = 'annotation-body';
        body.appendChild(this.derivedArgumentRows(args, note));
        item.appendChild(header);
        item.appendChild(body);
        return item;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected buildDefinitionParametersSection(elementId: string, args: any): HTMLElement {
        const defParams = (args?.[WorkflowDiagramMetadata.ENTITY_DEFINITION_PARAMETERS] as any[]) || [];
        const isNetworkModelInstance = this.isNetworkRuntime()
            && args?.[WorkflowDiagramMetadata.IS_NETWORK_INSTANCE] === true;

        const paramCount = Array.isArray(defParams) ? defParams.length : 0;
        const section = createPropertySection(
            isNetworkModelInstance
                ? `Network Parameters (${paramCount})`
                : `Definition Parameters (${paramCount})`,
            { collapsed: paramCount === 0 }
        );
        const content = section.querySelector('.property-section-content');
        if (!content) {
            return section;
        }

        const list = document.createElement('div');
        list.className = 'param-def-list';

        const params = Array.isArray(defParams) ? defParams : [];
        if (params.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'param-def-empty';
            empty.textContent = isNetworkModelInstance
                ? 'No parameters on the referenced network.'
                : 'No parameters on the referenced definition.';
            list.appendChild(empty);
        }

        if (isNetworkModelInstance) {
            for (const def of params) {
                const name = String(def?.name ?? '').trim();
                if (!name) {
                    continue;
                }

                const item = document.createElement('div');
                item.className = 'param-def-item';

                const header = document.createElement('div');
                header.className = 'param-def-header';

                const nameValue = document.createElement('div');
                nameValue.className = 'param-def-input read-only';
                nameValue.textContent = name;
                header.appendChild(nameValue);
                item.appendChild(header);

                if (def?.type) {
                    const fields = document.createElement('div');
                    fields.className = 'param-def-fields';

                    const typeField = document.createElement('div');
                    typeField.className = 'param-def-field';
                    const typeLabel = document.createElement('div');
                    typeLabel.className = 'param-def-label';
                    typeLabel.textContent = 'type';
                    const typeValue = document.createElement('div');
                    typeValue.className = 'param-def-input read-only';
                    typeValue.textContent = String(def.type);
                    typeField.appendChild(typeLabel);
                    typeField.appendChild(typeValue);
                    fields.appendChild(typeField);
                    item.appendChild(fields);
                }

                list.appendChild(item);
            }

            content.appendChild(list);
            return section;
        }

        // Editable definition editor (runtime-specific entities): same toolkit
        // editor + expanding add as the network case.
        const rows = params
            .map((def: any) => ({
                name: String(def?.name ?? '').trim(),
                type: String(def?.type ?? ''),
                default: String(def?.defaultValue ?? '')
            }))
            .filter((row) => row.name !== '');
        return this.litSection(
            `Definition Parameters (${rows.length})`,
            {
                body: this.definitionParamEditorBody(elementId, rows, 'No parameters on the referenced definition.'),
                collapsed: rows.length === 0
            }
        );
    }

    /**
     * Real definition-parameter editor for a network model. Sources params from
     * ENTITY_PARAMETERS (the factory signature: name + type + value) and renders the
     * shared `definitionParamEditorBody`.
     */
    protected buildNetworkDefinitionParamsSection(elementId: string, args: Record<string, unknown>): HTMLElement {
        const params = this.normalizeEditableEntityParameters(args[WorkflowDiagramMetadata.ENTITY_PARAMETERS]);
        const rows = params.map((p) => ({ name: p.name, type: p.detailText ?? '', default: p.inputValue }));
        return this.litSection(
            `Network Parameters (${params.length})`,
            { body: this.definitionParamEditorBody(elementId, rows) }
        );
    }

    /**
     * Shared definition-parameter editor body (used by the network editor and the
     * generic definition-parameters section). Each param is an editable
     * `name : type = default` row committing the whole signature param via
     * `updateDefinitionParameter` (which rewrites `def <entity>(...)`); Save surfaces
     * only when the row is dirty. Below the list, an expanding "+ Add parameter"
     * affordance appends a new param. Remove is intentionally omitted (the edit backend
     * rejects it as not-implemented).
     */
    protected definitionParamEditorBody(
        elementId: string,
        rows: Array<{ name: string; type: string; default: string }>,
        emptyText = 'No parameters yet.'
    ): TemplateResult {
        const isIdentifier = (name: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
        const upsert = (parameterName: string, name: string, type: string, defaultValue: string): boolean => {
            if (!name) {
                VscodeUi.instance.infoMessage('Parameter name is required.');
                return false;
            }
            if (!isIdentifier(name)) {
                VscodeUi.instance.infoMessage('Parameter name must be a valid identifier.');
                return false;
            }
            void this.actionDispatcher.dispatch(
                WorkflowUpdateDefinitionParameterOperation.create({
                    isOperation: true,
                    elementId,
                    action: 'upsert',
                    parameterName,
                    parameterText: this.buildParameterDefinitionText(name, type, defaultValue)
                })
            );
            return true;
        };

        const paramRows = rows.map((original) => {
            const nameRef = createRef<HTMLInputElement>();
            const typeRef = createRef<HTMLInputElement>();
            const defRef = createRef<HTMLInputElement | HTMLTextAreaElement>();
            const rowRef = createRef<HTMLDivElement>();
            const markDirty = (): void => {
                const dirty =
                    (nameRef.value?.value ?? '') !== original.name ||
                    (typeRef.value?.value ?? '') !== original.type ||
                    (defRef.value?.value ?? '') !== original.default;
                rowRef.value?.classList.toggle('dirty', dirty);
            };
            const commit = (): void => {
                upsert(
                    original.name,
                    (nameRef.value?.value ?? '').trim(),
                    (typeRef.value?.value ?? '').trim(),
                    (defRef.value?.value ?? '').trim()
                );
            };
            const onKeydown = (e: KeyboardEvent): void => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    commit();
                }
            };
            return html`
                <div ${ref(rowRef)} class="pp-defparam-row" data-name=${original.name}>
                    <input ${ref(nameRef)} class="pp-defparam-name" .value=${original.name}
                        aria-label="name" @input=${markDirty} @keydown=${onKeydown} />
                    <span class="pp-defparam-sep">:</span>
                    <input ${ref(typeRef)} class="pp-defparam-type" .value=${original.type}
                        placeholder="type" aria-label="type" @input=${markDirty} @keydown=${onKeydown} />
                    <span class="pp-defparam-sep">=</span>
                    ${this.sourceField(original.default, {
                        className: 'pp-defparam-default',
                        fieldRef: defRef,
                        placeholder: 'default',
                        ariaLabel: 'default',
                        onInput: markDirty,
                        onCommit: commit
                    })}
                    <button class="mini-btn primary pp-defparam-save" type="button"
                        title="Save (Enter)" @click=${commit}>Save</button>
                </div>
            `;
        });

        // "+ Add parameter": a dashed ghost button that expands in place into a small form.
        const addBtnRef = createRef<HTMLButtonElement>();
        const addFormRef = createRef<HTMLDivElement>();
        const addNameRef = createRef<HTMLInputElement>();
        const addTypeRef = createRef<HTMLInputElement>();
        const addDefRef = createRef<HTMLInputElement>();
        const showForm = (show: boolean): void => {
            addFormRef.value?.toggleAttribute('hidden', !show);
            addBtnRef.value?.toggleAttribute('hidden', show);
            if (show) {
                addNameRef.value?.focus();
            }
        };
        const addCommit = (): void => {
            const name = (addNameRef.value?.value ?? '').trim();
            if (upsert(name, name, (addTypeRef.value?.value ?? '').trim(), (addDefRef.value?.value ?? '').trim())) {
                showForm(false);
            }
        };

        // Live name filter (only worth showing past a handful of params, e.g. MPEG4's 19).
        const listRef = createRef<HTMLDivElement>();
        const onFilter = (e: Event): void => {
            const q = ((e.target as HTMLInputElement).value ?? '').trim().toLowerCase();
            listRef.value?.querySelectorAll<HTMLElement>('.pp-defparam-row').forEach((row) => {
                const name = (row.getAttribute('data-name') ?? '').toLowerCase();
                row.hidden = q !== '' && !name.includes(q);
            });
        };

        return html`
            ${rows.length > 8
                ? html`<input class="pp-defparam-filter" type="search" placeholder="Filter parameters…"
                      aria-label="Filter parameters" @input=${onFilter} />`
                : nothing}
            <div ${ref(listRef)} class="pp-defparam-list">
                ${rows.length === 0 ? html`<div class="param-def-empty">${emptyText}</div>` : nothing}
                ${paramRows}
            </div>
            <button ${ref(addBtnRef)} class="pp-add-param-btn" type="button" @click=${() => showForm(true)}>
                <span class="codicon codicon-add"></span> Add parameter
            </button>
            <div ${ref(addFormRef)} class="pp-add-param-form" hidden>
                <input ${ref(addNameRef)} class="pp-defparam-name" placeholder="name" aria-label="new parameter name"
                    @keydown=${(e: KeyboardEvent) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            addCommit();
                        } else if (e.key === 'Escape') {
                            showForm(false);
                        }
                    }} />
                <input ${ref(addTypeRef)} class="pp-defparam-type" placeholder="type (optional)" aria-label="new parameter type" />
                <input ${ref(addDefRef)} class="pp-defparam-default" placeholder="default (optional)" aria-label="new parameter default" />
                <div class="pp-add-param-actions">
                    <button class="mini-btn" type="button" @click=${() => showForm(false)}>Cancel</button>
                    <button class="mini-btn primary" type="button" @click=${addCommit}>Add</button>
                </div>
            </div>
        `;
    }

    /**
     * The producer's editable fields (producer-fields.ts): each committed on its
     * own, a select on change, an input on Enter or when it loses focus, and
     * only when the value actually changed.
     */
    protected buildProducerFieldsSection(elementId: string, fields: ProducerField[]): HTMLElement {
        const commit = (field: ProducerField, next: string): void => {
            if (next === field.value) {
                return;
            }
            void this.actionDispatcher.dispatch(
                WorkflowUpdateEntityParameterOperation.create({ elementId, parameterName: field.name, newValue: next })
            );
        };
        const rows = fields.map((field) => {
            const listId = `pp-field-${elementId}-${field.name}`.replace(/[^A-Za-z0-9_-]/g, '_');
            const editor = field.choices
                ? html`<select class="param-map-input pp-field-select" @change=${(e: Event) => commit(field, (e.target as HTMLSelectElement).value)}>
                      ${field.value === '' ? html`<option value="" selected>(unset)</option>` : nothing}
                      ${field.choices.map((choice) => html`<option value=${choice} ?selected=${choice === field.value}>${choice}</option>`)}
                  </select>`
                : html`<input
                      class="param-map-input"
                      data-commits-on="change"
                      .value=${field.value}
                      list=${field.suggestions ? listId : nothing}
                      placeholder="(unset)"
                      @keydown=${(e: KeyboardEvent) => {
                          if (e.key === 'Enter') {
                              e.preventDefault();
                              (e.target as HTMLInputElement).blur();
                          }
                      }}
                      @change=${(e: Event) => commit(field, (e.target as HTMLInputElement).value.trim())}
                  />
                  ${field.suggestions
                      ? html`<datalist id=${listId}>${field.suggestions.map((s) => html`<option value=${s}></option>`)}</datalist>`
                      : nothing}`;
            return html`
                <div class="param-map-item pp-field">
                    <div class="param-map-key" title=${field.name}>${field.name}</div>
                    ${editor}
                </div>
                ${field.description ? html`<div class="param-map-type">${field.description}</div>` : nothing}
            `;
        });
        return this.litSection(`Fields (${fields.length})`, { body: html`<div class="param-map-list">${rows}</div>` });
    }

    protected buildEditableEntityParametersSection(elementId: string, args: Record<string, unknown>): HTMLElement | undefined {
        const raw = args[WorkflowDiagramMetadata.ENTITY_PARAMETERS];
        const entityParams = this.normalizeEditableEntityParameters(raw);
        if (entityParams.length === 0) {
            return undefined;
        }

        const isNetworkModelInstance = this.isNetworkRuntime()
            && args[WorkflowDiagramMetadata.IS_NETWORK_INSTANCE] === true;

        const dispatchUpdate = (parameterName: string, newValue: string): void =>
            void this.actionDispatcher.dispatch(
                WorkflowUpdateEntityParameterOperation.create({ elementId, parameterName, newValue })
            );

        const rows = entityParams.map((parameter) => {
            const inputRef = createRef<HTMLInputElement | HTMLTextAreaElement>();
            const commit = (): void => {
                const next = (inputRef.value?.value ?? '').trim();
                if (!next) {
                    VscodeUi.instance.infoMessage('Parameter value cannot be empty.');
                    return;
                }
                dispatchUpdate(parameter.name, next);
            };
            return html`
                <div class="param-map-item">
                    <div class="param-map-key" title=${parameter.name}>${parameter.name}</div>
                    ${this.sourceField(parameter.inputValue, { className: 'param-map-input', fieldRef: inputRef, onCommit: commit })}
                    <button class="mini-btn" type="button" @click=${commit}>Update</button>
                </div>
                ${parameter.detailText
                    ? html`<div class="param-map-type">${parameter.detailText}</div>`
                    : nothing}
            `;
        });

        const addNameRef = createRef<HTMLInputElement>();
        const addValueRef = createRef<HTMLInputElement>();
        const addCommit = (): void => {
            const parameterName = (addNameRef.value?.value ?? '').trim();
            const next = (addValueRef.value?.value ?? '').trim();
            if (!parameterName) {
                VscodeUi.instance.infoMessage('Parameter name is required.');
                return;
            }
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameterName)) {
                VscodeUi.instance.infoMessage('Parameter name must be a valid identifier.');
                return;
            }
            if (!next) {
                VscodeUi.instance.infoMessage('Parameter value cannot be empty.');
                return;
            }
            dispatchUpdate(parameterName, next);
        };

        const body = html`
            <div class="param-map-list">
                ${rows}
                <div class="param-map-add-row">
                    <input ${ref(addNameRef)} class="param-map-input" placeholder="name" />
                    <input ${ref(addValueRef)} class="param-map-input" placeholder="value (expression)" />
                    <button class="mini-btn" type="button" @click=${addCommit}>Add</button>
                </div>
            </div>
        `;

        return this.litSection(
            `${isNetworkModelInstance ? 'Network' : 'Instance'} Parameters (${entityParams.length})`,
            { body }
        );
    }

    protected normalizeEditableEntityParameters(raw: unknown): Array<{ name: string; inputValue: string; detailText?: string }> {
        if (Array.isArray(raw)) {
            return raw
                // One the producer marked editable is a field of the Fields
                // section (producer-fields.ts), with its choices: listing it
                // here too would show it twice, the second time as free text.
                .filter(entry => !(entry && typeof entry === 'object' && (entry as { editable?: unknown }).editable === true))
                .map(entry => this.normalizeEditableEntityParameterEntry(undefined, entry))
                .filter((entry): entry is { name: string; inputValue: string; detailText?: string } => entry !== undefined);
        }

        if (!raw || typeof raw !== 'object') {
            return [];
        }

        return Object.entries(raw)
            .map(([name, entry]) => this.normalizeEditableEntityParameterEntry(name, entry))
            .filter((entry): entry is { name: string; inputValue: string; detailText?: string } => entry !== undefined);
    }

    protected normalizeEditableEntityParameterEntry(
        fallbackName: string | undefined,
        raw: unknown
    ): { name: string; inputValue: string; detailText?: string } | undefined {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            const name = (fallbackName ?? '').trim();
            if (!name) {
                return undefined;
            }
            return {
                name,
                inputValue: this.formatEditableParameterValue(raw)
            };
        }

        const entry = raw as Record<string, unknown>;
        const name = typeof entry.name === 'string' && entry.name.trim() !== ''
            ? entry.name.trim()
            : (fallbackName ?? '').trim();
        if (!name) {
            return undefined;
        }

        const type = typeof entry.type === 'string' ? entry.type.trim() : '';
        const value = entry.value ?? entry.boundValue ?? entry.currentValue ?? entry.assignedValue ?? entry.defaultValue ?? entry.default;

        return {
            name,
            inputValue: this.sourceExpressionOf(entry) ?? this.formatEditableParameterValue(value),
            detailText: type || undefined
        };
    }

    /**
     * What the source writes for a parameter (`FRONT_OPTIONS`,
     * `File(path=TESTBENCH)`), when the producer says (`expression`): its
     * `value` is what that evaluated to, and written back it would replace
     * the source's text with a literal.
     */
    protected sourceExpressionOf(entry: Record<string, unknown>): string | undefined {
        const expression = entry.expression;
        return typeof expression === 'string' && expression.trim() !== '' ? expression.trim() : undefined;
    }

    protected formatEditableParameterValue(value: unknown): string {
        if (value === undefined || value === null) {
            return '';
        }
        if (typeof value === 'string') {
            return JSON.stringify(value);
        }
        if (typeof value === 'boolean') {
            return value ? 'True' : 'False';
        }
        if (typeof value === 'number' || typeof value === 'bigint') {
            return String(value);
        }
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }

    protected buildWorkflowParametersSection(elementId: string, rootArgs: Record<string, unknown>): HTMLElement | undefined {
        const factoryName = typeof rootArgs[WorkflowDiagramMetadata.NETWORK_FACTORY_NAME] === 'string'
            ? String(rootArgs[WorkflowDiagramMetadata.NETWORK_FACTORY_NAME]).trim()
            : '';
        const parameters = factoryName
            ? this.normalizeEditableWorkflowParameters(rootArgs[WorkflowDiagramMetadata.NETWORK_PARAMETERS])
            : this.normalizeWorkflowParameters(rootArgs[WorkflowDiagramMetadata.NETWORK_PARAMETERS]);
        if (parameters.length === 0) {
            return undefined;
        }

        const section = createPropertySection(`${this.isNetworkRuntime() ? 'Network' : 'Workflow'} Parameters (${parameters.length})`);
        if (!factoryName) {
            for (const parameter of parameters) {
                const value = (parameter as { valueText: string }).valueText || '(unspecified)';
                const detail = parameter.detailText ? `${value} (${parameter.detailText})` : value;
                this.addProperty(section, parameter.name, detail);
            }
            return section;
        }

        // Factory network/workflow: a real definition editor (name · type · default) on the
        // factory signature, via the shared toolkit body. The handler resolves the factory
        // name from the root args, so the same updateDefinitionParameter dispatch applies.
        const rows = parameters.map((p: any) => ({
            name: p.name,
            type: p.typeText ?? '',
            default: p.inputValue ?? ''
        }));
        return this.litSection(
            `${this.isNetworkRuntime() ? 'Network' : 'Workflow'} Parameters (${parameters.length})`,
            { body: this.definitionParamEditorBody(elementId, rows) }
        );
    }

    protected normalizeEditableWorkflowParameters(
        raw: unknown
    ): Array<{ name: string; inputValue: string; typeText: string; detailText?: string }> {
        if (Array.isArray(raw)) {
            return raw
                .map(entry => this.normalizeEditableWorkflowParameterEntry(undefined, entry))
                .filter((entry): entry is { name: string; inputValue: string; typeText: string; detailText?: string } => entry !== undefined);
        }

        if (!raw || typeof raw !== 'object') {
            return [];
        }

        return Object.entries(raw)
            .map(([name, entry]) => this.normalizeEditableWorkflowParameterEntry(name, entry))
            .filter((entry): entry is { name: string; inputValue: string; typeText: string; detailText?: string } => entry !== undefined);
    }

    protected normalizeEditableWorkflowParameterEntry(
        fallbackName: string | undefined,
        raw: unknown
    ): { name: string; inputValue: string; typeText: string; detailText?: string } | undefined {
        const normalized = this.normalizeWorkflowParameterEntry(fallbackName, raw);
        if (!normalized) {
            return undefined;
        }

        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return {
                name: normalized.name,
                inputValue: this.formatEditableParameterValue(raw),
                typeText: '',
                detailText: normalized.detailText
            };
        }

        const entry = raw as Record<string, unknown>;
        const typeText = typeof entry.type === 'string' ? entry.type.trim() : '';
        return {
            name: normalized.name,
            inputValue: this.signatureDefaultOf(entry),
            typeText,
            detailText: normalized.detailText
        };
    }

    /**
     * The default a factory's signature declares for a parameter, as the
     * signature writes it: its `defaultValue` (source text); none for one the
     * producer says is `required`. A producer that names no defaults gives
     * only the value the instance was made with, which is what was shown.
     */
    protected signatureDefaultOf(entry: Record<string, unknown>): string {
        if (typeof entry.defaultValue === 'string') {
            return entry.defaultValue;
        }
        if (entry.required === true) {
            return '';
        }
        const value = entry.value ?? entry.boundValue ?? entry.currentValue ?? entry.assignedValue ?? entry.defaultValue ?? entry.default;
        return this.formatEditableParameterValue(value);
    }

    protected normalizeWorkflowParameters(raw: unknown): Array<{ name: string; valueText: string; detailText?: string }> {
        if (Array.isArray(raw)) {
            return raw
                .map(entry => this.normalizeWorkflowParameterEntry(undefined, entry))
                .filter((entry): entry is { name: string; valueText: string; detailText?: string } => entry !== undefined);
        }

        if (!raw || typeof raw !== 'object') {
            return [];
        }

        return Object.entries(raw)
            .map(([name, entry]) => this.normalizeWorkflowParameterEntry(name, entry))
            .filter((entry): entry is { name: string; valueText: string; detailText?: string } => entry !== undefined);
    }

    protected normalizeWorkflowParameterEntry(
        fallbackName: string | undefined,
        raw: unknown
    ): { name: string; valueText: string; detailText?: string } | undefined {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            const name = (fallbackName ?? '').trim();
            if (!name) {
                return undefined;
            }
            return {
                name,
                valueText: this.formatWorkflowParameterValue(raw)
            };
        }

        const entry = raw as Record<string, unknown>;
        const name = typeof entry.name === 'string' && entry.name.trim() !== ''
            ? entry.name.trim()
            : (fallbackName ?? '').trim();
        if (!name) {
            return undefined;
        }

        const type = typeof entry.type === 'string' ? entry.type.trim() : '';
        const defaultValue = this.formatWorkflowParameterValue(entry.defaultValue ?? entry.default);
        const valueText = this.formatWorkflowParameterValue(
            entry.value ?? entry.boundValue ?? entry.currentValue ?? entry.assignedValue
        );

        const detailParts: string[] = [];
        if (type) {
            detailParts.push(type);
        }
        if (defaultValue) {
            detailParts.push(`default ${defaultValue}`);
        }

        return {
            name,
            valueText: valueText || defaultValue || this.formatWorkflowParameterValue(raw),
            detailText: detailParts.length > 0 ? detailParts.join(', ') : undefined
        };
    }

    protected formatWorkflowParameterValue(value: unknown): string {
        if (value === undefined || value === null) {
            return '';
        }
        if (typeof value === 'string') {
            return value;
        }
        if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
            return String(value);
        }
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected updateContentForNetwork(root: any, content: HTMLElement): void {
        const rootArgs = root?.args ?? {};
        const usesNetworkModel = this.isNetworkRuntime();
        const workflowName = (rootArgs as Record<string, unknown>)[WorkflowDiagramMetadata.NETWORK_NAME] as string | undefined
            ?? (rootArgs as Record<string, unknown>)['wf:workflowName'] as string | undefined;
        const factoryName = (rootArgs as Record<string, unknown>)[WorkflowDiagramMetadata.NETWORK_FACTORY_NAME] as string | undefined;
        const referencedUri = (rootArgs as Record<string, unknown>)['wf:workflowSourceUri'] as string | undefined
            ?? (rootArgs as Record<string, unknown>)[WorkflowDiagramMetadata.REFERENCED_URI] as string | undefined;

        // A view the producer marked read-only (an actor's automaton, a
        // projection of a file) is not the network or workflow the editing
        // sections below edit: it is named and described, nothing more.
        const readOnly = isReadOnlyView(root);
        const basicSection = createPropertySection(readOnly ? 'View' : usesNetworkModel ? 'Network' : 'Workflow');
        this.addProperty(basicSection, 'Name', workflowName ?? '(unknown)');
        if (factoryName) {
            this.addProperty(basicSection, 'Factory', factoryName);
        }
        if (referencedUri) {
            this.addProperty(basicSection, 'Source', referencedUri);
        }
        content.appendChild(basicSection);

        const rootFactsSection = this.buildFactsSection(rootArgs);
        if (rootFactsSection) {
            content.appendChild(rootFactsSection);
        }

        const graphLoadIssuesSection = this.buildGraphLoadIssuesSection(rootArgs);
        if (graphLoadIssuesSection) {
            content.appendChild(graphLoadIssuesSection);
        }
        if (readOnly) {
            return;
        }

        content.appendChild(
            this.buildDefinitionAnnotationsSection(
                root?.id ?? 'root',
                rootArgs,
                usesNetworkModel ? 'No annotations on this network.' : 'No annotations on this workflow.'
            )
        );

        const workflowParametersSection = this.buildWorkflowParametersSection(root?.id ?? 'root', rootArgs);
        if (workflowParametersSection) {
            content.appendChild(workflowParametersSection);
        }

        const boundaryInputs = this.collectElements(root, (e: any) => e?.type === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT);
        const boundaryOutputs = this.collectElements(root, (e: any) => e?.type === WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT);

        // Option B: avoid redundant counts; show the ports directly.
        content.appendChild(this.createBoundaryPortsSection('Input Ports', 'input', boundaryInputs));
        content.appendChild(this.createBoundaryPortsSection('Output Ports', 'output', boundaryOutputs));
    }

    /**
     * Facts: the labelled values a producer stated on `meta.facts`, shown in
     * its order and otherwise untouched — the platform has no opinion on what
     * a label means, so there is no key to sort by, hide or rename.
     *
     * A plain value sits beside its label; a Markdown one goes under it as a
     * block, through the same sanitized renderer the chat uses, since a value
     * worth marking up is usually several lines. Nothing when there are no
     * facts: a header announcing zero of something is not a fact either.
     *
     * Built imperatively rather than as a Lit template so it stays testable
     * against the minimal fake `document` the panel's other section tests use.
     */
    protected buildFactsSection(args: Record<string, unknown> | undefined): HTMLElement | undefined {
        const facts = this.normalizeFacts(args?.[WorkflowDiagramMetadata.FACTS]);
        if (facts.length === 0) {
            return undefined;
        }
        const section = createPropertySection(`Facts (${facts.length})`);
        const content = section.querySelector('.property-section-content') as HTMLElement | null;
        if (!content) {
            return section;
        }
        for (const fact of facts) {
            const row = document.createElement('div');
            row.className = fact.markdown ? 'pp-arow pp-fact pp-fact-block' : 'pp-arow pp-fact';
            const key = document.createElement('span');
            key.className = 'pp-akey';
            key.textContent = fact.label;
            row.appendChild(key);
            if (fact.markdown) {
                const block = document.createElement('div');
                block.className = 'pp-aval pp-fact-markdown';
                // Sanitized before this assignment. A fact's text is a
                // document's, wrapped at a column: its newlines join.
                block.innerHTML = renderDocumentMarkdownSafe(fact.value);
                row.appendChild(block);
            } else {
                const val = document.createElement('span');
                val.className = 'pp-aval pp-aval-wrap';
                val.textContent = fact.value;
                row.appendChild(val);
            }
            content.appendChild(row);
        }
        return section;
    }

    /**
     * The server already dropped malformed entries; this repeats the check so
     * a root or a node whose args came from anywhere else is as safe to show.
     */
    private normalizeFacts(raw: unknown): Array<{ label: string; value: string; markdown: boolean }> {
        if (!Array.isArray(raw)) {
            return [];
        }
        const out: Array<{ label: string; value: string; markdown: boolean }> = [];
        for (const item of raw) {
            if (!item || typeof item !== 'object') {
                continue;
            }
            const { label, value, markdown } = item as Record<string, unknown>;
            if (typeof label !== 'string' || typeof value !== 'string') {
                continue;
            }
            out.push({ label, value, markdown: markdown === true });
        }
        return out;
    }

    protected buildGraphLoadIssuesSection(rootArgs: Record<string, unknown>): HTMLElement | undefined {
        const partial = rootArgs['wf:partial'] === true;
        const errors = this.normalizeGraphLoadErrors(rootArgs['wf:errors']);
        if (!partial && errors.length === 0) {
            return undefined;
        }

        const section = createPropertySection('Graph Load Issues');
        this.addProperty(section, 'Status', partial ? 'Partial graph' : 'Errors reported');
        if (errors.length === 0) {
            this.addProperty(section, 'Message', 'Graph export completed with recoverable issues.');
            return section;
        }

        for (const [index, error] of errors.entries()) {
            const location = error.file
                ? `${error.file}${typeof error.line === 'number' ? `:${error.line}${typeof error.column === 'number' ? `:${error.column}` : ''}` : ''}`
                : undefined;
            this.addProperty(
                section,
                errors.length === 1 ? 'Message' : `Issue ${index + 1}`,
                location ? `${error.message} (${location})` : error.message
            );
        }
        return section;
    }

    protected normalizeGraphLoadErrors(raw: unknown): Array<{ message: string; file?: string; line?: number; column?: number }> {
        if (!Array.isArray(raw)) {
            return [];
        }

        return raw
            .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
            .map(entry => {
                const message = typeof entry.message === 'string' ? entry.message.trim() : '';
                if (message === '') {
                    return undefined;
                }
                return {
                    message,
                    ...(typeof entry.file === 'string' && entry.file.trim() !== '' ? { file: entry.file.trim() } : {}),
                    ...(typeof entry.line === 'number' && Number.isFinite(entry.line) ? { line: entry.line } : {}),
                    ...(typeof entry.column === 'number' && Number.isFinite(entry.column) ? { column: entry.column } : {})
                };
            })
            .filter((entry): entry is { message: string; file?: string; line?: number; column?: number } => entry !== undefined);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected createBoundaryPortsSection(
        title: string,
        direction: 'input' | 'output',
        boundaryNodes: any[]
    ): HTMLElement {
        const section = createPropertySection(title, { collapsed: boundaryNodes.length === 0 });
        const header = section.querySelector('.property-section-header');
        if (header) {
            const actions = document.createElement('div');
            actions.className = 'section-actions';

            const addBtn = document.createElement('button');
            addBtn.type = 'button';
            addBtn.className = 'mini-btn icon-only';
            addBtn.title = `Add ${direction} port`;
            addBtn.setAttribute('aria-label', `Add ${direction} port`);

            const addIcon = document.createElement('span');
            addIcon.className = 'codicon codicon-add';
            addBtn.appendChild(addIcon);
            addBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                    void this.promptAndCreateBoundaryPort(direction);
            });

            actions.appendChild(addBtn);
            header.appendChild(actions);
        }

        const sectionContent = section.querySelector('.property-section-content');
        if (!sectionContent) {
            return section;
        }

        const portList = document.createElement('div');
        portList.className = 'port-list';

        for (const node of boundaryNodes) {
            const args = node.args ?? {};
            const portName = (args[WorkflowDiagramMetadata.PORT_NAME] as string) ?? 'unnamed';
            const portType = (args[WorkflowDiagramMetadata.PORT_TYPE] as string) ?? 'any';

            const item = document.createElement('div');
            item.className = `port-item boundary ${direction}`;

            const nameField = document.createElement('button');
            nameField.type = 'button';
            nameField.className = 'port-field port-name';
            nameField.title = 'Double-click to rename';
            nameField.textContent = portName;
            nameField.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                void this.actionDispatcher.dispatch({
                    kind: WorkflowPromptLabelEditAction.KIND,
                    labelId: `${node.id}_label_name`,
                    title: 'Rename Port',
                    value: portName
                } as any);
            });

            // Read-only, deliberately. This offered "Double-click to change
            // type", and the edit went out as a label edit — whose only handler
            // renames the nearest entity, i.e. the port. Changing a type renamed
            // the port to that type. The handler now refuses non-name labels, so
            // the edit would be inert instead; either way there is nothing to
            // offer until a backend op can address a boundary port by `workflow`
            // rather than by an owning `entity`.
            const typeField = document.createElement('span');
            typeField.className = 'port-field port-type';
            typeField.title = `Type: ${portType}`;
            typeField.textContent = portType;

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'mini-btn danger icon-only';
            removeBtn.title = 'Remove port';
            removeBtn.setAttribute('aria-label', 'Remove port');

            const removeIcon = document.createElement('span');
            removeIcon.className = 'codicon codicon-remove';
            removeBtn.appendChild(removeIcon);

            removeBtn.addEventListener('click', () => {
                void this.actionDispatcher.dispatch(
                    DeleteElementOperation.create([node.id])
                );
            });

            item.appendChild(nameField);
            item.appendChild(typeField);
            item.appendChild(removeBtn);
            portList.appendChild(item);
        }

        sectionContent.appendChild(portList);
        return section;
    }

    protected async promptAndCreateBoundaryPort(direction: 'input' | 'output'): Promise<void> {
        const name = await VscodeUi.instance.inputBox({
            prompt: `New ${direction} port name`
        });
        if (name === undefined) {
            return;
        }
        const portName = name.trim();
        if (!portName) {
            return;
        }

        // Offered: the type the diagram's ports have most.
        const usual = portTypesUsed(this.lastRoot as any)[0];
        const type = await VscodeUi.instance.inputBox({
            prompt: `Type for ${portName}`,
            ...(usual ? { value: usual } : {})
        });
        if (type === undefined) {
            return;
        }

        await this.actionDispatcher.dispatch(
            WorkflowCreateBoundaryPortOperation.create({
                direction,
                portName,
                portType: type.trim()
            })
        );
    }

    protected async promptAndCreateEntityPort(node: any, entityType: string, direction: 'input' | 'output'): Promise<void> {
        const kind = operationKind('createEntityPort');
        if (!kind) {
            return;
        }
        const portName = (await VscodeUi.instance.inputBox({ prompt: `New ${direction} port name` }))?.trim();
        if (!portName) {
            return;
        }
        // Offered: the type the node's own ports have most, else the diagram's.
        const usual = portTypesUsed(node)[0] ?? portTypesUsed(this.lastRoot as any)[0];
        const portType = (await VscodeUi.instance.inputBox({ prompt: `Type for ${portName}`, ...(usual ? { value: usual } : {}) }))?.trim();
        if (!portType) {
            return;
        }
        await this.actionDispatcher.dispatch({
            kind,
            isOperation: true,
            elementId: node.id,
            // Where the entity is declared: its ports are written there.
            entityDocumentUri: definitionUriOf(node),
            entityType,
            portDirection: direction,
            portName,
            portType
        } as any);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected async promptAndDeleteEntityPort(node: any, entityType: string, direction: 'input' | 'output', portName: string): Promise<void> {
        const kind = operationKind('deleteEntityPort');
        if (!kind) {
            return;
        }
        await this.actionDispatcher.dispatch({
            kind,
            isOperation: true,
            elementId: node?.id,
            entityDocumentUri: definitionUriOf(node),
            entityType,
            portDirection: direction,
            portName
        } as any);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected collectElements(root: any, predicate: (e: any) => boolean): any[] {
        const result: any[] = [];
        const visit = (el: any): void => {
            if (!el) {
                return;
            }
            if (predicate(el)) {
                result.push(el);
            }
            const children = el.children as any[] | undefined;
            if (Array.isArray(children)) {
                for (const c of children) {
                    visit(c);
                }
            }
        };
        visit(root);
        return result;
    }

    protected updateContentForEdge(edge: PropertyElement, content: HTMLElement): void {
        if (edge.type === WorkflowDiagramTypes.EDGE_TRANSITION) {
            this.updateContentForTransition(edge, content);
            return;
        }
        const sourceId = edge.sourceId || 'unknown';
        const targetId = edge.targetId || 'unknown';
        
        // The end's node and port as the reader knows them: the node's name
        // and the port's, from the model. A port id is `<node id>_port_<name>`,
        // and a node id is not always its name (two nodes sharing one take
        // the producer's ids), so the id is only the fallback.
        const parsePortId = (id: string) => {
            const port = this.lastRoot?.index?.getById?.(id) as PropertyElement | undefined;
            // An edge that ends at a group itself: the group, by its title.
            if (port?.args?.[WorkflowDiagramMetadata.GROUP_END] === true) {
                const title = readStringArg(port.parent?.args, WorkflowDiagramMetadata.GROUP_LABEL);
                return { node: title || 'group', port: 'frame' };
            }
            const portName = readStringArg(port?.args, WorkflowDiagramMetadata.PORT_NAME);
            const nodeName = readStringArg(port?.parent?.args, WorkflowDiagramMetadata.ENTITY_NAME);
            if (portName && nodeName) {
                return { node: nodeName, port: portName };
            }
            const parts = id.split('_port_');
            if (parts.length >= 2) {
                return { node: parts[0], port: parts[1] };
            }
            return { node: '?', port: id };
        };

        const sourceInfo = parsePortId(sourceId);
        const targetInfo = parsePortId(targetId);

        const body = html`
            ${ppReadonlyRow('From', `${sourceInfo.node}.${sourceInfo.port}`)}
            ${ppReadonlyRow('To', `${targetInfo.node}.${targetInfo.port}`)}
            ${ppReadonlyRow('ID', edge.id)}
        `;
        content.appendChild(this.litSection('Connection Info', { body }));

        // Queue capacity is a network-only connection attribute (lowers to MLIR `capacity(N)`).
        if (this.isNetworkRuntime()) {
            content.appendChild(this.buildEdgeQueueSection(edge));
        }
    }

    /**
     * A state of an automaton: its name, whether the automaton starts in it,
     * and what the producer says of it. It has no ports, parameters or
     * annotations to list.
     */
    protected updateContentForState(state: PropertyElement, content: HTMLElement): void {
        const args = state.args;
        const rows: TemplateResult[] = [ppReadonlyRow('Name', readStringArg(args, WorkflowDiagramMetadata.ENTITY_NAME) ?? '(no name)')];
        if (args?.[WorkflowDiagramMetadata.STATE_INITIAL] === true) {
            rows.push(ppReadonlyRow('Initial', 'the automaton starts here'));
        }
        content.appendChild(this.litSection('State', { body: html`${rows}` }));
        const facts = this.buildFactsSection(args as Record<string, unknown> | undefined);
        if (facts) {
            content.appendChild(facts);
        }
    }

    /**
     * A transition of an automaton: what takes it, the two states, where it
     * comes in its state's order and the condition it is taken under, then
     * what the producer says of it, as a node's facts.
     */
    protected updateContentForTransition(edge: PropertyElement, content: HTMLElement): void {
        const args = edge.args;
        const from = readStringArg(args, 'wf:from') ?? '';
        const to = readStringArg(args, 'wf:to') ?? '';
        const order = readNumberArg(args, WorkflowDiagramMetadata.TRANSITION_ORDER);
        const condition = readStringArg(args, WorkflowDiagramMetadata.TRANSITION_CONDITION);
        const rows: TemplateResult[] = [
            ppReadonlyRow('Label', readStringArg(args, WorkflowDiagramMetadata.EDGE_LABEL) ?? ''),
            ppReadonlyRow('From', from),
            ppReadonlyRow('To', to === from ? `${to} (stays)` : to)
        ];
        if (order !== undefined) {
            rows.push(ppReadonlyRow('Order', String(order)));
        }
        if (condition) {
            rows.push(ppReadonlyRow('Condition', condition));
        }
        content.appendChild(this.litSection('Transition', { body: html`${rows}` }));
        const facts = this.buildFactsSection(args as Record<string, unknown> | undefined);
        if (facts) {
            content.appendChild(facts);
        }
    }

    /**
     * Editable "Queue" section for a network connection: shows the current capacity and
     * lets the user set or clear it. Clearing reverts to the runtime default.
     *
     * First section migrated to the typed `property-fields` toolkit — composes
     * `ppField` + `ppNumberField` instead of hand-building DOM.
     */
    protected buildEdgeQueueSection(edge: PropertyElement): HTMLElement {
        const currentCapacity = readNumberArg(edge.args, 'wf:capacity');

        const dispatchCapacity = (capacity: number | null): void => {
            void this.actionDispatcher.dispatch(
                WorkflowUpdateEdgeCapacityOperation.create({ elementId: edge.id, capacity })
            );
        };

        const control = ppNumberField({
            value: currentCapacity,
            placeholder: 'default',
            unit: 'tokens',
            ariaLabel: 'Queue capacity',
            onCommit: dispatchCapacity,
            onInvalid: () => VscodeUi.instance.infoMessage('Queue capacity must be a positive integer.'),
            onClear: currentCapacity !== undefined ? () => dispatchCapacity(null) : undefined,
            clearTitle: 'Clear capacity (revert to default)'
        });

        const hint = currentCapacity !== undefined
            ? 'Bounded queue. Clear to revert to the unbounded default.'
            : 'Unbounded by default. Set a positive size to bound the queue.';

        return this.litSection('Queue', { body: ppField('Capacity', control, hint) });
    }

    /**
     * Build a collapsible section whose body (and optional header action) is a
     * declarative Lit template. Reuses createPropertySection so collapse + chevron work.
     */
    protected litSection(
        title: string,
        opts: { headerAction?: TemplateResult; body: TemplateResult; extraClass?: string; collapsed?: boolean }
    ): HTMLElement {
        const section = createPropertySection(title, { collapsed: opts.collapsed });
        if (opts.extraClass) section.classList.add(opts.extraClass);
        if (opts.headerAction) {
            const actions = document.createElement('div');
            actions.className = 'section-actions';
            render(opts.headerAction, actions);
            section.querySelector('.property-section-header')?.appendChild(actions);
        }
        const contentEl = section.querySelector('.property-section-content') as HTMLElement | null;
        if (contentEl) render(opts.body, contentEl);
        return section;
    }

    /** Basic Info section: name, type (kind + chip), the contributions' rows, what it opens. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected buildBasicInfoSection(
        node: any,
        info: {
            entityName: string;
            typeLabel: string;
            typeBadge: string;
            isBoundary: boolean;
            isNetworkInstance: boolean;
            entityType: string;
            infoRows: readonly NodeInfoRow[];
        }
    ): HTMLElement {
        // The platform's kind of node (task, workflow) means nothing to a
        // product whose kinds are its own.
        const showType = clientBehavior().propertySections?.entityType !== false;
        // The file the node stands for, a double-click away and here a click away.
        const opens = openTargetOf(node);
        const opensPath = opens ? decodeURIComponentSafe(opens.uri.replace(/^file:\/\//, '')) : '';
        const opensRow = opens
            ? html`<div class="pp-arow">
                  <span class="pp-akey">Opens</span>
                  <span class="pp-aval pp-aval-wrap">
                      <a href=${opens.line ? `${opens.uri}#L${opens.line}` : opens.uri} title=${opensPath}
                          >${shortenPath(opensPath)}${opens.line ? `:${opens.line}` : ''}</a>
                  </span>
              </div>`
            : nothing;
        const body = html`
            <div class="pp-arow">
                <span class="pp-akey">Name</span>
                <span class="pp-aval">${info.entityName}</span>
            </div>
            ${showType
                ? html`<div class="pp-arow">
                    <span class="pp-akey">Type</span>
                    <span class="pp-aval">
                        <span>${info.typeLabel}</span>
                        <code class="pp-chip" title=${info.typeBadge}>${info.typeBadge}</code>
                    </span>
                </div>`
                : nothing}
            ${info.infoRows.map(row => html`<div class="pp-arow">
                      <span class="pp-akey">${row.label}</span>
                      <span class="pp-aval pp-aval-wrap">${row.value}</span>
                  </div>`)}
            ${opensRow}
        `;
        return this.litSection('Basic Info', { body });
    }

    /** Instance Parameters: clean cards (name + type, full-width value, update). */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected buildInstanceParametersSection(node: any, entityParams: any[], defParams: any[]): HTMLElement {
        const assigned = defParams.filter((def) => entityParams.some((p) => p.name === def.name));
        const missing = defParams.filter((def) => !assigned.includes(def));

        const commit = (paramName: string, value: string) => {
            const next = value.trim();
            if (!next) {
                VscodeUi.instance.infoMessage('Parameter value cannot be empty.');
                return;
            }
            void this.actionDispatcher.dispatch(
                WorkflowUpdateEntityParameterOperation.create({
                    elementId: node.id,
                    parameterName: paramName,
                    newValue: next,
                })
            );
        };

        const paramRow = (def: any) => {
            const given = entityParams.find((p) => p.name === def.name);
            const value = (given && this.sourceExpressionOf(given)) ?? String(given?.value ?? '');
            const onCommit = (e: Event) => {
                const inputEl = (e.target as HTMLElement)
                    .closest('.pp-arow')
                    ?.querySelector('input, textarea') as HTMLInputElement | HTMLTextAreaElement | null;
                if (inputEl) commit(def.name, inputEl.value);
            };
            return html`
                <div class="pp-arow">
                    <span class="pp-akey">
                        <span class="pp-akey-name" title=${def.name}>${def.name}</span>
                        ${def.type ? html`<span class="pp-akey-type">${def.type}</span>` : nothing}
                    </span>
                    <span class="pp-aval">
                        ${this.sourceField(value, {
                            className: 'pp-input',
                            placeholder: 'value (expression)',
                            onCommit: onCommit
                        })}
                        <button class="pp-icon-btn" title="Update" @click=${onCommit}>
                            <span class="codicon codicon-check"></span>
                        </button>
                    </span>
                </div>
            `;
        };

        const addRow = missing.length
            ? html`
                  <div class="pp-arow">
                      <span class="pp-akey">
                          <select class="pp-select pp-akey-select">
                              ${missing.map((def: any) => html`<option value=${def.name}>${def.name}</option>`)}
                          </select>
                      </span>
                      <span class="pp-aval">
                          <input class="pp-input" placeholder="value (expression)" />
                          <button
                              class="pp-icon-btn"
                              title="Add parameter"
                              @click=${(e: Event) => {
                                  const row = (e.target as HTMLElement).closest('.pp-arow');
                                  const sel = row?.querySelector('select') as HTMLSelectElement | null;
                                  const inp = row?.querySelector('input') as HTMLInputElement | null;
                                  if (sel?.value && inp) commit(sel.value, inp.value);
                              }}
                          >
                              <span class="codicon codicon-add"></span>
                          </button>
                      </span>
                  </div>
              `
            : nothing;

        const body = html`${assigned.map((def) => paramRow(def))}${addRow}`;
        return this.litSection(`Instance Parameters (${entityParams.length}/${defParams.length})`, { body });
    }

    /** Input/Output ports section with add (header) and per-row rename/retype/remove. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected buildEntityPortsSection(
        node: any,
        entityType: string,
        direction: 'input' | 'output',
        ports: any[]
    ): HTMLElement {
        const label = direction === 'input' ? 'Input Ports' : 'Output Ports';
        const headerAction = html`
            <button
                class="pp-icon-btn"
                title="Add ${direction} port"
                @click=${(e: Event) => {
                    e.stopPropagation();
                    void this.promptAndCreateEntityPort(node, entityType, direction);
                }}
            >
                <span class="codicon codicon-add"></span>
            </button>
        `;
        const body = ports.length
            ? html`
                  <div class="pp-prows">
                      ${ports.map((p: any) => {
                          const name = (p.args?.[WorkflowDiagramMetadata.PORT_NAME] as string) || 'unnamed';
                          const type = (p.args?.[WorkflowDiagramMetadata.PORT_TYPE] as string) || 'any';
                          const isArray = (p.args?.[WorkflowDiagramMetadata.IS_ARRAY_PORT] as boolean) || false;
                          return html`
                              <div
                                  class="pp-prow pp-prow-${direction}"
                                  data-port-id=${String(p.id ?? '')}
                                  data-port-name=${name}
                              >
                                  <span class="pp-pdot"></span>
                                  <button
                                      class="pp-pname"
                                      title="Double-click to rename"
                                      @dblclick=${() =>
                                          void this.promptAndUpdateEntityPort(node, entityType, direction, p, 'name', name)}
                                  >
                                      ${name}${isArray ? '[]' : ''}
                                  </button>
                                  <code
                                      class="pp-ptype"
                                      title=${type}
                                      @dblclick=${() =>
                                          void this.promptAndUpdateEntityPort(node, entityType, direction, p, 'type', type)}
                                  >
                                      ${type}
                                  </code>
                                  <button
                                      class="pp-icon-btn pp-prow-del danger"
                                      title="Remove port"
                                      @click=${() => void this.promptAndDeleteEntityPort(node, entityType, direction, name)}
                                  >
                                      <span class="codicon codicon-trash"></span>
                                  </button>
                              </div>
                          `;
                      })}
                  </div>
              `
            : html`<div class="pp-empty">No ${direction} ports.</div>`;
        return this.litSection(`${label} (${ports.length})`, {
            headerAction,
            body,
            collapsed: ports.length === 0
        });
    }

    protected addProperty(section: HTMLElement, label: string, value: string): void {
        const content = section.querySelector('.property-section-content');
        if (!content) return;
        // Render the toolkit row into a throwaway host and move the row out, so
        // every read-only row (here and in litSection bodies) shares one markup.
        const host = document.createElement('div');
        render(ppReadonlyRow(label, value), host);
        const row = host.querySelector('.property-row');
        if (row) content.appendChild(row);
    }

    private buildParameterDefinitionText(name: string, typeText: string, defaultText: string): string {
        const head = typeText ? `${name}: ${typeText}` : name;
        if (!defaultText) {
            return head;
        }
        return `${head} = ${defaultText}`;
    }
}
