import { inject, injectable, multiInject, optional, postConstruct } from 'inversify';
import { findNodeIdByGraphId } from './producer-ids';
import { ISelectionListener, IActionDispatcher, TYPES } from '@eclipse-glsp/client';
import { renderDocumentMarkdownSafe } from './markdown';
import { html, render, nothing, type TemplateResult } from 'lit';
import { createRef, ref } from 'lit/directives/ref.js';
import type { GModelRoot } from '@eclipse-glsp/sprotty';
import { CenterAction, DeleteElementOperation, SelectAction } from '@eclipse-glsp/protocol';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
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
import { type PropertyElement, readNumberArg } from './property-model';
import { PropertyPanelChrome } from './property-panel-chrome';
import { clientBehavior, operationKind } from './profile';
import { classifyLink, decodeURIComponentSafe, openTargetOf, referenceAction, type PanelLink } from './open-target';
import { producerFields, type ProducerField } from './producer-fields';
import { AnnotationEditor } from './annotation-editor';
import { lastPerKey } from './contributions';
import { NodeSectionContribution, type NodeInfoRow, type NodeSectionContext } from './node-section';
import { createPropertySection, shortenPath } from './property-section';

/**
 * IGModelRootListener interface — fire on every model root change
 * (imported as a structural type to avoid deep import path issues).
 */
export interface IGModelRootListener {
    modelRootChanged(root: Readonly<GModelRoot>): void;
}

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
    }

    /** After injection: the node sections' one-time setup. */
    @postConstruct()
    protected installNodeSections(): void {
        const host = { redrawIfShowing: (elementId: string) => this.redrawIfShowing(elementId) };
        for (const contribution of this.nodeSections()) {
            contribution.install?.(host);
        }
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    selectionChanged(root: any, selectedElements: string[]): void {
        this.lastRoot = root;

        // Always update content if panel is visible (regardless of pinned state)
        const panel = document.getElementById('property-panel');
        const isVisible = panel && !panel.classList.contains('collapsed');
        
        if (selectedElements.length === 0) {
            // Keep current property content on single-click deselection.
            // Root/workflow properties are now shown explicitly on background double-click.
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
        const content = document.getElementById('property-content');
        if (content) {
            content.innerHTML = '';

            const root = this.lastRoot;
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

        // Track the rendered node for the sections' in-place updates, and let the
        // sections prepare a selected node (not a selected port's) before it is drawn.
        if (element.type?.startsWith('node')) {
            this.lastRenderedNodeId = element.id;
            for (const contribution of this.nodeSections()) {
                contribution.prepare?.(element, this.lastRoot);
            }
        } else {
            this.lastRenderedNodeId = undefined;
        }

        if (element.type.startsWith('edge')) {
            this.updateContentForEdge(element, content);
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
        let typeLabel = isNetworkInstance
            ? (usesNetworkModel ? 'Network' : 'Workflow')
            : (isExternalTask ? 'External Task' : 'Task');
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
        if (!isBoundary && sections?.ports !== false) {
            if (inputPorts.length > 0 || entityType) {
                content.appendChild(this.buildEntityPortsSection(node, entityType, 'input', inputPorts));
            }
            if (outputPorts.length > 0 || entityType) {
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
        const entityDocumentUri = (_node?.args?.[WorkflowDiagramMetadata.REFERENCED_URI] as string | undefined) ?? undefined;

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
                    for (const arg of argsArr) {
                        if (arg?.name) {
                            argsMap.set(String(arg.name), String(arg.value ?? '').trim());
                        }
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

                    const saveBtn = document.createElement('button');
                    saveBtn.type = 'button';
                    saveBtn.className = 'mini-btn';
                    saveBtn.title = 'Save changes to the referenced definition';
                    saveBtn.textContent = 'Save';
                    saveBtn.addEventListener('click', () => {
                        // An editor's GUI-only arguments are its own state, not
                        // parameters: neither the text nor the updates carry them.
                        const guiOnlyKeys = new Set(editor?.guiOnlyArgs ?? []);
                        const pairs = Array.from(argsMap.entries())
                            .map(([k, v]) => [String(k ?? '').trim(), String(v ?? '').trim()] as const)
                            .filter(([k, v]) => k !== '' && v !== '' && !guiOnlyKeys.has(k));

                        const text = editor?.formatAnnotation
                            ? editor.formatAnnotation(argsMap, pairs)
                            : (pairs.length === 0
                                ? `@${name}`
                                : `@${name}(\n${pairs
                                    .map(([k, v]) => `    ${k}=${v}`)
                                    .join(',\n')}\n)`);

                        // An editor that merges sends its arguments beside the text, so the
                        // server keeps the args the card doesn't manage (outputValidators,
                        // mcpServers inline dicts, etc.) as the source has them.
                        if (editor?.mergeArgUpdates) {
                            const mergeUpdates: Record<string, string> = Object.fromEntries(pairs);
                            void this.actionDispatcher.dispatch(
                                WorkflowUpdateDefinitionAnnotationOperation.create({
                                    isOperation: true,
                                    elementId,
                                    action: 'upsert',
                                    annotationName: name,
                                    annotationText: text,
                                    argUpdates: mergeUpdates
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
            const defRef = createRef<HTMLInputElement>();
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
                    <input ${ref(defRef)} class="pp-defparam-default" .value=${original.default}
                        placeholder="default" aria-label="default" @input=${markDirty} @keydown=${onKeydown} />
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
            const inputRef = createRef<HTMLInputElement>();
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
                    <input
                        ${ref(inputRef)}
                        class="param-map-input"
                        .value=${parameter.inputValue}
                        @keydown=${(e: KeyboardEvent) => {
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                commit();
                            }
                        }}
                    />
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
            inputValue: this.formatEditableParameterValue(value),
            detailText: type || undefined
        };
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
        const value = entry.value ?? entry.boundValue ?? entry.currentValue ?? entry.assignedValue ?? entry.defaultValue ?? entry.default;
        return {
            name: normalized.name,
            inputValue: this.formatEditableParameterValue(value),
            typeText,
            detailText: normalized.detailText
        };
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

        const basicSection = createPropertySection(usesNetworkModel ? 'Network' : 'Workflow');
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

        const type = await VscodeUi.instance.inputBox({
            prompt: `Type for ${portName} (optional, e.g. int(size=32))`
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
        const portType = (await VscodeUi.instance.inputBox({ prompt: `Type for ${portName}`, value: 'Any' }))?.trim();
        if (!portType) {
            return;
        }
        await this.actionDispatcher.dispatch({
            kind,
            isOperation: true,
            elementId: node.id,
            entityType,
            portDirection: direction,
            portName,
            portType
        } as any);
    }

    protected async promptAndDeleteEntityPort(entityType: string, direction: 'input' | 'output', portName: string): Promise<void> {
        const kind = operationKind('deleteEntityPort');
        if (!kind) {
            return;
        }
        await this.actionDispatcher.dispatch({
            kind,
            isOperation: true,
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
        const sourceId = edge.sourceId || 'unknown';
        const targetId = edge.targetId || 'unknown';
        
        // Parse source and target info (simple heuristic for now)
        // Port IDs are typically: nodeId_port_portName
        const parsePortId = (id: string) => {
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
            const value = String(entityParams.find((p) => p.name === def.name)?.value ?? '');
            const onCommit = (e: Event) => {
                const inputEl = (e.target as HTMLElement)
                    .closest('.pp-arow')
                    ?.querySelector('input') as HTMLInputElement | null;
                if (inputEl) commit(def.name, inputEl.value);
            };
            return html`
                <div class="pp-arow">
                    <span class="pp-akey">
                        <span class="pp-akey-name" title=${def.name}>${def.name}</span>
                        ${def.type ? html`<span class="pp-akey-type">${def.type}</span>` : nothing}
                    </span>
                    <span class="pp-aval">
                        <input
                            class="pp-input"
                            .value=${value}
                            placeholder="value (expression)"
                            @keydown=${(e: KeyboardEvent) => {
                                if (e.key === 'Enter') onCommit(e);
                            }}
                        />
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
                                      @click=${() => void this.promptAndDeleteEntityPort(entityType, direction, name)}
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
