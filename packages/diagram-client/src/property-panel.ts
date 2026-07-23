import { inject, injectable } from 'inversify';
import { ISelectionListener, IActionDispatcher, TYPES } from '@eclipse-glsp/client';
import {
    renderMarkdownSafe,
    renderInlineMarkdownSafe,
    looksLikeMarkdown as looksLikeMarkdownShared,
} from './markdown';
import { html, render, nothing, type TemplateResult } from 'lit';
import { createRef, ref } from 'lit/directives/ref.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import type { GModelRoot } from '@eclipse-glsp/sprotty';
import { DeleteElementOperation } from '@eclipse-glsp/protocol';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import {
    type WorkflowAgentSkill,
    type WorkflowClaudeAgentProfile,
    WorkflowShowClaudeAgentsActionHandler,
    WorkflowShowAgentSkillsActionHandler,
    WorkflowCreateBoundaryPortOperation,
    WorkflowPromptLabelEditAction,
    WorkflowRequestClaudeAgentsOperation,
    WorkflowRequestAgentSkillsOperation,
    WorkflowRequestWorkspaceEntitiesOperation,
    WorkflowEditAnnotationsAction,
    WorkflowUpdateDefinitionAnnotationOperation,
    WorkflowUpdateEntityParameterOperation,
    WorkflowUpdateDefinitionParameterOperation,
    WorkflowUpdateEntityPortOperation,
    WorkflowUpdateEdgeCapacityOperation
} from './editing-action-handlers';
import { VscodeUi } from './vscode-ui';
import { ppField, ppNumberField, ppReadonlyRow, renderInto } from './property-fields';
import { type PropertyElement, readNumberArg } from './property-model';
import { PropertyPanelChrome } from './property-panel-chrome';
import { clientBehavior, commandId, operationKind } from './profile';

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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected lastRoot: any | undefined;

    private skillRootsMode: 'all' | 'project' = 'all';

    /** Window management (show/hide/pin, docked resize, floating mode, header drag). */
    protected readonly chrome = new PropertyPanelChrome(() => this.lastRenderedNodeId);

    constructor() {
        this.initialize();
    }

    protected initialize(): void {
        this.chrome.initialize();
        this.initializeAsyncDiscoveryRefresh();
    }

    protected initializeAsyncDiscoveryRefresh(): void {
        window.addEventListener('dialogram.agentSkills.updated', (event: Event) => {
            const detail = (event as CustomEvent<{ elementId?: string }>).detail;
            const elementId = typeof detail?.elementId === 'string' ? detail.elementId : undefined;
            if (!elementId || elementId !== this.lastRenderedNodeId) {
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
        });
    }

    /**
     * Track the currently displayed node for incremental agent-context updates.
     * When the same node is re-selected and only agent context metadata changed,
     * the panel only updates the agent chat section instead of rebuilding everything.
     */
    private lastRenderedNodeId: string | undefined;
    private lastRenderedAgentHistoryJson: string | undefined;

    protected isNetworkRuntime(): boolean {
        return clientBehavior().networkPropertySections === true;
    }

    // ── IGModelRootListener ─────────────────────────────────────────────
    // Fires on EVERY model root change (SetModelAction / UpdateModelAction),
    // unlike selectionChanged which only fires when the selected set changes.
    // This is the primary mechanism that keeps the agent-context section
    // up-to-date during streaming execution.
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
        const newHistoryJson = element.args?.[WorkflowDiagramMetadata.AGENT_CHAT_HISTORY] as string | undefined;
        if (newHistoryJson !== this.lastRenderedAgentHistoryJson) {
            this.lastRenderedAgentHistoryJson = newHistoryJson;
            this.refreshAgentContext(element);
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
        this.lastRenderedAgentHistoryJson = undefined;
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

        // Track the rendered node for incremental agent-context updates. This must run BEFORE
        // priming the discovery caches below: prime keys off `lastRenderedNodeId`, so setting it
        // first means the root skills/agents snapshot is applied to the node being rendered on
        // the very first pass — otherwise a configured skill shows "not discovered" until a
        // manual Refresh.
        if (element.type?.startsWith('node')) {
            this.lastRenderedNodeId = element.id;
            this.lastRenderedAgentHistoryJson = element.args?.[WorkflowDiagramMetadata.AGENT_CHAT_HISTORY] as string | undefined;
        } else {
            this.lastRenderedNodeId = undefined;
            this.lastRenderedAgentHistoryJson = undefined;
        }

        this.primeAgentSkillsCacheFromRoot();
        this.primeClaudeAgentsCacheFromRoot();

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
            const basicSection = this.createSection('Basic Information');
            this.addProperty(basicSection, 'Type', element.type);
            this.addProperty(basicSection, 'ID', element.id);
            content.appendChild(basicSection);
        }
    }

    /**
     * Incrementally replace only the agent context section in the property panel.
     * Called during streaming when the same node is selected and only the
     * agent chat history changed.  Avoids ~50-100ms of DOM rebuild for all other
     * sections (ports, annotations, parameters, etc.).
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    /**
     * Streaming update for the agent context: re-render the lit body into the existing
     * section host so lit diffs it — preserving open `<details>`, scroll position, and
     * DOM identity — instead of tearing the whole section down each token. Builds the
     * section if it isn't present yet. Replaces the former manual remove-and-rebuild.
     */
    protected refreshAgentContext(node: any): void {
        const content = document.getElementById('property-content');
        if (!content) return;

        const args = node.args || {};
        const parsed = this.parseAgentContext(args);
        const existing = content.querySelector('.agent-context-live-section') as HTMLElement | null;

        if (!parsed) {
            existing?.remove();
            return;
        }

        if (existing) {
            const titleEl = existing.querySelector('.section-title');
            if (titleEl) titleEl.textContent = this.agentSectionTitle(parsed);
            const host = existing.querySelector('.property-section-content') as HTMLElement | null;
            if (host) {
                render(this.agentContextBody(parsed), host);
                this.scrollAgentToLatest(existing);
            }
            return;
        }

        const section = this.buildAgentContextSection(args);
        if (!section) return;
        const agentTab = content.querySelector('.property-tab-content[data-tab-id="agent"]') as HTMLElement | null;
        (agentTab ?? content).appendChild(section);
        this.scrollAgentToLatest(section);
    }

    /** Parse the agent-context args, or null when there is no (valid) chat history. */
    protected parseAgentContext(args: Record<string, unknown>): {
        chatHistory: Array<{ role: string; content: string; thinking?: string }>;
        fireCount?: number;
        contextBudget?: number;
        truncationStrategy?: string;
        agentModel?: string;
    } | null {
        const raw = args[WorkflowDiagramMetadata.AGENT_CHAT_HISTORY] as string | undefined;
        if (!raw) return null;
        try {
            const chatHistory = JSON.parse(raw) as Array<{ role: string; content: string; thinking?: string }>;
            return {
                chatHistory,
                fireCount: args[WorkflowDiagramMetadata.AGENT_FIRE_COUNT] as number | undefined,
                contextBudget: args[WorkflowDiagramMetadata.AGENT_CONTEXT_BUDGET] as number | undefined,
                truncationStrategy: args[WorkflowDiagramMetadata.AGENT_TRUNCATION_STRATEGY] as string | undefined,
                agentModel: args[WorkflowDiagramMetadata.AGENT_MODEL] as string | undefined
            };
        } catch {
            return null; // Malformed chat history JSON — skip silently.
        }
    }

    protected agentSectionTitle(parsed: { chatHistory: unknown[]; contextBudget?: number }): string {
        return `Agent Context (${parsed.chatHistory.length}${parsed.contextBudget ? '/' + parsed.contextBudget : ''})`;
    }

    /**
     * Build the live "Agent Context" section as a lit template rendered into a stable
     * section host. Single source of truth used by both the full render and the
     * streaming refresh. Returns undefined when there is no (valid) chat history.
     */
    protected buildAgentContextSection(args: Record<string, unknown>): HTMLElement | undefined {
        const parsed = this.parseAgentContext(args);
        if (!parsed) return undefined;
        const section = this.createSection(this.agentSectionTitle(parsed));
        section.classList.add('agent-context-live-section');
        const host = section.querySelector('.property-section-content') as HTMLElement | null;
        if (host) {
            render(this.agentContextBody(parsed), host);
        }
        return section;
    }

    /** The badges + chat-timeline body of the agent-context section (lit-diffed on stream). */
    protected agentContextBody(parsed: {
        chatHistory: Array<{ role: string; content: string; thinking?: string }>;
        fireCount?: number;
        contextBudget?: number;
        truncationStrategy?: string;
        agentModel?: string;
    }): TemplateResult {
        const { chatHistory, fireCount, contextBudget, truncationStrategy, agentModel } = parsed;
        return html`
            <div class="agent-ctx-badges">
                ${fireCount !== undefined ? this.agentBadge('flame', `${fireCount} firing${fireCount !== 1 ? 's' : ''}`) : nothing}
                ${agentModel ? this.agentBadge('hubot', agentModel) : nothing}
                ${truncationStrategy ? this.agentBadge('fold', truncationStrategy) : nothing}
                ${contextBudget ? this.agentBadge('graph', `${chatHistory.length}/${contextBudget} msgs`) : nothing}
            </div>
            <div class="agent-chat-container">
                ${chatHistory.map((msg) => this.agentMessageCard(msg))}
            </div>
        `;
    }

    protected agentBadge(icon: string, text: string): TemplateResult {
        return html`<span class="agent-ctx-badge"><span class="codicon codicon-${icon}"></span> ${text}</span>`;
    }

    /**
     * One chat message card. Chain-of-thought and the (collapsed-by-default) system
     * prompt are native `<details>`, so their open/closed state survives lit re-renders
     * during streaming. The message content reuses the existing imperative renderer via
     * `renderInto`, keyed on content so only a changed (streaming) message re-renders.
     */
    protected agentMessageCard(msg: { role: string; content: string; thinking?: string }): TemplateResult {
        const roleIcons: Record<string, string> = { system: 'settings-gear', user: 'arrow-right', assistant: 'comment', tool: 'tools' };
        const roleLabels: Record<string, string> = { system: 'System Prompt', user: 'Input', assistant: 'Response', tool: 'Tool Result' };
        const icon = roleIcons[msg.role] ?? 'comment';
        const label = roleLabels[msg.role] ?? msg.role;
        const isSystem = msg.role === 'system';

        const thinking = msg.thinking && msg.thinking.length > 0
            ? html`
                <details class="agent-thinking-section">
                    <summary class="agent-thinking-header">
                        <span class="agent-thinking-icon codicon codicon-lightbulb"></span>
                        <span>Chain of Thought</span>
                        <span class="agent-chat-expand-arrow codicon codicon-chevron-right"></span>
                    </summary>
                    <div class="agent-thinking-body">
                        ${this.looksLikeMarkdown(msg.thinking)
                            ? html`<div class="agent-md-content">${unsafeHTML(this.renderMarkdown(msg.thinking))}</div>`
                            : html`<div class="agent-chat-text">${msg.thinking}</div>`}
                    </div>
                </details>`
            : nothing;

        const contentBody = html`<div class="agent-chat-body-content"
            ${renderInto((el: HTMLElement) => this.renderAgentMessageContent(el, msg.content, msg.role), msg.content)}></div>`;

        if (isSystem) {
            return html`
                <details class="agent-chat-card agent-chat-system">
                    <summary class="agent-chat-header">
                        <span class="agent-chat-icon codicon codicon-${icon}"></span>
                        <span class="agent-chat-label">${label}</span>
                        <span class="agent-chat-expand-arrow codicon codicon-chevron-right"></span>
                    </summary>
                    <div class="agent-chat-body">
                        ${thinking}
                        ${contentBody}
                    </div>
                </details>`;
        }

        return html`
            <div class="agent-chat-card agent-chat-${msg.role}">
                <div class="agent-chat-header">
                    <span class="agent-chat-icon codicon codicon-${icon}"></span>
                    <span class="agent-chat-label">${label}</span>
                </div>
                <div class="agent-chat-body">
                    ${thinking}
                    ${contentBody}
                </div>
            </div>`;
    }

    protected scrollAgentToLatest(section: HTMLElement): void {
        const container = section.querySelector('.agent-chat-container');
        container?.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }

    protected createTabs(container: HTMLElement, tabs: Array<{ id: string, label: string, buildContent: (content: HTMLElement) => void }>): void {
        const header = document.createElement('div');
        header.className = 'property-tabs-header';
        
        const bodyWrap = document.createElement('div');
        bodyWrap.style.flex = '1';
        bodyWrap.style.overflowY = 'auto';

        let first = true;
        for (const tab of tabs) {
            const btn = document.createElement('button');
            btn.className = 'property-tab-btn' + (first ? ' active' : '');
            btn.textContent = tab.label;
            
            const tabContent = document.createElement('div');
            tabContent.className = 'property-tab-content' + (first ? ' active' : '');
            tabContent.dataset.tabId = tab.id;
            
            btn.addEventListener('click', () => {
                Array.from(header.querySelectorAll('.property-tab-btn')).forEach(b => b.classList.remove('active'));
                Array.from(bodyWrap.querySelectorAll('.property-tab-content')).forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                tabContent.classList.add('active');
            });
            
            tab.buildContent(tabContent);
            
            header.appendChild(btn);
            bodyWrap.appendChild(tabContent);
            first = false;
        }
        
        container.appendChild(header);
        container.appendChild(bodyWrap);
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

        // Optional configured-skill status (kept here because it also writes
        // back into args for downstream consumers).
        let skillStatus: string | undefined;
        const agentSpec = args['wf:agentSpec'] as Record<string, unknown> | undefined;
        const configuredSkill = this.extractConfiguredSkillName(agentSpec);
        if (configuredSkill) {
            const discovered = WorkflowShowAgentSkillsActionHandler.getSkillsForElement(node.id);
            const matched = discovered.find((s) => s.name === configuredSkill);
            skillStatus = matched
                ? this.describeSkillStatus(matched)
                : `Skill '${configuredSkill}' not discovered in configured roots.`;
            args[WorkflowDiagramMetadata.AGENT_SKILL_STATUS] = skillStatus;
        }

        content.appendChild(
            this.buildBasicInfoSection(node, {
                entityName,
                typeLabel,
                typeBadge,
                isBoundary,
                isNetworkInstance,
                entityType,
                skillStatus,
            })
        );

        content.appendChild(this.buildDefinitionAnnotationsSection(node.id, args, undefined, requestAgentDiscovery));

        // Agent Tools section (only rendered for @agent nodes)
        const agentToolsSection = this.buildAgentToolsSection(entityName, args);
        if (agentToolsSection) {
            content.appendChild(agentToolsSection);
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
        } else if (!hasEditableNetworkParams) {
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

        // Input / Output port sections
        if (inputPorts.length > 0 || entityType) {
            content.appendChild(this.buildEntityPortsSection(node, entityType, 'input', inputPorts));
        }
        if (outputPorts.length > 0 || entityType) {
            content.appendChild(this.buildEntityPortsSection(node, entityType, 'output', outputPorts));
        }

        // Agent Context Section — live chat history for stateful agent tasks. Built by the
        // shared builder (same one the in-place streaming update uses).
        const agentSection = this.buildAgentContextSection(args);
        if (agentSection) {
            content.appendChild(agentSection);
        }
    }

    /**
     * Render agent message content with smart formatting:
     * - JSON objects are shown as structured key-value pairs
     * - File paths are shortened to basename
     * - Long text content is collapsible
     */
    protected renderAgentMessageContent(container: HTMLElement, content: string, role: string): void {
        // Try to parse as JSON for structured rendering.
        let parsed: unknown;
        try { parsed = JSON.parse(content); } catch { /* not JSON */ }

        if (parsed && typeof parsed === 'object' && parsed !== null) {
            this.renderJsonContent(container, parsed as Record<string, unknown>, role);
            return;
        }

        // Detect markdown content and render as formatted HTML.
        if (this.looksLikeMarkdown(content)) {
            const mdDiv = document.createElement('div');
            mdDiv.className = 'agent-md-content';
            mdDiv.innerHTML = this.renderMarkdown(content);
            container.appendChild(mdDiv);
            return;
        }

        // Plain text rendering with collapse for long content.
        const maxPreviewLen = 400;
        if (content.length <= maxPreviewLen) {
            const pre = document.createElement('div');
            pre.className = 'agent-chat-text';
            pre.textContent = content;
            container.appendChild(pre);
            return;
        }

        const pre = document.createElement('div');
        pre.className = 'agent-chat-text agent-chat-collapsible';
        pre.textContent = content.slice(0, maxPreviewLen) + '…';
        let expanded = false;
        const toggle = document.createElement('button');
        toggle.className = 'agent-chat-toggle';
        toggle.textContent = 'Show more';
        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            expanded = !expanded;
            pre.textContent = expanded ? content : content.slice(0, maxPreviewLen) + '…';
            toggle.textContent = expanded ? 'Show less' : 'Show more';
        });
        container.appendChild(pre);
        container.appendChild(toggle);
    }

    /**
     * Render a JSON object as structured key-value items.
     * Handles common agent patterns like inputs/outputs/fileInputs.
     */
    protected renderJsonContent(container: HTMLElement, obj: Record<string, unknown>, role: string): void {
        // For user messages: extract the meaningful parts (inputs, task, instance).
        if (role === 'user') {
            const instance = typeof obj['instance'] === 'string' ? obj['instance'] : undefined;
            const task = typeof obj['task'] === 'string' ? obj['task'] : undefined;
            if (instance || task) {
                const metaDiv = document.createElement('div');
                metaDiv.className = 'agent-json-meta';
                if (task) { metaDiv.innerHTML += `<span class="agent-json-tag">task</span> <span class="agent-json-val">${this.escapeHtml(task)}</span>`; }
                if (instance) { metaDiv.innerHTML += `<span class="agent-json-tag">instance</span> <span class="agent-json-val">${this.escapeHtml(instance)}</span>`; }
                container.appendChild(metaDiv);
            }

            // Show inputs as key→value pills.
            const inputs = obj['inputs'] as Record<string, unknown> | undefined;
            if (inputs && typeof inputs === 'object') {
                const inputsSec = document.createElement('div');
                inputsSec.className = 'agent-json-section';
                inputsSec.innerHTML = '<div class="agent-json-section-title">Inputs</div>';
                for (const [key, val] of Object.entries(inputs)) {
                    const row = document.createElement('div');
                    row.className = 'agent-json-kv';
                    row.innerHTML = `<span class="agent-json-key">${this.escapeHtml(key)}</span>`;
                    const valSpan = document.createElement('span');
                    valSpan.className = 'agent-json-val';
                    valSpan.textContent = this.shortenPath(String(val));
                    valSpan.title = String(val);
                    row.appendChild(valSpan);
                    inputsSec.appendChild(row);
                }
                container.appendChild(inputsSec);
            }

            // Show file content if present (collapsed by default).
            const fileInputs = obj['fileInputs'] as Record<string, unknown> | undefined;
            if (fileInputs && typeof fileInputs === 'object') {
                for (const [key, fileObj] of Object.entries(fileInputs)) {
                    if (!fileObj || typeof fileObj !== 'object') continue;
                    const fc = fileObj as Record<string, unknown>;
                    const filePath = typeof fc['path'] === 'string' ? fc['path'] : undefined;
                    const fileContent = typeof fc['content'] === 'string' ? fc['content'] : undefined;
                    if (!fileContent) continue;
                    const fileDiv = document.createElement('div');
                    fileDiv.className = 'agent-json-file';
                    const fileHeader = document.createElement('button');
                    fileHeader.className = 'agent-json-file-header';
                    fileHeader.innerHTML = `<span class="agent-json-file-icon codicon codicon-file"></span> <span class="agent-json-key">${this.escapeHtml(key)}</span> <span class="agent-json-file-name">${this.escapeHtml(this.shortenPath(filePath ?? key))}</span> <span class="agent-chat-expand-arrow codicon codicon-chevron-right"></span>`;
                    const filePre = document.createElement('div');
                    filePre.className = 'agent-json-file-content';
                    filePre.textContent = fileContent;
                    filePre.style.display = 'none';
                    fileHeader.addEventListener('click', () => {
                        const visible = filePre.style.display !== 'none';
                        filePre.style.display = visible ? 'none' : 'block';
                        const arrow = fileHeader.querySelector('.agent-chat-expand-arrow');
                        if (arrow) { arrow.classList.toggle('expanded', !visible); }
                    });
                    fileDiv.appendChild(fileHeader);
                    fileDiv.appendChild(filePre);
                    container.appendChild(fileDiv);
                }
            }
            return;
        }

        // For assistant messages: detect outputs wrapper.
        if (role === 'assistant') {
            const outputs = obj['outputs'] as Record<string, unknown> | undefined;
            const target = outputs ?? obj;
            this.renderJsonTree(container, target, 0);
            return;
        }

        // Generic: render as indented tree.
        this.renderJsonTree(container, obj, 0);
    }

    /**
     * Render a JSON value as a lightweight tree with collapsible objects.
     */
    protected renderJsonTree(container: HTMLElement, value: unknown, depth: number): void {
        if (value === null || value === undefined) {
            const span = document.createElement('span');
            span.className = 'agent-json-null';
            span.textContent = 'null';
            container.appendChild(span);
            return;
        }
        if (typeof value === 'string') {
            // Detect markdown content and render as formatted HTML.
            if (this.looksLikeMarkdown(value)) {
                const mdDiv = document.createElement('div');
                mdDiv.className = 'agent-md-content';
                mdDiv.innerHTML = this.renderMarkdown(value);
                container.appendChild(mdDiv);
                return;
            }
            const span = document.createElement('span');
            span.className = 'agent-json-string';
            const truncLimit = 500;
            const display = value.length > truncLimit ? value.slice(0, truncLimit) + '…' : value;
            span.textContent = display;
            if (value.length > truncLimit) {
                span.title = 'Click to expand';
                span.style.cursor = 'pointer';
                let exp = false;
                span.addEventListener('click', () => { exp = !exp; span.textContent = exp ? value : display; });
            }
            container.appendChild(span);
            return;
        }
        if (typeof value === 'number' || typeof value === 'boolean') {
            const span = document.createElement('span');
            span.className = 'agent-json-primitive';
            span.textContent = String(value);
            container.appendChild(span);
            return;
        }
        if (Array.isArray(value)) {
            if (value.length === 0) {
                const span = document.createElement('span');
                span.className = 'agent-json-null';
                span.textContent = '[]';
                container.appendChild(span);
                return;
            }
            const list = document.createElement('div');
            list.className = 'agent-json-array';
            for (let i = 0; i < value.length; i++) {
                const item = document.createElement('div');
                item.className = 'agent-json-array-item';
                const idx = document.createElement('span');
                idx.className = 'agent-json-idx';
                idx.textContent = `${i + 1}.`;
                item.appendChild(idx);
                const val = document.createElement('span');
                val.className = 'agent-json-array-val';
                this.renderJsonTree(val, value[i], depth + 1);
                item.appendChild(val);
                list.appendChild(item);
            }
            container.appendChild(list);
            return;
        }
        if (typeof value === 'object') {
            const entries = Object.entries(value);
            const table = document.createElement('div');
            table.className = 'agent-json-object';
            for (const [k, v] of entries) {
                // Use stacked (vertical) layout for long strings or nested objects.
                const isComplex = (typeof v === 'string' && v.length > 80)
                    || (typeof v === 'object' && v !== null);
                const row = document.createElement('div');
                row.className = isComplex ? 'agent-json-kv agent-json-kv-stacked' : 'agent-json-kv';
                const keySpan = document.createElement('span');
                keySpan.className = 'agent-json-key';
                keySpan.textContent = k;
                row.appendChild(keySpan);
                const valSpan = document.createElement('div');
                valSpan.className = 'agent-json-tree-val';
                this.renderJsonTree(valSpan, v, depth + 1);
                row.appendChild(valSpan);
                table.appendChild(row);
            }
            container.appendChild(table);
        }
    }

    /**
     * Heuristic: does this string look like markdown?
     * Checks for headings, bold, lists, code fences, horizontal rules.
     */
    protected looksLikeMarkdown(text: string): boolean {
        if (text.length < 20) return false;
        return looksLikeMarkdownShared(text);
    }

    /**
     * Markdown → sanitized HTML (markdown-it + DOMPurify via the shared util).
     */
    protected renderMarkdown(md: string): string {
        return renderMarkdownSafe(md);
    }

    /**
     * Convert inline markdown (bold, italic, code, links) to sanitized HTML.
     */
    protected inlineMarkdown(text: string): string {
        return renderInlineMarkdownSafe(text);
    }

    /**
     * Shorten a file path to just the last 2 path segments for display.
     */
    protected shortenPath(p: string): string {
        const parts = p.replace(/\\/g, '/').split('/');
        if (parts.length <= 2) return p;
        return '…/' + parts.slice(-2).join('/');
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

    /**
     * Build a property-panel section for configuring agent tool-calling.
     * Shows a checkbox to enable/disable tools and a dropdown for auth mode.
     * Changes are dispatched to the extension host via NavigateToExternalTargetAction.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected buildAgentToolsSection(entityName: string, args: any): HTMLElement | null {
        const defAnnotations = (args?.[WorkflowDiagramMetadata.ENTITY_DEFINITION_ANNOTATIONS] as any[]) || [];
        const isAgent = Array.isArray(defAnnotations) && defAnnotations.some(
            (a: { name?: string }) => a?.name === 'agent'
        );
        if (!isAgent) {
            return null;
        }

        const section = this.createSection('Agent Tools');
        const sectionContent = section.querySelector('.property-section-content');
        if (!sectionContent) { return section; }

        // Container
        const container = document.createElement('div');
        container.style.display = 'flex';
        container.style.alignItems = 'center';
        container.style.justifyContent = 'space-between';
        
        // 1. Enabled Toggle
        const toggleGroup = document.createElement('div');
        toggleGroup.style.display = 'flex';
        toggleGroup.style.alignItems = 'center';
        toggleGroup.style.gap = '8px';

        const enableLabel = document.createElement('span');
        enableLabel.textContent = 'Enabled';
        enableLabel.className = 'property-label';

        const toggleWrap = document.createElement('label');
        toggleWrap.style.display = 'inline-block';
        toggleWrap.style.position = 'relative';
        toggleWrap.style.width = '32px';
        toggleWrap.style.height = '18px';
        toggleWrap.style.cursor = 'pointer';

        const enableCheckbox = document.createElement('input');
        enableCheckbox.type = 'checkbox';
        enableCheckbox.style.opacity = '0';
        enableCheckbox.style.width = '0';
        enableCheckbox.style.height = '0';

        const toggleSlider = document.createElement('span');
        toggleSlider.style.position = 'absolute';
        toggleSlider.style.top = '0';
        toggleSlider.style.left = '0';
        toggleSlider.style.right = '0';
        toggleSlider.style.bottom = '0';
        toggleSlider.style.backgroundColor = 'var(--vscode-input-background)';
        toggleSlider.style.border = '1px solid var(--vscode-input-border)';
        toggleSlider.style.transition = '.2s';
        toggleSlider.style.borderRadius = '18px';

        const toggleKnob = document.createElement('span');
        toggleKnob.style.position = 'absolute';
        toggleKnob.style.height = '12px';
        toggleKnob.style.width = '12px';
        toggleKnob.style.left = '3px';
        toggleKnob.style.bottom = '2px';
        toggleKnob.style.backgroundColor = 'var(--vscode-foreground)';
        toggleKnob.style.transition = '.2s';
        toggleKnob.style.borderRadius = '50%';
        toggleKnob.style.opacity = '0.6';

        toggleSlider.appendChild(toggleKnob);
        toggleWrap.appendChild(enableCheckbox);
        toggleWrap.appendChild(toggleSlider);

        toggleGroup.appendChild(enableLabel);
        toggleGroup.appendChild(toggleWrap);

        // 2. Auth Mode
        const authGroup = document.createElement('div');
        authGroup.style.display = 'flex';
        authGroup.style.alignItems = 'center';
        authGroup.style.gap = '6px';

        const authLabel = document.createElement('span');
        authLabel.textContent = 'Auth Mode';
        authLabel.style.fontSize = '11px';
        authLabel.style.opacity = '0.8';

        const authSelect = document.createElement('select');
        authSelect.className = 'annotation-input';
        authSelect.style.width = '100px'; 
        authSelect.style.padding = '2px 4px';
        authSelect.style.height = '22px';

        for (const opt of ['deny-all', 'allow-all', 'policy'] as const) {
            const o = document.createElement('option');
            o.value = opt;
            o.textContent = opt;
            if (opt === 'allow-all') { o.selected = true; }
            authSelect.appendChild(o);
        }

        authGroup.appendChild(authLabel);
        authGroup.appendChild(authSelect);

        container.appendChild(toggleGroup);
        container.appendChild(authGroup);
        sectionContent.appendChild(container);

        // State Management
        const updateState = () => {
            const enabled = enableCheckbox.checked;
            
            // Toggle Visuals
            if (enabled) {
                toggleSlider.style.backgroundColor = 'var(--vscode-button-background)';
                toggleKnob.style.transform = 'translateX(14px)';
                toggleKnob.style.backgroundColor = 'var(--vscode-button-foreground)';
                toggleKnob.style.opacity = '1';
            } else {
                toggleSlider.style.backgroundColor = 'var(--vscode-input-background)';
                toggleKnob.style.transform = 'translateX(0)';
                toggleKnob.style.backgroundColor = 'var(--vscode-foreground)';
                toggleKnob.style.opacity = '0.6';
            }

            // Auth Dropdown State
            authSelect.disabled = !enabled;
            authSelect.style.opacity = enabled ? '1' : '0.5';
            authLabel.style.opacity = enabled ? '0.9' : '0.5';
        };

        const dispatch = () => {
             void VscodeUi.instance.executeCommand(
                commandId('setAgentToolConfig'),
                [{ entityName, enabled: enableCheckbox.checked, auth: authSelect.value }]
            );
        };

        enableCheckbox.addEventListener('change', () => {
            updateState();
            dispatch();
        });

        authSelect.addEventListener('change', () => {
            dispatch();
        });

        // Initial State
        updateState();

        // Hydrate
        void VscodeUi.instance.executeCommand<{ enabled: boolean; auth: string }>(
            commandId('getAgentToolConfig'),
            [entityName]
        ).then(state => {
            if (state) {
                enableCheckbox.checked = state.enabled;
                if (state.auth) authSelect.value = state.auth;
                updateState();
            }
        });

        return section;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected buildDefinitionAnnotationsSection(
        elementId: string,
        args: any,
        emptyText?: string,
        requestAgentDiscovery = true
    ): HTMLElement {
        const defAnnotations = (args?.[WorkflowDiagramMetadata.ENTITY_DEFINITION_ANNOTATIONS] as any[]) || [];

        const annSection = this.createSection(
            Array.isArray(defAnnotations) ? `Annotations (${defAnnotations.length})` : 'Annotations'
        );
        const annHeader = annSection.querySelector('.property-section-header');
        if (annHeader) {
            const actions = document.createElement('div');
            actions.className = 'section-actions';

            const addExecBtn = document.createElement('button');
            addExecBtn.type = 'button';
            addExecBtn.className = 'mini-btn';
            addExecBtn.title = 'Add or update @tool annotation';
            addExecBtn.textContent = 'Add @tool';
            addExecBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                void this.actionDispatcher.dispatch(
                    WorkflowUpdateDefinitionAnnotationOperation.create({
                        isOperation: true,
                        elementId,
                        action: 'upsert',
                        annotationName: 'tool',
                        annotationText: '@tool(\n    cmd="bash",\n    args=["-lc", ""],\n    inheritStdio=true\n)'
                    })
                );
            });

            const addAgentBtn = document.createElement('button');
            addAgentBtn.type = 'button';
            addAgentBtn.className = 'mini-btn';
            addAgentBtn.title = 'Add or update @agent annotation';
            addAgentBtn.textContent = 'Add @agent';
            addAgentBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                void this.actionDispatcher.dispatch(
                    WorkflowUpdateDefinitionAnnotationOperation.create({
                        isOperation: true,
                        elementId,
                        action: 'upsert',
                        annotationName: 'agent',
                        annotationText: '@agent(\n    prompt="Transform inputs to outputs",\n    model="openai/gpt-5-mini"\n)'
                    })
                );
            });

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

            actions.appendChild(addExecBtn);
            actions.appendChild(addAgentBtn);
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
                        const pairs = Array.from(argsMap.entries())
                            .map(([k, v]) => [String(k ?? '').trim(), String(v ?? '').trim()] as const)
                            .filter(([k, v]) => k !== '' && v !== '');

                        // GUI-only display keys that are NOT valid decorator parameters.
                        const guiOnlyKeys = new Set(['useMcp', 'useLsp', 'mcpServerConfigs', 'lspServerConfigs']);

                        // Keep @tool pretty + stable ordering.
                        const text = name === 'tool'
                            ? (() => {
                                const cmd = argsMap.get('cmd')?.trim();
                                const argsExpr = argsMap.get('args')?.trim();
                                const inherit = argsMap.get('inheritStdio')?.trim() ?? argsMap.get('inherit_stdio')?.trim();

                                const ordered: Array<[string, string]> = [];
                                if (cmd) ordered.push(['cmd', cmd]);
                                if (argsExpr) ordered.push(['args', argsExpr]);
                                if (inherit) {
                                    const normalizedBool = /^(true|false)$/i.test(inherit)
                                        ? (inherit.toLowerCase() === 'true' ? 'True' : 'False')
                                        : inherit;
                                    ordered.push(['inherit_stdio', normalizedBool]);
                                }

                                for (const [k, v] of pairs) {
                                    if (k === 'cmd' || k === 'args' || k === 'inheritStdio' || k === 'inherit_stdio') continue;
                                    ordered.push([k, v]);
                                }

                                return ordered.length === 0
                                    ? '@tool'
                                    : `@tool(\n${ordered.map(([k, v]) => `    ${k}=${v}`).join(',\n')}\n)`;
                            })()
                            : name === 'agent'
                                ? (() => {
                                    const prompt = argsMap.get('prompt')?.trim();
                                    const model = argsMap.get('model')?.trim();
                                    const provider = argsMap.get('provider')?.trim();
                                    const endpoint = argsMap.get('endpoint')?.trim();
                                    const timeoutMs = argsMap.get('timeoutMs')?.trim();
                                    const contextBudget = argsMap.get('contextBudget')?.trim();
                                    const stateful = argsMap.get('stateful')?.trim();
                                    const claudeAgent = argsMap.get('claudeAgent')?.trim();
                                    const useClaudeAgent = argsMap.get('useClaudeAgent')?.trim();
                                    const skill = argsMap.get('skill')?.trim();
                                    const useSkill = argsMap.get('useSkill')?.trim();
                                    const usePrompt = argsMap.get('usePrompt')?.trim();
                                    const useSkillHooks = argsMap.get('useSkillHooks')?.trim();
                                    const truncationStrategy = argsMap.get('truncationStrategy')?.trim();
                                    const transport = argsMap.get('transport')?.trim();
                                    const cliToolsMode = argsMap.get('cliToolsMode')?.trim();
                                    const reasoningEffort = argsMap.get('reasoningEffort')?.trim();
                                    const fireableWithoutInput = argsMap.get('fireableWithoutInput')?.trim();

                                    const ordered: Array<[string, string]> = [];
                                    if (prompt) ordered.push(['prompt', prompt]);
                                    if (claudeAgent) ordered.push(['claudeAgent', claudeAgent]);
                                    if (skill) ordered.push(['skill', skill]);
                                    if (model) ordered.push(['model', model]);
                                    if (provider) ordered.push(['provider', provider]);
                                    if (endpoint) ordered.push(['endpoint', endpoint]);
                                    if (timeoutMs) ordered.push(['timeoutMs', timeoutMs]);
                                    if (contextBudget) ordered.push(['contextBudget', contextBudget]);
                                    if (stateful) ordered.push(['stateful', stateful]);
                                    if (useClaudeAgent) ordered.push(['useClaudeAgent', useClaudeAgent]);
                                    if (useSkill) ordered.push(['useSkill', useSkill]);
                                    if (usePrompt) ordered.push(['usePrompt', usePrompt]);
                                    if (useSkillHooks) ordered.push(['useSkillHooks', useSkillHooks]);
                                    if (truncationStrategy) ordered.push(['truncationStrategy', truncationStrategy]);
                                    if (transport) ordered.push(['transport', transport]);
                                    if (cliToolsMode) ordered.push(['cliToolsMode', cliToolsMode]);
                                    if (reasoningEffort) ordered.push(['reasoningEffort', reasoningEffort]);
                                    if (fireableWithoutInput) ordered.push(['fireableWithoutInput', fireableWithoutInput]);

                                    for (const [k, v] of pairs) {
                                        if (['prompt', 'claudeAgent', 'skill', 'model', 'provider', 'endpoint', 'timeoutMs', 'contextBudget', 'stateful', 'useClaudeAgent', 'useSkill', 'usePrompt', 'useSkillHooks', 'truncationStrategy', 'transport', 'cliToolsMode', 'reasoningEffort', 'fireableWithoutInput'].includes(k) || guiOnlyKeys.has(k)) continue;
                                        ordered.push([k, v]);
                                    }

                                    return ordered.length === 0
                                        ? '@agent'
                                        : `@agent(\n${ordered.map(([k, v]) => `    ${k}=${v}`).join(',\n')}\n)`;
                                })()
                            : (pairs.length === 0
                                ? `@${name}`
                                : `@${name}(\n${pairs
                                    .map(([k, v]) => `    ${k}=${v}`)
                                    .join(',\n')}\n)`);

                        // For @agent and @tool on .py files, use merge semantics so that
                        // complex args the UI doesn't manage (outputValidators, mcpServers
                        // inline dicts, etc.) are preserved from the original source.
                        if (name === 'agent' || name === 'tool') {
                            const mergeUpdates: Record<string, string> = {};
                            for (const [k, v] of pairs) {
                                if (guiOnlyKeys.has(k)) continue;
                                mergeUpdates[k] = v;
                            }
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

                    if (name === 'tool') {
                        // cmd (string)
                        const cmdRow = document.createElement('div');
                        cmdRow.className = 'annotation-field';

                        const cmdLabel = document.createElement('div');
                        cmdLabel.className = 'annotation-label';
                        cmdLabel.textContent = 'cmd (string)';

                        const cmdInput = document.createElement('input');
                        cmdInput.className = 'annotation-input';
                        cmdInput.placeholder = 'e.g. bash';
                        cmdInput.value = this.stripQuotesIfStringLiteral(argsMap.get('cmd') ?? '');
                        cmdInput.addEventListener('input', () => {
                            argsMap.set('cmd', this.toWfStringLiteral(cmdInput.value));
                        });

                        cmdRow.appendChild(cmdLabel);
                        cmdRow.appendChild(cmdInput);
                        body.appendChild(cmdRow);

                        // args (list of strings) + raw expression fallback
                        const argsContainer = document.createElement('div');
                        argsContainer.className = 'annotation-args-container';

                        const argsHeader = document.createElement('div');
                        argsHeader.className = 'annotation-args-header';

                        const argsTitle = document.createElement('div');
                        argsTitle.className = 'annotation-args-title';
                        argsTitle.textContent = 'args (list)';

                        const argsMode = document.createElement('div');
                        argsMode.className = 'annotation-args-mode';

                        const toRawBtn = document.createElement('button');
                        toRawBtn.type = 'button';
                        toRawBtn.className = 'mini-btn';
                        toRawBtn.textContent = 'Raw…';

                        const toListBtn = document.createElement('button');
                        toListBtn.type = 'button';
                        toListBtn.className = 'mini-btn';
                        toListBtn.textContent = 'List…';

                        argsMode.appendChild(toListBtn);
                        argsMode.appendChild(toRawBtn);
                        argsHeader.appendChild(argsTitle);
                        argsHeader.appendChild(argsMode);

                        const argsHelp = document.createElement('div');
                        argsHelp.className = 'annotation-args-help';
                        argsHelp.textContent = 'Each row is one CLI argument (string).';

                        const argsList = document.createElement('div');
                        argsList.className = 'annotation-args-list';

                        const addArgBtn = document.createElement('button');
                        addArgBtn.type = 'button';
                        addArgBtn.className = 'mini-btn';
                        addArgBtn.textContent = 'Add item';

                        const rawRow = document.createElement('div');
                        rawRow.className = 'annotation-field';
                        const rawLabel = document.createElement('div');
                        rawLabel.className = 'annotation-label';
                        rawLabel.textContent = 'args (expression)';
                        const rawTextarea = document.createElement('textarea');
                        rawTextarea.className = 'annotation-input annotation-textarea';
                        rawTextarea.rows = 3;
                        rawTextarea.placeholder = 'e.g. ["-lc", "{in.exe} {in.input} > {out.stdout}"]';
                        rawRow.appendChild(rawLabel);
                        rawRow.appendChild(rawTextarea);

                        let argsItems: string[] = [];
                        let mode: 'list' | 'raw' = 'list';

                        const renderArgsList = () => {
                            argsList.innerHTML = '';
                            argsItems.forEach((val, idx) => {
                                const row = document.createElement('div');
                                row.className = 'annotation-args-item';

                                const idxEl = document.createElement('div');
                                idxEl.className = 'annotation-args-index';
                                idxEl.textContent = String(idx);

                                const inp = document.createElement('input');
                                inp.className = 'annotation-input annotation-args-input';
                                inp.value = val;
                                inp.placeholder = 'argument';
                                inp.addEventListener('input', () => {
                                    argsItems[idx] = inp.value;
                                    argsMap.set('args', this.serializeWfStringListExpr(argsItems));
                                });

                                const rm = document.createElement('button');
                                rm.type = 'button';
                                rm.className = 'mini-btn danger icon-only';
                                rm.title = 'Remove item';
                                rm.setAttribute('aria-label', 'Remove item');
                                const rmIcon = document.createElement('span');
                                rmIcon.className = 'codicon codicon-remove';
                                rm.appendChild(rmIcon);
                                rm.addEventListener('click', () => {
                                    argsItems.splice(idx, 1);
                                    argsMap.set('args', this.serializeWfStringListExpr(argsItems));
                                    renderArgsList();
                                });

                                row.appendChild(idxEl);
                                row.appendChild(inp);
                                row.appendChild(rm);
                                argsList.appendChild(row);
                            });
                        };

                        const setMode = (next: 'list' | 'raw') => {
                            mode = next;
                            const showList = mode === 'list';
                            argsList.style.display = showList ? '' : 'none';
                            addArgBtn.style.display = showList ? '' : 'none';
                            argsHelp.style.display = showList ? '' : 'none';
                            rawRow.style.display = showList ? 'none' : '';
                        };

                        addArgBtn.addEventListener('click', () => {
                            argsItems.push('');
                            argsMap.set('args', this.serializeWfStringListExpr(argsItems));
                            renderArgsList();
                        });

                        rawTextarea.addEventListener('input', () => {
                            argsMap.set('args', rawTextarea.value);
                        });

                        toRawBtn.addEventListener('click', () => {
                            rawTextarea.value = argsMap.get('args') ?? '';
                            setMode('raw');
                        });

                        toListBtn.addEventListener('click', () => {
                            const parsed = this.tryParseWfStringListExpr(argsMap.get('args') ?? '');
                            if (!parsed) {
                                VscodeUi.instance.infoMessage('Cannot switch to list mode: args is not a list of string literals.');
                                setMode('raw');
                                return;
                            }
                            argsItems = parsed;
                            argsMap.set('args', this.serializeWfStringListExpr(argsItems));
                            renderArgsList();
                            setMode('list');
                        });

                        // Initialize
                        const initialArgsExpr = argsMap.get('args') ?? '';
                        const parsed = this.tryParseWfStringListExpr(initialArgsExpr);
                        if (parsed) {
                            argsItems = parsed;
                            argsMap.set('args', this.serializeWfStringListExpr(argsItems));
                            renderArgsList();
                            setMode('list');
                        } else {
                            rawTextarea.value = initialArgsExpr;
                            setMode('raw');
                        }

                        argsContainer.appendChild(argsHeader);
                        argsContainer.appendChild(argsHelp);
                        argsContainer.appendChild(argsList);
                        argsContainer.appendChild(addArgBtn);
                        argsContainer.appendChild(rawRow);
                        body.appendChild(argsContainer);

                        // inheritStdio (bool)
                        const inheritRow = document.createElement('div');
                        inheritRow.className = 'annotation-field';
                        const inheritLabel = document.createElement('div');
                        inheritLabel.className = 'annotation-label';
                        inheritLabel.textContent = 'inheritStdio (bool)';

                        const inheritWrap = document.createElement('div');
                        inheritWrap.className = 'annotation-checkbox-wrap';

                        const inherit = document.createElement('input');
                        inherit.type = 'checkbox';
                        inherit.className = 'annotation-checkbox';
                        const cur = (argsMap.get('inheritStdio') ?? '').trim().toLowerCase();
                        inherit.checked = cur === 'true';
                        argsMap.set('inheritStdio', inherit.checked ? 'true' : 'false');
                        inherit.addEventListener('change', () => {
                            argsMap.set('inheritStdio', inherit.checked ? 'true' : 'false');
                        });

                        const inheritText = document.createElement('div');
                        inheritText.className = 'annotation-checkbox-text';
                        inheritText.textContent = inherit.checked ? 'true' : 'false';
                        inherit.addEventListener('change', () => {
                            inheritText.textContent = inherit.checked ? 'true' : 'false';
                        });

                        inheritWrap.appendChild(inherit);
                        inheritWrap.appendChild(inheritText);
                        inheritRow.appendChild(inheritLabel);
                        inheritRow.appendChild(inheritWrap);
                        body.appendChild(inheritRow);
                    }

                    if (name === 'agent') {
                        const knownSkills = WorkflowShowAgentSkillsActionHandler.getSkillsForElement(elementId);
                        const knownClaudeAgents = WorkflowShowClaudeAgentsActionHandler.getAgentsForElement(elementId);
                        if (requestAgentDiscovery) {
                            void this.actionDispatcher.dispatch(
                                WorkflowRequestAgentSkillsOperation.create({
                                    elementId,
                                    rootsMode: this.skillRootsMode
                                })
                            );
                        }
                        void this.actionDispatcher.dispatch(
                            WorkflowRequestClaudeAgentsOperation.create({
                                elementId,
                            })
                        );

                        // Gather ports for IntelliSense
                        const node = this.lastRoot?.index?.getById(elementId);
                        const children = node?.children || [];
                        const ports = children.filter((c) => c.type?.startsWith('port'));
                        const inputPorts = ports.filter((p) => p.args?.[WorkflowDiagramMetadata.IS_INPUT_PORT] === true).map((p) => p.args?.[WorkflowDiagramMetadata.PORT_NAME] || 'unnamed');
                        const outputPorts = ports.filter((p) => p.args?.[WorkflowDiagramMetadata.IS_INPUT_PORT] === false).map((p) => p.args?.[WorkflowDiagramMetadata.PORT_NAME] || 'unnamed');

                        // Discovery mode is fixed to all roots for now.
                        this.skillRootsMode = 'all';

                        const createEnabledToggle = (initialChecked: boolean): { wrap: HTMLLabelElement; input: HTMLInputElement } => {
                            const wrap = document.createElement('label');
                            wrap.className = 'agent-enabled-toggle';

                            const text = document.createElement('span');
                            text.className = 'agent-enabled-text';
                            text.textContent = 'Enabled';

                            const switchWrap = document.createElement('span');
                            switchWrap.className = 'agent-enabled-switch';

                            const input = document.createElement('input');
                            input.type = 'checkbox';
                            input.className = 'agent-enabled-input';
                            input.checked = initialChecked;

                            const slider = document.createElement('span');
                            slider.className = 'agent-enabled-slider';

                            const knob = document.createElement('span');
                            knob.className = 'agent-enabled-knob';

                            slider.appendChild(knob);
                            switchWrap.appendChild(input);
                            switchWrap.appendChild(slider);
                            wrap.appendChild(text);
                            wrap.appendChild(switchWrap);

                            return { wrap, input };
                        };

                        // 0. Agent preset profile section
                        const claudeRow = document.createElement('div');
                        claudeRow.className = 'agent-skill-block';
                        const claudeHead = document.createElement('div');
                        claudeHead.className = 'agent-section-head';
                        const claudeLabel = document.createElement('div');
                        claudeLabel.textContent = 'Agent Preset';
                        claudeLabel.className = 'agent-skill-label';
                        const claudeRaw = (argsMap.get('useClaudeAgent') ?? '').trim().toLowerCase();
                        let claudeActive = claudeRaw ? claudeRaw === 'true' : false;
                        const claudeEnabledToggle = createEnabledToggle(claudeActive);
                        claudeHead.appendChild(claudeLabel);
                        claudeHead.appendChild(claudeEnabledToggle.wrap);

                        const claudeContent = document.createElement('div');
                        claudeContent.className = 'agent-section-content';

                        const claudeInput = document.createElement('input');
                        claudeInput.className = 'annotation-input';
                        claudeInput.placeholder = 'e.g. code-reviewer';
                        claudeInput.value = this.stripQuotesIfStringLiteral(argsMap.get('claudeAgent') ?? '');
                        claudeInput.addEventListener('input', () => {
                            const val = claudeInput.value.trim();
                            if (val) argsMap.set('claudeAgent', this.toWfStringLiteral(val));
                            else argsMap.delete('claudeAgent');
                        });

                        const claudeHint = document.createElement('div');
                        claudeHint.className = 'agent-skill-hint';
                        claudeHint.textContent = 'Resolved from .claude/agents/<name>.md';

                        const claudeActions = document.createElement('div');
                        claudeActions.className = 'agent-skill-actions';

                        const pickClaudeBtn = document.createElement('button');
                        pickClaudeBtn.type = 'button';
                        pickClaudeBtn.className = 'mini-btn';
                        pickClaudeBtn.textContent = 'Pick Preset';
                        pickClaudeBtn.addEventListener('click', async () => {
                            const latest = WorkflowShowClaudeAgentsActionHandler.getAgentsForElement(elementId);
                            if (latest.length === 0) {
                                VscodeUi.instance.infoMessage('No agent presets found in discovery roots.');
                                return;
                            }
                            const items = latest.map((a) => ({
                                id: a.name,
                                label: a.name,
                                description: a.description || 'No description',
                                detail: a.path,
                            }));
                            const picked = await VscodeUi.instance.quickPick({
                                items,
                                placeHolder: 'Select an agent preset'
                            });
                            if (!picked) return;
                            claudeInput.value = picked;
                            argsMap.set('claudeAgent', this.toWfStringLiteral(picked));
                            const latestMeta = latest.find((a) => a.name === picked);
                            updateClaudeStatus(latestMeta);
                        });

                        const openClaudeBtn = document.createElement('button');
                        openClaudeBtn.type = 'button';
                        openClaudeBtn.className = 'mini-btn';
                        openClaudeBtn.textContent = 'Open Preset';
                        openClaudeBtn.addEventListener('click', async () => {
                            const current = this.stripQuotesIfStringLiteral(argsMap.get('claudeAgent') ?? '').trim();
                            if (!current) {
                                VscodeUi.instance.infoMessage('Set an agent preset name first.');
                                return;
                            }
                            const latest = WorkflowShowClaudeAgentsActionHandler.getAgentsForElement(elementId);
                            const meta = latest.find((a) => a.name === current);
                            if (!meta) {
                                VscodeUi.instance.errorMessage(`Agent preset '${current}' was not found.`);
                                return;
                            }
                            const openResult = await VscodeUi.instance.executeCommand<any>('vscode.open', [meta.path]);
                            if (openResult && typeof openResult === 'object' && 'error' in openResult) {
                                VscodeUi.instance.errorMessage(`Failed to open claude agent: ${String((openResult as any).error)}`);
                            }
                        });

                        const claudeStatus = document.createElement('div');
                        claudeStatus.className = 'agent-skill-status';
                        const claudeIgnoredRow = document.createElement('div');
                        claudeIgnoredRow.className = 'agent-skill-chips';
                        const claudeWarnings = document.createElement('div');
                        claudeWarnings.className = 'agent-skill-warning';
                        claudeWarnings.style.display = 'none';

                        const addClaudeChip = (label: string, tone: 'warn' | 'info'): void => {
                            const chip = document.createElement('span');
                            chip.className = `agent-chip ${tone}`;
                            chip.textContent = tone === 'warn' ? `IGNORED ${label}` : `INFO ${label}`;
                            claudeIgnoredRow.appendChild(chip);
                        };

                        const renderClaudeWarnings = (meta: WorkflowClaudeAgentProfile | undefined): void => {
                            if (!meta || (meta.warnings?.length ?? 0) === 0) {
                                claudeWarnings.style.display = 'none';
                                claudeWarnings.textContent = '';
                                return;
                            }
                            claudeWarnings.style.display = 'block';
                            claudeWarnings.textContent = `Warning: ${(meta.warnings ?? []).join(' | ')}`;
                        };

                        const renderClaudeIgnoredFields = (meta: WorkflowClaudeAgentProfile | undefined): void => {
                            claudeIgnoredRow.innerHTML = '';
                            if (!meta) {
                                claudeIgnoredRow.style.display = 'none';
                                return;
                            }
                            const ignored = meta.ignoredFields ?? [];
                            if (ignored.length === 0) {
                                claudeIgnoredRow.style.display = 'none';
                                return;
                            }
                            claudeIgnoredRow.style.display = 'flex';
                            for (const field of ignored) {
                                addClaudeChip(field, 'warn');
                            }
                        };

                        const updateClaudeStatus = (meta: WorkflowClaudeAgentProfile | undefined): void => {
                            const current = this.stripQuotesIfStringLiteral(argsMap.get('claudeAgent') ?? '').trim();
                            if (!current) {
                                claudeStatus.textContent = 'No agent preset selected.';
                                renderClaudeIgnoredFields(undefined);
                                renderClaudeWarnings(undefined);
                                return;
                            }
                            if (!meta) {
                                claudeStatus.textContent = `Agent preset '${current}' not discovered.`;
                                renderClaudeIgnoredFields(undefined);
                                renderClaudeWarnings(undefined);
                                return;
                            }
                            claudeStatus.textContent = `${meta.description || 'No description.'}`;
                            renderClaudeIgnoredFields(meta);
                            renderClaudeWarnings(meta);
                        };

                        const syncClaudeActive = (): void => {
                            argsMap.set('useClaudeAgent', claudeActive ? 'true' : 'false');
                            claudeEnabledToggle.input.checked = claudeActive;
                            claudeInput.disabled = !claudeActive;
                            pickClaudeBtn.disabled = !claudeActive;
                            openClaudeBtn.disabled = !claudeActive;
                            claudeContent.style.display = claudeActive ? '' : 'none';
                            claudeRow.classList.toggle('disabled', !claudeActive);
                            if (!claudeActive) {
                                claudeStatus.textContent = 'Agent preset is deactivated.';
                                claudeIgnoredRow.style.display = 'none';
                                claudeWarnings.style.display = 'none';
                            } else {
                                const selected = this.stripQuotesIfStringLiteral(argsMap.get('claudeAgent') ?? '').trim();
                                const latest = WorkflowShowClaudeAgentsActionHandler.getAgentsForElement(elementId);
                                updateClaudeStatus(latest.find((a) => a.name === selected));
                            }
                        };
                        claudeEnabledToggle.input.addEventListener('change', () => {
                            claudeActive = claudeEnabledToggle.input.checked;
                            syncClaudeActive();
                        });

                        claudeActions.appendChild(pickClaudeBtn);
                        claudeActions.appendChild(openClaudeBtn);
                        claudeRow.appendChild(claudeHead);
                        claudeContent.appendChild(claudeInput);
                        claudeContent.appendChild(claudeHint);
                        claudeContent.appendChild(claudeActions);
                        claudeContent.appendChild(claudeStatus);
                        claudeContent.appendChild(claudeIgnoredRow);
                        claudeContent.appendChild(claudeWarnings);
                        claudeRow.appendChild(claudeContent);

                        const selectedClaudeName = this.stripQuotesIfStringLiteral(argsMap.get('claudeAgent') ?? '').trim();
                        updateClaudeStatus(knownClaudeAgents.find((a) => a.name === selectedClaudeName));
                        syncClaudeActive();

                        // 1. Skill section
                        const skillRow = document.createElement('div');
                        skillRow.className = 'agent-skill-block';
                        const skillHead = document.createElement('div');
                        skillHead.className = 'agent-section-head';
                        const skillLabel = document.createElement('div');
                        skillLabel.textContent = 'Skill';
                        skillLabel.className = 'agent-skill-label';
                        const skillRaw = (argsMap.get('useSkill') ?? '').trim().toLowerCase();
                        let skillActive = skillRaw ? skillRaw === 'true' : !!argsMap.get('skill');
                        const skillEnabledToggle = createEnabledToggle(skillActive);
                        skillHead.appendChild(skillLabel);
                        skillHead.appendChild(skillEnabledToggle.wrap);

                        const skillContent = document.createElement('div');
                        skillContent.className = 'agent-section-content';
                        const skillInput = document.createElement('input');
                        skillInput.className = 'annotation-input';
                        skillInput.placeholder = 'e.g. writer';
                        skillInput.style.width = '100%';
                        skillInput.style.boxSizing = 'border-box';
                        skillInput.value = this.stripQuotesIfStringLiteral(argsMap.get('skill') ?? '');
                        skillInput.addEventListener('input', () => {
                            const val = skillInput.value.trim();
                            if (val) argsMap.set('skill', this.toWfStringLiteral(val));
                            else argsMap.delete('skill');
                        });

                        const skillHint = document.createElement('div');
                        skillHint.className = 'agent-skill-hint';
                        skillHint.textContent = 'Resolved at runtime from .wf/skills/<name>/SKILL.md';

                        skillRow.appendChild(skillHead);
                        skillRow.appendChild(skillInput);
                        skillRow.appendChild(skillHint);

                        const skillActions = document.createElement('div');
                        skillActions.className = 'agent-skill-actions';

                        const skillWarn = document.createElement('div');
                        skillWarn.className = 'agent-skill-warning';
                        skillWarn.style.display = 'none';

                        const renderSkillWarning = (meta: WorkflowAgentSkill | undefined): void => {
                            const warningText = meta ? this.skillWarningSummary(meta) : '';
                            if (!warningText) {
                                skillWarn.style.display = 'none';
                                skillWarn.textContent = '';
                                return;
                            }
                            skillWarn.style.display = 'block';
                            skillWarn.textContent = `Warning: ${warningText}`;
                        };

                        const chipRow = document.createElement('div');
                        chipRow.className = 'agent-skill-chips';

                        const addChip = (label: string, tone: 'ok' | 'warn' | 'error' | 'info'): void => {
                            const chip = document.createElement('span');
                            chip.className = `agent-chip ${tone}`;
                            if (tone === 'ok') {
                                chip.textContent = `OK ${label}`;
                            } else if (tone === 'warn') {
                                chip.textContent = `WARN ${label}`;
                            } else if (tone === 'error') {
                                chip.textContent = `ERR ${label}`;
                            } else {
                                chip.textContent = `INFO ${label}`;
                            }
                            chipRow.appendChild(chip);
                        };

                        const renderSkillChips = (meta: WorkflowAgentSkill | undefined): void => {
                            chipRow.innerHTML = '';
                            const currentSkill = this.stripQuotesIfStringLiteral(argsMap.get('skill') ?? '').trim();
                            if (!currentSkill) {
                                chipRow.style.display = 'none';
                                return;
                            }
                            chipRow.style.display = 'flex';
                            if (!meta) {
                                addChip('Skill not discovered', 'error');
                                return;
                            }
                            if (!meta.hasSkillMd) {
                                addChip('SKILL.md missing', 'error');
                            }
                            const missingCount = meta.missingDeclaredHooks?.length ?? 0;
                            if (missingCount > 0) {
                                addChip(`${missingCount} missing script${missingCount > 1 ? 's' : ''}`, 'warn');
                            }
                            const warningCount = meta.warnings?.length ?? 0;
                            if (warningCount > 0) {
                                addChip(`${warningCount} parser warning${warningCount > 1 ? 's' : ''}`, 'warn');
                            }
                            addChip(`${meta.hooks.length} script hook${meta.hooks.length !== 1 ? 's' : ''}`, 'info');
                            if (meta.hasSkillMd && missingCount === 0 && warningCount === 0) {
                                addChip('Skill ready', 'ok');
                            }
                        };

                        const updateSkillStatus = (meta: WorkflowAgentSkill | undefined): void => {
                            const currentSkill = this.stripQuotesIfStringLiteral(argsMap.get('skill') ?? '').trim();
                            if (meta) {
                                skillStatus.textContent = this.describeSkillStatus(meta);
                            } else {
                                skillStatus.textContent = currentSkill
                                    ? `Skill '${currentSkill}' not discovered yet.`
                                    : 'No skill selected.';
                            }
                        };

                        const pickSkillBtn = document.createElement('button');
                        pickSkillBtn.type = 'button';
                        pickSkillBtn.className = 'mini-btn';
                        pickSkillBtn.textContent = 'Pick Skill';
                        pickSkillBtn.addEventListener('click', async () => {
                            const latest = WorkflowShowAgentSkillsActionHandler.getSkillsForElement(elementId);
                            if (latest.length === 0) {
                                VscodeUi.instance.infoMessage('No discovered skills found in .wf/.claude roots.');
                                return;
                            }
                            const items = latest.map((s) => ({
                                id: s.name,
                                label: s.name,
                                description: (s.description && s.description.trim() !== '')
                                    ? s.description
                                    : (s.hasSkillMd ? 'No description in SKILL.md' : 'missing SKILL.md'),
                                detail: `${s.root}${(s.warnings?.length ?? 0) > 0 ? ` | ${s.warnings?.join(' | ')}` : ''}`
                            }));
                            const picked = await VscodeUi.instance.quickPick({
                                items,
                                placeHolder: 'Select a skill'
                            });
                            if (!picked) return;
                            skillInput.value = picked;
                            argsMap.set('skill', this.toWfStringLiteral(picked));
                            const meta = latest.find((s) => s.name === picked);
                            updateSkillStatus(meta);
                            renderSkillChips(meta);
                            renderSkillWarning(meta);
                        });

                        const refreshSkillsBtn = document.createElement('button');
                        refreshSkillsBtn.type = 'button';
                        refreshSkillsBtn.className = 'mini-btn';
                        refreshSkillsBtn.textContent = 'Refresh';
                        refreshSkillsBtn.addEventListener('click', () => {
                            void this.actionDispatcher.dispatch(
                                WorkflowRequestAgentSkillsOperation.create({
                                    elementId,
                                    rootsMode: this.skillRootsMode
                                })
                            );
                            const currentSkill = this.stripQuotesIfStringLiteral(argsMap.get('skill') ?? '').trim();
                            const latest = WorkflowShowAgentSkillsActionHandler.getSkillsForElement(elementId);
                            const meta = latest.find((s) => s.name === currentSkill);
                            updateSkillStatus(meta);
                            renderSkillChips(meta);
                            renderSkillWarning(meta);
                        });

                        const openSkillBtn = document.createElement('button');
                        openSkillBtn.type = 'button';
                        openSkillBtn.className = 'mini-btn';
                        openSkillBtn.textContent = 'Open Skill';
                        openSkillBtn.addEventListener('click', async () => {
                            const currentSkill = this.stripQuotesIfStringLiteral(argsMap.get('skill') ?? '').trim();
                            if (!currentSkill) {
                                VscodeUi.instance.infoMessage('Set a skill name first.');
                                return;
                            }
                            const latest = WorkflowShowAgentSkillsActionHandler.getSkillsForElement(elementId);
                            let meta = latest.find((s) => s.name === currentSkill);
                            if (!meta) {
                                void this.actionDispatcher.dispatch(
                                    WorkflowRequestAgentSkillsOperation.create({
                                        elementId,
                                        rootsMode: this.skillRootsMode
                                    })
                                );
                                const refreshed = WorkflowShowAgentSkillsActionHandler.getSkillsForElement(elementId);
                                meta = refreshed.find((s) => s.name === currentSkill);
                            }
                            if (!meta || !meta.skillMdPath) {
                                VscodeUi.instance.errorMessage(`Skill '${currentSkill}' was not found.`);
                                return;
                            }
                            // Open the rendered Markdown preview rather than the raw text editor.
                            const openResult = await VscodeUi.instance.executeCommand<any>('markdown.showPreview', [meta.skillMdPath]);
                            if (openResult && typeof openResult === 'object' && 'error' in openResult) {
                                VscodeUi.instance.errorMessage(`Failed to open skill preview: ${String((openResult as any).error)}`);
                            }
                        });

                        skillActions.appendChild(pickSkillBtn);
                        skillActions.appendChild(refreshSkillsBtn);
                        skillActions.appendChild(openSkillBtn);

                        const skillStatus = document.createElement('div');
                        skillStatus.className = 'agent-skill-status';
                        const selectedSkill = this.stripQuotesIfStringLiteral(argsMap.get('skill') ?? '').trim();
                        const selectedMeta = knownSkills.find((s) => s.name === selectedSkill);
                        updateSkillStatus(selectedMeta);
                        renderSkillChips(selectedMeta);
                        renderSkillWarning(selectedMeta);

                        const hooksWrap = document.createElement('label');
                        hooksWrap.className = 'agent-toggle';
                        const hooksInput = document.createElement('input');
                        hooksInput.type = 'checkbox';
                        const hooksRaw = (argsMap.get('useSkillHooks') ?? '').trim().toLowerCase();
                        hooksInput.checked = hooksRaw ? hooksRaw === 'true' : true;
                        argsMap.set('useSkillHooks', hooksInput.checked ? 'true' : 'false');
                        hooksInput.addEventListener('change', () => {
                            argsMap.set('useSkillHooks', hooksInput.checked ? 'true' : 'false');
                        });
                        const hooksText = document.createElement('span');
                        hooksText.textContent = 'Enable Skill Hooks';
                        hooksWrap.appendChild(hooksInput);
                        hooksWrap.appendChild(hooksText);

                        const syncSkillActive = (): void => {
                            argsMap.set('useSkill', skillActive ? 'true' : 'false');
                            skillEnabledToggle.input.checked = skillActive;
                            skillInput.disabled = !skillActive;
                            pickSkillBtn.disabled = !skillActive;
                            refreshSkillsBtn.disabled = !skillActive;
                            openSkillBtn.disabled = !skillActive;
                            hooksInput.disabled = !skillActive;
                            skillContent.style.display = skillActive ? '' : 'none';
                            skillRow.classList.toggle('disabled', !skillActive);
                            if (!skillActive) {
                                chipRow.style.display = 'none';
                                skillWarn.style.display = 'none';
                                skillStatus.textContent = 'Skill is deactivated.';
                            } else {
                                const currentSkill = this.stripQuotesIfStringLiteral(argsMap.get('skill') ?? '').trim();
                                const latest = WorkflowShowAgentSkillsActionHandler.getSkillsForElement(elementId);
                                const meta = latest.find((s) => s.name === currentSkill);
                                updateSkillStatus(meta);
                                renderSkillChips(meta);
                                renderSkillWarning(meta);
                            }
                        };
                        skillEnabledToggle.input.addEventListener('change', () => {
                            skillActive = skillEnabledToggle.input.checked;
                            syncSkillActive();
                        });
                        syncSkillActive();

                        skillContent.appendChild(skillInput);
                        skillContent.appendChild(skillHint);
                        skillContent.appendChild(skillActions);
                        skillContent.appendChild(hooksWrap);
                        skillContent.appendChild(skillStatus);
                        skillContent.appendChild(chipRow);
                        skillContent.appendChild(skillWarn);
                        skillRow.appendChild(skillContent);

                        // 2. Prompt Section (Full Width)
                        const promptRow = document.createElement('div');
                        promptRow.className = 'agent-skill-block agent-prompt-block';
                        
                        const promptHeader = document.createElement('div');
                        promptHeader.className = 'agent-prompt-header';
                        
                        const promptLabel = document.createElement('div');
                        promptLabel.innerHTML = 'Prompt <span class="codicon codicon-info" style="cursor:help;opacity:0.6;font-size:12px" title="Use {in.portName} or {out.portName} to reference port data"></span>';
                        promptLabel.className = 'agent-prompt-label';

                        const promptRaw = (argsMap.get('usePrompt') ?? '').trim().toLowerCase();
                        let promptActive = promptRaw ? promptRaw === 'true' : true;
                        const promptEnabledToggle = createEnabledToggle(promptActive);
                        
                        const popupBtn = document.createElement('button');
                        popupBtn.className = 'mini-btn';
                        popupBtn.innerHTML = '<span class="codicon codicon-screen-full"></span> Expand Editor';
                        popupBtn.style.display = 'flex';
                        popupBtn.style.gap = '4px';
                        popupBtn.style.alignItems = 'center';

                        const promptHeaderRight = document.createElement('div');
                        promptHeaderRight.style.display = 'flex';
                        promptHeaderRight.style.gap = '8px';
                        promptHeaderRight.appendChild(promptEnabledToggle.wrap);

                        promptHeader.appendChild(promptLabel);
                        promptHeader.appendChild(promptHeaderRight);
                        promptRow.appendChild(promptHeader);

                        const promptContent = document.createElement('div');
                        promptContent.className = 'agent-section-content';

                        const promptActions = document.createElement('div');
                        promptActions.className = 'agent-skill-actions';
                        promptActions.appendChild(popupBtn);
                        promptContent.appendChild(promptActions);

                        const promptInput = document.createElement('textarea');
                        promptInput.className = 'annotation-input annotation-textarea';
                        promptInput.rows = 6;
                        promptInput.placeholder = 'Transform inputs into outputs...\nWait for { to trigger autocomplete!';
                        promptInput.classList.add('agent-prompt-input');

                        const updatePromptVal = (val) => {
                            promptInput.value = val;
                            argsMap.set('prompt', this.toWfStringLiteral(val));
                        };
                        
                        promptInput.value = this.normalizeMultilineStringForEditor(
                            this.stripQuotesIfStringLiteral(argsMap.get('prompt') ?? '')
                        );
                        promptInput.addEventListener('input', () => {
                            argsMap.set('prompt', this.toWfStringLiteral(promptInput.value));
                        });

                        const syncPromptActive = (): void => {
                            argsMap.set('usePrompt', promptActive ? 'true' : 'false');
                            promptEnabledToggle.input.checked = promptActive;
                            promptInput.disabled = !promptActive;
                            popupBtn.disabled = !promptActive;
                            promptRow.classList.toggle('disabled', !promptActive);
                            promptContent.style.display = promptActive ? '' : 'none';
                        };
                        promptEnabledToggle.input.addEventListener('change', () => {
                            promptActive = promptEnabledToggle.input.checked;
                            syncPromptActive();
                        });
                        syncPromptActive();

                        const createAutocomplete = (inputEl, parent, extraZIndex = 0) => {
                            const autocompleteBox = document.createElement('div');
                            autocompleteBox.style.position = 'absolute';
                            autocompleteBox.style.display = 'none';
                            autocompleteBox.style.backgroundColor = 'var(--vscode-editorSuggestWidget-background, #252526)';
                            autocompleteBox.style.border = '1px solid var(--vscode-editorSuggestWidget-border, #454545)';
                            autocompleteBox.style.borderRadius = '4px';
                            autocompleteBox.style.boxShadow = '0 4px 8px rgba(0,0,0,0.4)';
                            autocompleteBox.style.zIndex = String(999999 + extraZIndex);
                            autocompleteBox.style.maxHeight = '150px';
                            autocompleteBox.style.overflowY = 'auto';
                            autocompleteBox.style.minWidth = '150px';
                            autocompleteBox.style.fontSize = '12px';
                            
                            parent.style.position = 'relative';
                            parent.appendChild(autocompleteBox);

                            inputEl.addEventListener('input', (e) => {
                                const val = inputEl.value;
                                const cursorPos = inputEl.selectionStart;
                                const textBefore = val.slice(0, cursorPos);
                                
                                const match = textBefore.match(/\{([a-zA-Z0-9_.]*)$/);
                                if (match) {
                                    const searchStr = match[1].toLowerCase();
                                    
                                    const suggestions = [
                                        ...inputPorts.map((p) => ({ display: `in.${p}`, val: `in.${p}`, kind: 'input' })),
                                        ...outputPorts.map((p) => ({ display: `out.${p}`, val: `out.${p}`, kind: 'output' }))
                                    ].filter(s => s.display.toLowerCase().includes(searchStr));

                                    if (suggestions.length > 0) {
                                        autocompleteBox.innerHTML = '';
                                        suggestions.forEach((s, idx) => {
                                            const item = document.createElement('div');
                                            item.style.padding = '4px 8px';
                                            item.style.cursor = 'pointer';
                                            item.style.display = 'flex';
                                            item.style.justifyContent = 'space-between';
                                            item.style.borderBottom = idx < suggestions.length - 1 ? '1px solid var(--vscode-editorGroup-border)' : 'none';
                                            
                                            const nameSpan = document.createElement('span');
                                            nameSpan.style.color = 'var(--vscode-symbolIcon-variableForeground)';
                                            nameSpan.style.fontWeight = 'bold';
                                            nameSpan.textContent = s.display;
                                            
                                            const kindSpan = document.createElement('span');
                                            kindSpan.style.opacity = '0.6';
                                            kindSpan.style.fontSize = '10px';
                                            kindSpan.textContent = s.kind;

                                            item.appendChild(nameSpan);
                                            item.appendChild(kindSpan);

                                            item.onmouseover = () => item.style.backgroundColor = 'var(--vscode-editorSuggestWidget-selectedBackground, #062f4a)';
                                            item.onmouseout = () => item.style.backgroundColor = 'transparent';
                                            
                                            item.onclick = () => {
                                                const replaceStart = cursorPos - match[0].length;
                                                const newVal = val.slice(0, replaceStart) + '{' + s.val + '}' + val.slice(cursorPos);
                                                updatePromptVal(newVal);
                                                autocompleteBox.style.display = 'none';
                                                inputEl.focus();
                                                argsMap.set('prompt', this.toWfStringLiteral(newVal));
                                            };
                                            autocompleteBox.appendChild(item);
                                        });

                                        autocompleteBox.style.display = 'block';
                                        autocompleteBox.style.marginTop = '4px';

                                    } else {
                                        autocompleteBox.style.display = 'none';
                                    }
                                } else {
                                    autocompleteBox.style.display = 'none';
                                }
                            });

                            document.addEventListener('click', (e) => {
                                if (e.target !== inputEl && !autocompleteBox.contains(e.target as Node)) {
                                    autocompleteBox.style.display = 'none';
                                }
                            });
                        };

                        createAutocomplete(promptInput, promptContent);

                        // Attach floating editor logic
                        popupBtn.addEventListener('click', () => {
                            const overlay = document.createElement('div');
                            overlay.style.position = 'fixed';
                            overlay.style.top = '0';
                            overlay.style.left = '0';
                            overlay.style.width = '100vw';
                            overlay.style.height = '100vh';
                            overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
                            overlay.style.backdropFilter = 'blur(4px)';
                            overlay.style.zIndex = '9999999';
                            overlay.style.display = 'flex';
                            overlay.style.alignItems = 'center';
                            overlay.style.justifyContent = 'center';
                            overlay.style.transition = 'opacity 0.2s';
                            
                            const modal = document.createElement('div');
                            modal.style.width = '60vw';
                            modal.style.minWidth = '500px';
                            modal.style.height = '60vh';
                            modal.style.backgroundColor = 'var(--vscode-editor-background, #1e1e1e)';
                            modal.style.borderRadius = '8px';
                            modal.style.boxShadow = '0 12px 32px rgba(0,0,0,0.5)';
                            modal.style.border = '1px solid var(--vscode-widget-border, #454545)';
                            modal.style.display = 'flex';
                            modal.style.flexDirection = 'column';
                            modal.style.overflow = 'hidden';

                            const header = document.createElement('div');
                            header.style.padding = '12px 16px';
                            header.style.backgroundColor = 'var(--vscode-editorGroupHeader-tabsBackground, #2d2d2d)';
                            header.style.borderBottom = '1px solid var(--vscode-editorGroup-border, #454545)';
                            header.style.display = 'flex';
                            header.style.justifyContent = 'space-between';
                            header.style.alignItems = 'center';

                            const title = document.createElement('div');
                            title.innerHTML = '<span class="codicon codicon-sparkle"></span> Prompt <span style="opacity: 0.5; font-size: 11px; margin-left: 10px;">Type { to use IntelliSense parameters</span>';
                            title.style.fontWeight = 'bold';
                            title.style.color = 'var(--vscode-editor-foreground, #ccc)';

                            const closeBtn = document.createElement('button');
                            closeBtn.innerHTML = '<span class="codicon codicon-close"></span>';
                            closeBtn.className = 'mini-btn danger';
                            closeBtn.style.border = 'none';
                            closeBtn.style.cursor = 'pointer';
                            closeBtn.onclick = () => document.body.removeChild(overlay);

                            header.appendChild(title);
                            header.appendChild(closeBtn);

                            const editorWrap = document.createElement('div');
                            editorWrap.style.flex = '1';
                            editorWrap.style.position = 'relative';
                            editorWrap.style.padding = '16px';
                            editorWrap.style.display = 'flex';
                            editorWrap.style.flexDirection = 'column';

                            const largeInput = document.createElement('textarea');
                            largeInput.style.flex = '1';
                            largeInput.style.backgroundColor = 'transparent';
                            largeInput.style.color = 'var(--vscode-editor-foreground, #ccc)';
                            largeInput.style.border = 'none';
                            largeInput.style.outline = 'none';
                            largeInput.style.resize = 'none';
                            largeInput.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
                            largeInput.style.fontSize = '14px';
                            largeInput.style.lineHeight = '1.5';
                            largeInput.value = promptInput.value;
                            
                            largeInput.addEventListener('input', () => {
                                updatePromptVal(largeInput.value);
                            });

                            createAutocomplete(largeInput, editorWrap, 10000000);

                            editorWrap.appendChild(largeInput);
                            
                            const footer = document.createElement('div');
                            footer.style.padding = '12px 16px';
                            footer.style.borderTop = '1px solid var(--vscode-editorGroup-border, #454545)';
                            footer.style.display = 'flex';
                            footer.style.justifyContent = 'space-between';
                            footer.style.alignItems = 'center';

                            const footerHint = document.createElement('div');
                            footerHint.textContent = 'Changes auto-saved. Click Apply & Save to confirm.';
                            footerHint.style.fontSize = '11px';
                            footerHint.style.opacity = '0.6';

                            const saveModalBtn = document.createElement('button');
                            saveModalBtn.textContent = 'Apply & Close';
                            saveModalBtn.className = 'mini-btn';
                            saveModalBtn.style.padding = '4px 12px';
                            saveModalBtn.style.fontSize = '12px';
                            saveModalBtn.style.backgroundColor = 'var(--vscode-button-background, #0e639c)';
                            saveModalBtn.style.color = 'var(--vscode-button-foreground, #fff)';
                            saveModalBtn.onclick = () => {
                                const mainSaveBtn = saveBtn; // Captured from closure!
                                if (mainSaveBtn) mainSaveBtn.click();
                                document.body.removeChild(overlay);
                            };

                            footer.appendChild(footerHint);
                            footer.appendChild(saveModalBtn);

                            modal.appendChild(header);
                            modal.appendChild(editorWrap);
                            modal.appendChild(footer);
                            overlay.appendChild(modal);

                            document.body.appendChild(overlay);
                            largeInput.focus();
                        });

                        promptContent.appendChild(promptInput);
                        promptRow.appendChild(promptContent);
                        body.appendChild(promptRow);
                        body.appendChild(claudeRow);
                        body.appendChild(skillRow);

                        // 1b. MCP Servers section
                        const mcpRow = document.createElement('details');
                        mcpRow.className = 'agent-skill-block agent-collapsible';
                        const mcpHead = document.createElement('summary');
                        mcpHead.className = 'agent-section-head';
                        const mcpTitleWrap = document.createElement('span');
                        mcpTitleWrap.className = 'agent-collapsible-title';
                        const mcpChevron = document.createElement('span');
                        mcpChevron.className = 'codicon codicon-chevron-right agent-collapse-chevron';
                        const mcpLabel = document.createElement('div');
                        mcpLabel.textContent = 'MCP';
                        mcpLabel.className = 'agent-skill-label';
                        mcpTitleWrap.appendChild(mcpChevron);
                        mcpTitleWrap.appendChild(mcpLabel);
                        const mcpRaw = (argsMap.get('useMcp') ?? '').trim().toLowerCase();
                        let mcpActive = mcpRaw ? mcpRaw === 'true' : false;
                        const mcpEnabledToggle = createEnabledToggle(mcpActive);
                        // The Enabled toggle lives inside the <summary>; a click on it must flip the
                        // switch, not collapse the section. Swallow the summary toggle and flip manually.
                        mcpEnabledToggle.wrap.addEventListener('click', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            mcpEnabledToggle.input.checked = !mcpEnabledToggle.input.checked;
                            mcpEnabledToggle.input.dispatchEvent(new Event('change'));
                        });
                        mcpRow.open = false; // collapsed by default to cut noise; enabling expands it
                        mcpHead.appendChild(mcpTitleWrap);
                        mcpHead.appendChild(mcpEnabledToggle.wrap);

                        const mcpContent = document.createElement('div');
                        mcpContent.className = 'agent-section-content';

                        const mcpServersLabel = document.createElement('div');
                        mcpServersLabel.textContent = 'Servers';
                        mcpServersLabel.style.fontSize = '10px';
                        mcpServersLabel.style.opacity = '0.8';
                        mcpServersLabel.style.fontWeight = '500';
                        mcpServersLabel.style.marginBottom = '4px';

                        const mcpServersInput = document.createElement('input');
                        mcpServersInput.className = 'annotation-input';
                        mcpServersInput.placeholder = 'e.g. filesystem, github';
                        mcpServersInput.style.width = '100%';
                        mcpServersInput.style.boxSizing = 'border-box';
                        const mcpServersRaw = argsMap.get('mcpServers') ?? '';
                        const mcpServersParsed = this.tryParseWfStringListExpr(mcpServersRaw);
                        mcpServersInput.value = mcpServersParsed ? mcpServersParsed.join(', ') : '';
                        mcpServersInput.addEventListener('input', () => {
                            const val = mcpServersInput.value.trim();
                            if (val) {
                                const items = val.split(',').map(s => s.trim()).filter(s => s.length > 0);
                                argsMap.set('mcpServers', this.serializeWfStringListExpr(items));
                            } else {
                                argsMap.delete('mcpServers');
                            }
                        });

                        const mcpHint = document.createElement('div');
                        mcpHint.className = 'agent-skill-hint';
                        mcpHint.textContent = 'Comma-separated MCP server names from agent-tools.json registry';

                        // Rich MCP server config (editable, from mcpServerConfigs JSON)
                        const mcpConfigsContainer = document.createElement('div');
                        mcpConfigsContainer.style.marginTop = '8px';
                        const mcpConfigsRaw = argsMap.get('mcpServerConfigs') ?? '';
                        let mcpConfigsParsed: Array<{name: string; transport: string; url: string; command: string; args: string[]}> = [];
                        try { mcpConfigsParsed = mcpConfigsRaw ? JSON.parse(mcpConfigsRaw) : []; } catch { /* ignore parse errors */ }

                        const syncMcpConfigs = (): void => {
                            if (mcpConfigsParsed.length > 0) {
                                argsMap.set('mcpServerConfigs', JSON.stringify(mcpConfigsParsed));
                            } else {
                                argsMap.delete('mcpServerConfigs');
                            }
                        };

                        const createMcpField = (labelText: string, value: string, onChange: (v: string) => void, placeholder = ''): HTMLElement => {
                            const row = document.createElement('div');
                            row.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 4px;';
                            const lbl = document.createElement('span');
                            lbl.style.cssText = 'opacity: 0.7; min-width: 70px; font-size: 10px; font-weight: 500;';
                            lbl.textContent = labelText;
                            const inp = document.createElement('input');
                            inp.className = 'annotation-input';
                            inp.style.cssText = 'flex: 1; box-sizing: border-box;';
                            inp.value = value;
                            inp.placeholder = placeholder;
                            inp.addEventListener('input', () => onChange(inp.value));
                            row.appendChild(lbl);
                            row.appendChild(inp);
                            return row;
                        };

                        let lastRemovedMcp: { cfg: {name: string; transport: string; url: string; command: string; args: string[]}; idx: number } | null = null;
                        const renderMcpCards = (): void => {
                            mcpConfigsContainer.innerHTML = '';
                            if (lastRemovedMcp) {
                                const snap = lastRemovedMcp;
                                mcpConfigsContainer.appendChild(this.buildCardUndoBar(
                                    'MCP server', snap.cfg.name || '',
                                    () => { mcpConfigsParsed.splice(Math.min(snap.idx, mcpConfigsParsed.length), 0, snap.cfg); lastRemovedMcp = null; syncMcpConfigs(); renderMcpCards(); },
                                    () => { lastRemovedMcp = null; renderMcpCards(); }
                                ));
                            }
                            mcpConfigsParsed.forEach((cfg, idx) => {
                                const card = document.createElement('div');
                                card.style.cssText = 'background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border, #333); border-radius: 4px; padding: 8px; margin-bottom: 6px; font-size: 11px;';
                                const header = this.buildRemovableCardHeader('MCP server', cfg.name || 'Unnamed server', () => { lastRemovedMcp = { cfg, idx }; mcpConfigsParsed.splice(idx, 1); syncMcpConfigs(); renderMcpCards(); });
                                card.appendChild(header);

                                card.appendChild(createMcpField('Name', cfg.name || '', v => { cfg.name = v; const t = header.querySelector('.pp-card-title'); if (t) t.textContent = v.trim() || 'Unnamed server'; syncMcpConfigs(); }, 'e.g. my-mcp'));
                                // Transport select
                                const tRow = document.createElement('div');
                                tRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 4px;';
                                const tLbl = document.createElement('span');
                                tLbl.style.cssText = 'opacity: 0.7; min-width: 70px; font-size: 10px; font-weight: 500;';
                                tLbl.textContent = 'Transport';
                                const tSel = document.createElement('select');
                                tSel.className = 'annotation-input';
                                tSel.style.cssText = 'flex: 1; box-sizing: border-box;';
                                for (const opt of ['bridge', 'stdio', 'http', 'streamable-http']) {
                                    const o = document.createElement('option');
                                    o.value = opt; o.textContent = opt;
                                    tSel.appendChild(o);
                                }
                                tSel.value = cfg.transport || 'bridge';
                                tSel.addEventListener('change', () => { cfg.transport = tSel.value; syncMcpConfigs(); });
                                tRow.appendChild(tLbl);
                                tRow.appendChild(tSel);
                                card.appendChild(tRow);

                                card.appendChild(createMcpField('URL', cfg.url || '', v => { cfg.url = v; syncMcpConfigs(); }, 'e.g. http://localhost:8080/mcp'));
                                card.appendChild(createMcpField('Command', cfg.command || '', v => { cfg.command = v; syncMcpConfigs(); }, 'e.g. npx'));
                                card.appendChild(createMcpField('Args', (cfg.args || []).join(' '), v => { cfg.args = v.trim() ? v.split(/\s+/) : []; syncMcpConfigs(); }, 'space-separated args'));
                                mcpConfigsContainer.appendChild(card);
                            });

                            // Add button
                            const addBtn = document.createElement('button');
                            addBtn.textContent = '+ Add MCP Server';
                            addBtn.style.cssText = 'background: none; border: 1px dashed var(--vscode-panel-border, #555); color: var(--vscode-foreground); padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; width: 100%;';
                            addBtn.addEventListener('click', () => {
                                mcpConfigsParsed.push({name: '', transport: 'bridge', url: '', command: '', args: []});
                                syncMcpConfigs();
                                renderMcpCards();
                            });
                            mcpConfigsContainer.appendChild(addBtn);
                        };
                        renderMcpCards();

                        const mcpTransportLabel = document.createElement('div');
                        mcpTransportLabel.textContent = 'Transport';
                        mcpTransportLabel.style.fontSize = '10px';
                        mcpTransportLabel.style.opacity = '0.8';
                        mcpTransportLabel.style.fontWeight = '500';
                        mcpTransportLabel.style.marginTop = '8px';
                        mcpTransportLabel.style.marginBottom = '4px';

                        const mcpTransportSelect = document.createElement('select');
                        mcpTransportSelect.className = 'annotation-input';
                        mcpTransportSelect.style.width = '100%';
                        mcpTransportSelect.style.boxSizing = 'border-box';
                        for (const opt of ['bridge', 'stdio', 'http', 'streamable-http']) {
                            const o = document.createElement('option');
                            o.value = opt;
                            o.textContent = opt;
                            mcpTransportSelect.appendChild(o);
                        }
                        const mcpTransportRaw = this.stripQuotesIfStringLiteral(argsMap.get('mcpTransport') ?? '').trim();
                        if (mcpTransportRaw && ['bridge', 'stdio', 'http', 'streamable-http'].includes(mcpTransportRaw)) {
                            mcpTransportSelect.value = mcpTransportRaw;
                        }
                        mcpTransportSelect.addEventListener('change', () => {
                            const val = mcpTransportSelect.value;
                            if (val && val !== 'bridge') {
                                argsMap.set('mcpTransport', this.toWfStringLiteral(val));
                            } else {
                                argsMap.delete('mcpTransport');
                            }
                        });

                        // Always show rich config container (has add button); hide basic transport when configs exist
                        const hasRichMcpConfigs = mcpConfigsParsed.length > 0;

                        const syncMcpActive = (): void => {
                            argsMap.set('useMcp', mcpActive ? 'true' : 'false');
                            mcpEnabledToggle.input.checked = mcpActive;
                            mcpServersInput.disabled = !mcpActive;
                            mcpTransportSelect.disabled = !mcpActive;
                            mcpRow.classList.toggle('disabled', !mcpActive);
                        };
                        mcpEnabledToggle.input.addEventListener('change', () => {
                            mcpActive = mcpEnabledToggle.input.checked;
                            syncMcpActive();
                            if (mcpActive) mcpRow.open = true; // reveal the config you just enabled
                        });
                        syncMcpActive();

                        mcpContent.appendChild(mcpServersLabel);
                        mcpContent.appendChild(mcpServersInput);
                        mcpContent.appendChild(mcpHint);
                        mcpContent.appendChild(mcpConfigsContainer);
                        if (!hasRichMcpConfigs) {
                            mcpContent.appendChild(mcpTransportLabel);
                            mcpContent.appendChild(mcpTransportSelect);
                        }
                        mcpRow.appendChild(mcpHead);
                        mcpRow.appendChild(mcpContent);
                        body.appendChild(mcpRow);

                        // 1c. LSP section
                        const lspRow = document.createElement('details');
                        lspRow.className = 'agent-skill-block agent-collapsible';
                        const lspHead = document.createElement('summary');
                        lspHead.className = 'agent-section-head';
                        const lspTitleWrap = document.createElement('span');
                        lspTitleWrap.className = 'agent-collapsible-title';
                        const lspChevron = document.createElement('span');
                        lspChevron.className = 'codicon codicon-chevron-right agent-collapse-chevron';
                        const lspLabel = document.createElement('div');
                        lspLabel.textContent = 'LSP';
                        lspLabel.className = 'agent-skill-label';
                        lspTitleWrap.appendChild(lspChevron);
                        lspTitleWrap.appendChild(lspLabel);
                        const lspRaw = (argsMap.get('useLsp') ?? '').trim().toLowerCase();
                        let lspActive = lspRaw ? lspRaw === 'true' : false;
                        const lspEnabledToggle = createEnabledToggle(lspActive);
                        // The Enabled toggle lives inside the <summary>; a click on it must flip the
                        // switch, not collapse the section. Swallow the summary toggle and flip manually.
                        lspEnabledToggle.wrap.addEventListener('click', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            lspEnabledToggle.input.checked = !lspEnabledToggle.input.checked;
                            lspEnabledToggle.input.dispatchEvent(new Event('change'));
                        });
                        lspRow.open = false; // collapsed by default to cut noise; enabling expands it
                        lspHead.appendChild(lspTitleWrap);
                        lspHead.appendChild(lspEnabledToggle.wrap);

                        const lspContent = document.createElement('div');
                        lspContent.className = 'agent-section-content';

                        const lspServersLabel = document.createElement('div');
                        lspServersLabel.textContent = 'Servers';
                        lspServersLabel.style.fontSize = '10px';
                        lspServersLabel.style.opacity = '0.8';
                        lspServersLabel.style.fontWeight = '500';
                        lspServersLabel.style.marginBottom = '4px';

                        const lspServersInput = document.createElement('input');
                        lspServersInput.className = 'annotation-input';
                        lspServersInput.placeholder = 'e.g. pylance, typescript';
                        lspServersInput.style.width = '100%';
                        lspServersInput.style.boxSizing = 'border-box';
                        const lspServersRaw = argsMap.get('lspServers') ?? '';
                        const lspServersParsed = this.tryParseWfStringListExpr(lspServersRaw);
                        lspServersInput.value = lspServersParsed ? lspServersParsed.join(', ') : '';
                        lspServersInput.addEventListener('input', () => {
                            const val = lspServersInput.value.trim();
                            if (val) {
                                const items = val.split(',').map(s => s.trim()).filter(s => s.length > 0);
                                argsMap.set('lspServers', this.serializeWfStringListExpr(items));
                            } else {
                                argsMap.delete('lspServers');
                            }
                        });

                        const lspHint = document.createElement('div');
                        lspHint.className = 'agent-skill-hint';
                        lspHint.textContent = 'Comma-separated LSP server names available to this agent';

                        // Rich LSP server config (editable, from lspServerConfigs JSON)
                        const lspConfigsContainer = document.createElement('div');
                        lspConfigsContainer.style.marginTop = '8px';
                        const lspConfigsRaw = argsMap.get('lspServerConfigs') ?? '';
                        let lspConfigsParsed: Array<{
                            name: string; command: string; args: string[];
                            languageId: string; extraFlags: string[];
                            ports: string[]; maxRepairAttempts: number;
                            severityThreshold: string;
                        }> = [];
                        try { lspConfigsParsed = lspConfigsRaw ? JSON.parse(lspConfigsRaw) : []; } catch { /* ignore */ }

                        const syncLspConfigs = (): void => {
                            if (lspConfigsParsed.length > 0) {
                                argsMap.set('lspServerConfigs', JSON.stringify(lspConfigsParsed));
                            } else {
                                argsMap.delete('lspServerConfigs');
                            }
                        };

                        const createLspField = (labelText: string, value: string, onChange: (v: string) => void, placeholder = ''): HTMLElement => {
                            const row = document.createElement('div');
                            row.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 4px;';
                            const lbl = document.createElement('span');
                            lbl.style.cssText = 'opacity: 0.7; min-width: 90px; font-size: 10px; font-weight: 500;';
                            lbl.textContent = labelText;
                            const inp = document.createElement('input');
                            inp.className = 'annotation-input';
                            inp.style.cssText = 'flex: 1; box-sizing: border-box;';
                            inp.value = value;
                            inp.placeholder = placeholder;
                            inp.addEventListener('input', () => onChange(inp.value));
                            row.appendChild(lbl);
                            row.appendChild(inp);
                            return row;
                        };

                        let lastRemovedLsp: { cfg: typeof lspConfigsParsed[number]; idx: number } | null = null;
                        const renderLspCards = (): void => {
                            lspConfigsContainer.innerHTML = '';
                            if (lastRemovedLsp) {
                                const snap = lastRemovedLsp;
                                lspConfigsContainer.appendChild(this.buildCardUndoBar(
                                    'LSP server', snap.cfg.command || snap.cfg.name || '',
                                    () => { lspConfigsParsed.splice(Math.min(snap.idx, lspConfigsParsed.length), 0, snap.cfg); lastRemovedLsp = null; syncLspConfigs(); renderLspCards(); },
                                    () => { lastRemovedLsp = null; renderLspCards(); }
                                ));
                            }
                            lspConfigsParsed.forEach((cfg, idx) => {
                                const card = document.createElement('div');
                                card.style.cssText = 'background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border, #333); border-radius: 4px; padding: 8px; margin-bottom: 6px; font-size: 11px;';
                                const header = this.buildRemovableCardHeader('LSP server', cfg.command || 'Unnamed server', () => { lastRemovedLsp = { cfg, idx }; lspConfigsParsed.splice(idx, 1); syncLspConfigs(); renderLspCards(); });
                                card.appendChild(header);

                                card.appendChild(createLspField('Command', cfg.command || '', v => { cfg.command = v; cfg.name = v; const t = header.querySelector('.pp-card-title'); if (t) t.textContent = v.trim() || 'Unnamed server'; syncLspConfigs(); }, 'e.g. clangd'));
                                card.appendChild(createLspField('Args', (cfg.args || []).join(' '), v => { cfg.args = v.trim() ? v.split(/\s+/) : []; syncLspConfigs(); }, 'space-separated'));
                                card.appendChild(createLspField('Language', cfg.languageId || '', v => { cfg.languageId = v; syncLspConfigs(); }, 'e.g. cpp'));
                                card.appendChild(createLspField('Extra Flags', (cfg.extraFlags || []).join(' '), v => { cfg.extraFlags = v.trim() ? v.split(/\s+/) : []; syncLspConfigs(); }, 'space-separated'));
                                card.appendChild(createLspField('Ports', (cfg.ports || []).join(', '), v => { cfg.ports = v.trim() ? v.split(',').map(s => s.trim()).filter(Boolean) : []; syncLspConfigs(); }, 'comma-separated'));
                                card.appendChild(createLspField('Max Repairs', String(cfg.maxRepairAttempts ?? 2), v => { cfg.maxRepairAttempts = parseInt(v, 10) || 2; syncLspConfigs(); }, '2'));
                                // Severity select
                                const sevRow = document.createElement('div');
                                sevRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 4px;';
                                const sevLbl = document.createElement('span');
                                sevLbl.style.cssText = 'opacity: 0.7; min-width: 90px; font-size: 10px; font-weight: 500;';
                                sevLbl.textContent = 'Severity';
                                const sevSel = document.createElement('select');
                                sevSel.className = 'annotation-input';
                                sevSel.style.cssText = 'flex: 1; box-sizing: border-box;';
                                for (const opt of ['error', 'warning', 'info', 'hint']) {
                                    const o = document.createElement('option');
                                    o.value = opt; o.textContent = opt;
                                    sevSel.appendChild(o);
                                }
                                sevSel.value = cfg.severityThreshold || 'error';
                                sevSel.addEventListener('change', () => { cfg.severityThreshold = sevSel.value; syncLspConfigs(); });
                                sevRow.appendChild(sevLbl);
                                sevRow.appendChild(sevSel);
                                card.appendChild(sevRow);

                                lspConfigsContainer.appendChild(card);
                            });

                            // Add button
                            const addBtn = document.createElement('button');
                            addBtn.textContent = '+ Add LSP Server';
                            addBtn.style.cssText = 'background: none; border: 1px dashed var(--vscode-panel-border, #555); color: var(--vscode-foreground); padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; width: 100%;';
                            addBtn.addEventListener('click', () => {
                                lspConfigsParsed.push({name: '', command: '', args: [], languageId: '', extraFlags: [], ports: [], maxRepairAttempts: 2, severityThreshold: 'error'});
                                syncLspConfigs();
                                renderLspCards();
                            });
                            lspConfigsContainer.appendChild(addBtn);
                        };
                        renderLspCards();

                        const hasRichLspConfigs = lspConfigsParsed.length > 0;

                        const lspCommandLabel = document.createElement('div');
                        lspCommandLabel.textContent = 'Command';
                        lspCommandLabel.style.fontSize = '10px';
                        lspCommandLabel.style.opacity = '0.8';
                        lspCommandLabel.style.fontWeight = '500';
                        lspCommandLabel.style.marginTop = '8px';
                        lspCommandLabel.style.marginBottom = '4px';

                        const lspCommandInput = document.createElement('input');
                        lspCommandInput.className = 'annotation-input';
                        lspCommandInput.placeholder = 'e.g. pylsp';
                        lspCommandInput.style.width = '100%';
                        lspCommandInput.style.boxSizing = 'border-box';
                        lspCommandInput.value = this.stripQuotesIfStringLiteral(argsMap.get('lspCommand') ?? '');
                        lspCommandInput.addEventListener('input', () => {
                            const val = lspCommandInput.value.trim();
                            if (val) argsMap.set('lspCommand', this.toWfStringLiteral(val));
                            else argsMap.delete('lspCommand');
                        });

                        const lspPortLabel = document.createElement('div');
                        lspPortLabel.textContent = 'Port';
                        lspPortLabel.style.fontSize = '10px';
                        lspPortLabel.style.opacity = '0.8';
                        lspPortLabel.style.fontWeight = '500';
                        lspPortLabel.style.marginTop = '8px';
                        lspPortLabel.style.marginBottom = '4px';

                        const lspPortInput = document.createElement('input');
                        lspPortInput.type = 'number';
                        lspPortInput.className = 'annotation-input';
                        lspPortInput.placeholder = 'e.g. 2087';
                        lspPortInput.style.width = '100%';
                        lspPortInput.style.boxSizing = 'border-box';
                        lspPortInput.value = argsMap.get('lspPort') ?? '';
                        lspPortInput.addEventListener('input', () => {
                            const val = lspPortInput.value.trim();
                            if (val) argsMap.set('lspPort', val);
                            else argsMap.delete('lspPort');
                        });

                        // Shorthand scalars accompanying the single lsp_command form. (The rich
                        // lspServerConfigs editor covers these per-server; these apply when you use
                        // the one-command shorthand instead.)
                        const lspShortTextField = (labelText: string, key: string, placeholder: string, isList: boolean): HTMLElement => {
                            const wrap = document.createElement('div');
                            const lbl = document.createElement('div');
                            lbl.textContent = labelText;
                            lbl.style.cssText = 'font-size:10px;opacity:0.8;font-weight:500;margin-top:8px;margin-bottom:4px;';
                            const inp = document.createElement('input');
                            inp.className = 'annotation-input';
                            inp.placeholder = placeholder;
                            inp.style.cssText = 'width:100%;box-sizing:border-box;';
                            if (isList) {
                                const parsed = this.tryParseWfStringListExpr(argsMap.get(key) ?? '');
                                inp.value = parsed ? parsed.join(' ') : '';
                                inp.addEventListener('input', () => {
                                    const v = inp.value.trim();
                                    if (v) argsMap.set(key, this.serializeWfStringListExpr(v.split(/\s+/)));
                                    else argsMap.delete(key);
                                });
                            } else {
                                inp.value = this.stripQuotesIfStringLiteral(argsMap.get(key) ?? '');
                                inp.addEventListener('input', () => {
                                    const v = inp.value.trim();
                                    if (v) argsMap.set(key, this.toWfStringLiteral(v));
                                    else argsMap.delete(key);
                                });
                            }
                            wrap.appendChild(lbl);
                            wrap.appendChild(inp);
                            return wrap;
                        };
                        const lspArgsField = lspShortTextField('Args', 'lspArgs', 'space-separated', true);
                        const lspLanguageField = lspShortTextField('Language', 'lspLanguageId', 'e.g. cpp', false);
                        const lspExtraFlagsField = lspShortTextField('Extra Flags', 'lspExtraFlags', 'space-separated', true);

                        const lspSevWrap = document.createElement('div');
                        const lspSevLabel = document.createElement('div');
                        lspSevLabel.textContent = 'Severity';
                        lspSevLabel.style.cssText = 'font-size:10px;opacity:0.8;font-weight:500;margin-top:8px;margin-bottom:4px;';
                        const lspSevSelect = document.createElement('select');
                        lspSevSelect.className = 'annotation-input';
                        lspSevSelect.style.cssText = 'width:100%;box-sizing:border-box;';
                        for (const opt of ['error', 'warning', 'information', 'hint']) {
                            const o = document.createElement('option'); o.value = opt; o.textContent = opt; lspSevSelect.appendChild(o);
                        }
                        const lspSevCurrent = this.stripQuotesIfStringLiteral(argsMap.get('lspSeverityThreshold') ?? '').trim();
                        lspSevSelect.value = ['error', 'warning', 'information', 'hint'].includes(lspSevCurrent) ? lspSevCurrent : 'error';
                        lspSevSelect.addEventListener('change', () => {
                            if (lspSevSelect.value && lspSevSelect.value !== 'error') argsMap.set('lspSeverityThreshold', this.toWfStringLiteral(lspSevSelect.value));
                            else argsMap.delete('lspSeverityThreshold');
                        });
                        lspSevWrap.appendChild(lspSevLabel);
                        lspSevWrap.appendChild(lspSevSelect);

                        const lspMaxWrap = document.createElement('div');
                        const lspMaxLabel = document.createElement('div');
                        lspMaxLabel.textContent = 'Max Repairs';
                        lspMaxLabel.style.cssText = 'font-size:10px;opacity:0.8;font-weight:500;margin-top:8px;margin-bottom:4px;';
                        const lspMaxInput = document.createElement('input');
                        lspMaxInput.type = 'number';
                        lspMaxInput.min = '0';
                        lspMaxInput.className = 'annotation-input';
                        lspMaxInput.placeholder = '2';
                        lspMaxInput.style.cssText = 'width:100%;box-sizing:border-box;';
                        lspMaxInput.value = argsMap.get('lspMaxRepairAttempts') ?? '';
                        lspMaxInput.addEventListener('input', () => {
                            const v = lspMaxInput.value.trim();
                            if (v && v !== '2') argsMap.set('lspMaxRepairAttempts', v);
                            else argsMap.delete('lspMaxRepairAttempts');
                        });
                        lspMaxWrap.appendChild(lspMaxLabel);
                        lspMaxWrap.appendChild(lspMaxInput);

                        const syncLspActive = (): void => {
                            argsMap.set('useLsp', lspActive ? 'true' : 'false');
                            lspEnabledToggle.input.checked = lspActive;
                            lspServersInput.disabled = !lspActive;
                            lspCommandInput.disabled = !lspActive;
                            lspPortInput.disabled = !lspActive;
                            lspRow.classList.toggle('disabled', !lspActive);
                        };
                        lspEnabledToggle.input.addEventListener('change', () => {
                            lspActive = lspEnabledToggle.input.checked;
                            syncLspActive();
                            if (lspActive) lspRow.open = true; // reveal the config you just enabled
                        });
                        syncLspActive();

                        lspContent.appendChild(lspServersLabel);
                        lspContent.appendChild(lspServersInput);
                        lspContent.appendChild(lspHint);
                        lspContent.appendChild(lspConfigsContainer);
                        if (!hasRichLspConfigs) {
                            lspContent.appendChild(lspCommandLabel);
                            lspContent.appendChild(lspCommandInput);
                            lspContent.appendChild(lspArgsField);
                            lspContent.appendChild(lspLanguageField);
                            lspContent.appendChild(lspExtraFlagsField);
                            lspContent.appendChild(lspSevWrap);
                            lspContent.appendChild(lspMaxWrap);
                            lspContent.appendChild(lspPortLabel);
                            lspContent.appendChild(lspPortInput);
                        }
                        lspRow.appendChild(lspHead);
                        lspRow.appendChild(lspContent);
                        body.appendChild(lspRow);

                        // 1d. Output Validators — per-agent output checks (cmd: run any tool
                        // against the output file; lsp: structured diagnostics). Unlike MCP/LSP
                        // configs these fully round-trip to source (managed arg, not GUI-only).
                        // Collapsed by default (native <details>) — validators are an advanced,
                        // usually-empty section, so keep it out of the way until needed. The summary
                        // carries a count badge so the collapsed state still shows how many exist.
                        const ovRow = document.createElement('details');
                        ovRow.className = 'agent-skill-block agent-collapsible';
                        const ovHead = document.createElement('summary');
                        ovHead.className = 'agent-section-head';
                        const ovLabelWrap = document.createElement('span');
                        ovLabelWrap.className = 'agent-collapsible-title';
                        const ovChevron = document.createElement('span');
                        ovChevron.className = 'codicon codicon-chevron-right agent-collapse-chevron';
                        const ovLabel = document.createElement('span');
                        ovLabel.textContent = 'Output Validators';
                        ovLabel.className = 'agent-skill-label';
                        ovLabelWrap.appendChild(ovChevron);
                        ovLabelWrap.appendChild(ovLabel);
                        const ovCount = document.createElement('span');
                        ovCount.className = 'agent-collapsible-count';
                        ovHead.appendChild(ovLabelWrap);
                        ovHead.appendChild(ovCount);

                        const ovContent = document.createElement('div');
                        ovContent.className = 'agent-section-content';
                        const ovHint = document.createElement('div');
                        ovHint.className = 'agent-skill-hint';
                        ovHint.textContent = 'Validate agent output by running a command or an LSP server; failures re-prompt the agent.';
                        ovContent.appendChild(ovHint);

                        type OvConfig = {
                            kind: string; cmd: string; args: string[]; ports: string[];
                            maxRepairAttempts: number; severityThreshold: string;
                            languageId: string; extraFlags: string[];
                        };
                        let ovParsed: OvConfig[] = [];
                        try {
                            const raw = argsMap.get('outputValidators') ?? '';
                            ovParsed = raw ? JSON.parse(raw) : [];
                        } catch { /* ignore malformed */ }

                        const syncOvConfigs = (): void => {
                            if (ovParsed.length === 0) {
                                argsMap.delete('outputValidators');
                                return;
                            }
                            // Emit only non-empty fields, and only string/int/array values, so the
                            // JSON is a valid literal the decorator can re-parse.
                            const clean = ovParsed.map((v) => {
                                const c: Record<string, unknown> = {
                                    kind: v.kind || 'cmd',
                                    cmd: v.cmd || '',
                                    args: v.args || [],
                                    maxRepairAttempts: v.maxRepairAttempts ?? 2,
                                    severityThreshold: v.severityThreshold || 'error'
                                };
                                if (v.ports && v.ports.length) c.ports = v.ports;
                                if (v.kind === 'lsp') {
                                    if (v.languageId) c.languageId = v.languageId;
                                    if (v.extraFlags && v.extraFlags.length) c.extraFlags = v.extraFlags;
                                }
                                return c;
                            });
                            argsMap.set('outputValidators', JSON.stringify(clean));
                        };

                        const ovCardsContainer = document.createElement('div');
                        ovCardsContainer.style.marginTop = '4px';

                        let lastRemovedOv: { cfg: OvConfig; idx: number } | null = null;
                        const ovTitle = (cfg: OvConfig): string => (cfg.cmd && cfg.cmd.trim()) || `${cfg.kind || 'cmd'} validator`;
                        const renderOvCards = (): void => {
                            ovCount.textContent = ovParsed.length ? String(ovParsed.length) : '';
                            ovCardsContainer.innerHTML = '';
                            if (lastRemovedOv) {
                                const snap = lastRemovedOv;
                                ovCardsContainer.appendChild(this.buildCardUndoBar(
                                    'validator', ovTitle(snap.cfg),
                                    () => { ovParsed.splice(Math.min(snap.idx, ovParsed.length), 0, snap.cfg); lastRemovedOv = null; syncOvConfigs(); renderOvCards(); },
                                    () => { lastRemovedOv = null; renderOvCards(); }
                                ));
                            }
                            ovParsed.forEach((cfg, idx) => {
                                const card = document.createElement('div');
                                card.style.cssText = 'background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border, #333); border-radius: 4px; padding: 8px; margin-bottom: 6px; font-size: 11px;';
                                card.appendChild(this.buildRemovableCardHeader('validator', ovTitle(cfg), () => { lastRemovedOv = { cfg, idx }; ovParsed.splice(idx, 1); syncOvConfigs(); renderOvCards(); }));

                                // Kind select (cmd | lsp)
                                const kindRow = document.createElement('div');
                                kindRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 4px;';
                                const kindLbl = document.createElement('span');
                                kindLbl.style.cssText = 'opacity: 0.7; min-width: 90px; font-size: 10px; font-weight: 500;';
                                kindLbl.textContent = 'Kind';
                                const kindSel = document.createElement('select');
                                kindSel.className = 'annotation-input';
                                kindSel.style.cssText = 'flex: 1; box-sizing: border-box;';
                                for (const opt of ['cmd', 'lsp']) {
                                    const o = document.createElement('option');
                                    o.value = opt; o.textContent = opt;
                                    kindSel.appendChild(o);
                                }
                                kindSel.value = cfg.kind || 'cmd';
                                kindSel.addEventListener('change', () => { cfg.kind = kindSel.value; syncOvConfigs(); renderOvCards(); });
                                kindRow.appendChild(kindLbl);
                                kindRow.appendChild(kindSel);
                                card.appendChild(kindRow);

                                const ovField = (labelText: string, value: string, onChange: (v: string) => void, placeholder = ''): HTMLElement => {
                                    const row = document.createElement('div');
                                    row.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 4px;';
                                    const lbl = document.createElement('span');
                                    lbl.style.cssText = 'opacity: 0.7; min-width: 90px; font-size: 10px; font-weight: 500;';
                                    lbl.textContent = labelText;
                                    const inp = document.createElement('input');
                                    inp.className = 'annotation-input';
                                    inp.style.cssText = 'flex: 1; box-sizing: border-box;';
                                    inp.value = value;
                                    inp.placeholder = placeholder;
                                    inp.addEventListener('input', () => onChange(inp.value));
                                    row.appendChild(lbl);
                                    row.appendChild(inp);
                                    return row;
                                };

                                card.appendChild(ovField('Command', cfg.cmd || '', v => { cfg.cmd = v; syncOvConfigs(); }, cfg.kind === 'lsp' ? 'e.g. clangd' : 'e.g. bisheng'));
                                card.appendChild(ovField('Args', (cfg.args || []).join(' '), v => { cfg.args = v.trim() ? v.split(/\s+/) : []; syncOvConfigs(); }, '{file} placeholder allowed'));
                                card.appendChild(ovField('Ports', (cfg.ports || []).join(', '), v => { cfg.ports = v.trim() ? v.split(',').map(s => s.trim()).filter(Boolean) : []; syncOvConfigs(); }, 'comma-separated (empty = all File ports)'));
                                card.appendChild(ovField('Max Repairs', String(cfg.maxRepairAttempts ?? 2), v => { cfg.maxRepairAttempts = parseInt(v, 10) || 2; syncOvConfigs(); }, '2'));

                                // Severity select
                                const sevRow = document.createElement('div');
                                sevRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 4px;';
                                const sevLbl = document.createElement('span');
                                sevLbl.style.cssText = 'opacity: 0.7; min-width: 90px; font-size: 10px; font-weight: 500;';
                                sevLbl.textContent = 'Severity';
                                const sevSel = document.createElement('select');
                                sevSel.className = 'annotation-input';
                                sevSel.style.cssText = 'flex: 1; box-sizing: border-box;';
                                for (const opt of ['error', 'warning', 'information', 'hint']) {
                                    const o = document.createElement('option');
                                    o.value = opt; o.textContent = opt;
                                    sevSel.appendChild(o);
                                }
                                sevSel.value = cfg.severityThreshold || 'error';
                                sevSel.addEventListener('change', () => { cfg.severityThreshold = sevSel.value; syncOvConfigs(); });
                                sevRow.appendChild(sevLbl);
                                sevRow.appendChild(sevSel);
                                card.appendChild(sevRow);

                                // LSP-only fields
                                if (cfg.kind === 'lsp') {
                                    card.appendChild(ovField('Language', cfg.languageId || '', v => { cfg.languageId = v; syncOvConfigs(); }, 'e.g. cpp'));
                                    card.appendChild(ovField('Extra Flags', (cfg.extraFlags || []).join(' '), v => { cfg.extraFlags = v.trim() ? v.split(/\s+/) : []; syncOvConfigs(); }, 'space-separated'));
                                }

                                ovCardsContainer.appendChild(card);
                            });

                            const addBtn = document.createElement('button');
                            addBtn.textContent = '+ Add Output Validator';
                            addBtn.style.cssText = 'background: none; border: 1px dashed var(--vscode-panel-border, #555); color: var(--vscode-foreground); padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; width: 100%;';
                            addBtn.addEventListener('click', () => {
                                ovParsed.push({ kind: 'cmd', cmd: '', args: [], ports: [], maxRepairAttempts: 2, severityThreshold: 'error', languageId: '', extraFlags: [] });
                                syncOvConfigs();
                                renderOvCards();
                            });
                            ovCardsContainer.appendChild(addBtn);
                        };
                        renderOvCards();

                        ovContent.appendChild(ovCardsContainer);
                        ovRow.appendChild(ovHead);
                        ovRow.appendChild(ovContent);
                        body.appendChild(ovRow);

                        // 3. Model Configuration (2-column layout)
                        const modelGrid = document.createElement('div');
                        modelGrid.style.display = 'grid';
                        modelGrid.style.gridTemplateColumns = '1fr 1fr';
                        modelGrid.style.gap = '8px';
                        modelGrid.style.marginBottom = '8px';

                        const createField = (key: string, label: string, placeholder: string) => {
                            const wrapper = document.createElement('div');
                            wrapper.style.display = 'flex';
                            wrapper.style.flexDirection = 'column';
                            wrapper.style.gap = '4px';

                            const l = document.createElement('div');
                            l.textContent = label;
                            l.style.fontSize = '10px';
                            l.style.opacity = '0.8';
                            l.style.fontWeight = '500';

                            const inp = document.createElement('input');
                            inp.className = 'annotation-input';
                            inp.placeholder = placeholder;
                            inp.style.width = '100%';
                            inp.style.boxSizing = 'border-box';
                            inp.value = this.stripQuotesIfStringLiteral(argsMap.get(key) ?? '');
                            inp.addEventListener('input', () => {
                                const val = inp.value.trim();
                                if (val) argsMap.set(key, this.toWfStringLiteral(val));
                                else argsMap.delete(key);
                            });

                            wrapper.appendChild(l);
                            wrapper.appendChild(inp);
                            return wrapper;
                        };

                        // Dropdown for enum-valued @agent args. `defaultValue` is the value
                        // that means "unset" (omitted from source); selecting it deletes the arg.
                        const createSelect = (
                            key: string,
                            label: string,
                            options: Array<{ value: string; label: string; group?: string }>,
                            defaultValue: string,
                            onChange?: (value: string) => void
                        ) => {
                            const wrapper = document.createElement('div');
                            wrapper.style.display = 'flex';
                            wrapper.style.flexDirection = 'column';
                            wrapper.style.gap = '4px';

                            const l = document.createElement('div');
                            l.textContent = label;
                            l.style.fontSize = '10px';
                            l.style.opacity = '0.8';
                            l.style.fontWeight = '500';

                            const sel = document.createElement('select');
                            sel.className = 'annotation-input';
                            sel.style.width = '100%';
                            sel.style.boxSizing = 'border-box';
                            // Render <optgroup>s when options declare a group, so distinct
                            // categories (e.g. API vs CLI vs ACP transport) read as distinct.
                            const optGroups = new Map<string, HTMLOptGroupElement>();
                            for (const opt of options) {
                                const o = document.createElement('option');
                                o.value = opt.value;
                                o.textContent = opt.label;
                                if (opt.group) {
                                    let og = optGroups.get(opt.group);
                                    if (!og) {
                                        og = document.createElement('optgroup');
                                        og.label = opt.group;
                                        optGroups.set(opt.group, og);
                                        sel.appendChild(og);
                                    }
                                    og.appendChild(o);
                                } else {
                                    sel.appendChild(o);
                                }
                            }
                            const current = this.stripQuotesIfStringLiteral(argsMap.get(key) ?? '').trim();
                            sel.value = options.some((o) => o.value === current) ? current : defaultValue;
                            sel.addEventListener('change', () => {
                                const val = sel.value;
                                if (val && val !== defaultValue) {
                                    argsMap.set(key, this.toWfStringLiteral(val));
                                } else {
                                    argsMap.delete(key);
                                }
                                onChange?.(val);
                            });

                            wrapper.appendChild(l);
                            wrapper.appendChild(sel);
                            return wrapper;
                        };

                        modelGrid.appendChild(createField('model', 'Model', 'e.g. gpt-4'));
                        modelGrid.appendChild(createField('provider', 'Provider', 'e.g. openai'));
                        body.appendChild(modelGrid);

                        // 4. Endpoint (Full Width)
                        const epRow = document.createElement('div');
                        epRow.style.marginBottom = '12px';
                        
                        const epLabel = document.createElement('div');
                        epLabel.textContent = 'Endpoint';
                        epLabel.style.fontSize = '10px';
                        epLabel.style.opacity = '0.8';
                        epLabel.style.fontWeight = '500';
                        epLabel.style.marginBottom = '4px';

                        const epInput = document.createElement('input');
                        epInput.className = 'annotation-input';
                        epInput.placeholder = 'https://api.openai.com/v1';
                        epInput.style.width = '100%';
                        epInput.style.boxSizing = 'border-box';
                        epInput.value = this.stripQuotesIfStringLiteral(argsMap.get('endpoint') ?? '');
                        epInput.addEventListener('input', () => {
                             const val = epInput.value.trim();
                             if (val) argsMap.set('endpoint', this.toWfStringLiteral(val));
                             else argsMap.delete('endpoint');
                        });
                        
                        epRow.appendChild(epLabel);
                        epRow.appendChild(epInput);
                        body.appendChild(epRow);

                        // 5. Execution Settings (Grid: Timeout, Budget, Stateful)
                        const execGrid = document.createElement('div');
                        execGrid.style.display = 'grid';
                        execGrid.style.gridTemplateColumns = '1fr 1fr auto';
                        execGrid.style.gap = '8px';
                        execGrid.style.alignItems = 'end'; // Align checkbox with inputs
                        execGrid.style.paddingTop = '4px';
                        execGrid.style.borderTop = '1px solid var(--vscode-editorWidget-border)';

                        // Timeout
                        const timeoutWrapper = document.createElement('div');
                        timeoutWrapper.style.display = 'flex';
                        timeoutWrapper.style.flexDirection = 'column';
                        timeoutWrapper.style.gap = '4px';
                        const timeoutLabel = document.createElement('div');
                        timeoutLabel.textContent = 'Timeout (ms)';
                        timeoutLabel.style.fontSize = '10px';
                        timeoutLabel.style.opacity = '0.8';
                        const timeoutInput = document.createElement('input');
                        timeoutInput.type = 'number';
                        timeoutInput.className = 'annotation-input';
                        timeoutInput.placeholder = '30000';
                        timeoutInput.style.width = '100%';
                        timeoutInput.style.boxSizing = 'border-box';
                        timeoutInput.value = argsMap.get('timeoutMs') ?? '';
                        timeoutInput.addEventListener('input', () => {
                            const val = timeoutInput.value.trim();
                            if (val) argsMap.set('timeoutMs', val);
                            else argsMap.delete('timeoutMs');
                        });
                        timeoutWrapper.appendChild(timeoutLabel);
                        timeoutWrapper.appendChild(timeoutInput);
                        execGrid.appendChild(timeoutWrapper);

                        // Budget
                        const budgetWrapper = document.createElement('div');
                        budgetWrapper.style.display = 'flex';
                        budgetWrapper.style.flexDirection = 'column';
                        budgetWrapper.style.gap = '4px';
                        const budgetLabel = document.createElement('div');
                        budgetLabel.textContent = 'Context Budget';
                        budgetLabel.style.fontSize = '10px';
                        budgetLabel.style.opacity = '0.8';
                        const budgetInput = document.createElement('input');
                        budgetInput.type = 'number';
                        budgetInput.className = 'annotation-input';
                        budgetInput.placeholder = '20';
                        budgetInput.style.width = '100%';
                        budgetInput.style.boxSizing = 'border-box';
                        budgetInput.value = argsMap.get('contextBudget') ?? '';
                        budgetInput.addEventListener('input', () => {
                            const val = budgetInput.value.trim();
                            if (val) argsMap.set('contextBudget', val);
                            else argsMap.delete('contextBudget');
                        });
                        budgetWrapper.appendChild(budgetLabel);
                        budgetWrapper.appendChild(budgetInput);
                        execGrid.appendChild(budgetWrapper);

                        // Stateful Toggle
                        const statefulWrapper = document.createElement('div');
                        statefulWrapper.style.display = 'flex';
                        statefulWrapper.style.flexDirection = 'column';
                        statefulWrapper.style.gap = '4px';
                        statefulWrapper.style.alignItems = 'center';

                        const statefulLabel = document.createElement('div');
                        statefulLabel.textContent = 'Stateful';
                        statefulLabel.style.fontSize = '10px';
                        statefulLabel.style.opacity = '0.8';
                        
                        const toggleLabel = document.createElement('label');
                        toggleLabel.style.display = 'inline-block';
                        toggleLabel.style.position = 'relative';
                        toggleLabel.style.width = '32px';
                        toggleLabel.style.height = '18px';
                        toggleLabel.style.marginBottom = '3px'; // align with input height

                        const toggleInput = document.createElement('input');
                        toggleInput.type = 'checkbox';
                        toggleInput.style.opacity = '0';
                        toggleInput.style.width = '0';
                        toggleInput.style.height = '0';
                        toggleInput.checked = (argsMap.get('stateful') ?? '').trim() === 'true';

                        const toggleSlider = document.createElement('span');
                        toggleSlider.style.position = 'absolute';
                        toggleSlider.style.cursor = 'pointer';
                        toggleSlider.style.top = '0';
                        toggleSlider.style.left = '0';
                        toggleSlider.style.right = '0';
                        toggleSlider.style.bottom = '0';
                        toggleSlider.style.backgroundColor = 'var(--vscode-input-background)';
                        toggleSlider.style.border = '1px solid var(--vscode-input-border)';
                        toggleSlider.style.transition = '.2s';
                        toggleSlider.style.borderRadius = '18px';

                        const toggleKnob = document.createElement('span');
                        toggleKnob.style.position = 'absolute';
                        toggleKnob.style.content = '""';
                        toggleKnob.style.height = '12px';
                        toggleKnob.style.width = '12px';
                        toggleKnob.style.left = '3px';
                        toggleKnob.style.bottom = '2px';
                        toggleKnob.style.backgroundColor = 'var(--vscode-foreground)';
                        toggleKnob.style.transition = '.2s';
                        toggleKnob.style.borderRadius = '50%';
                        toggleKnob.style.opacity = '0.6';

                        // Toggle Logic
                        const updateToggle = () => {
                            if (toggleInput.checked) {
                                toggleSlider.style.backgroundColor = 'var(--vscode-button-background)';
                                toggleKnob.style.transform = 'translateX(14px)';
                                toggleKnob.style.backgroundColor = 'var(--vscode-button-foreground)';
                                toggleKnob.style.opacity = '1';
                            } else {
                                toggleSlider.style.backgroundColor = 'var(--vscode-input-background)';
                                toggleKnob.style.transform = 'translateX(0)';
                                toggleKnob.style.backgroundColor = 'var(--vscode-foreground)';
                                toggleKnob.style.opacity = '0.6';
                            }
                            argsMap.set('stateful', toggleInput.checked ? 'true' : 'false');
                        };

                        toggleInput.addEventListener('change', updateToggle);
                        // Initial state
                        if (toggleInput.checked) {
                            toggleSlider.style.backgroundColor = 'var(--vscode-button-background)';
                            toggleKnob.style.transform = 'translateX(14px)';
                            toggleKnob.style.backgroundColor = 'var(--vscode-button-foreground)';
                             toggleKnob.style.opacity = '1';
                        }

                        toggleSlider.appendChild(toggleKnob);
                        toggleLabel.appendChild(toggleInput);
                        toggleLabel.appendChild(toggleSlider);
                        
                        statefulWrapper.appendChild(statefulLabel);
                        statefulWrapper.appendChild(toggleLabel);
                        execGrid.appendChild(statefulWrapper);

                        body.appendChild(execGrid);

                        // 6. Context truncation + background execution
                        const advGrid = document.createElement('div');
                        advGrid.style.display = 'grid';
                        advGrid.style.gridTemplateColumns = '1fr 1fr';
                        advGrid.style.gap = '8px';
                        advGrid.style.marginTop = '8px';
                        advGrid.appendChild(createSelect('truncationStrategy', 'Truncation', [
                            { value: 'sliding', label: 'sliding' },
                            { value: 'summarize', label: 'summarize' }
                        ], 'sliding'));

                        const fireableWrapper = document.createElement('div');
                        fireableWrapper.style.display = 'flex';
                        fireableWrapper.style.flexDirection = 'column';
                        fireableWrapper.style.gap = '4px';
                        const fireableLabel = document.createElement('div');
                        fireableLabel.textContent = 'Fireable w/o input';
                        fireableLabel.style.fontSize = '10px';
                        fireableLabel.style.opacity = '0.8';
                        fireableLabel.style.fontWeight = '500';
                        const fireableInput = document.createElement('input');
                        fireableInput.type = 'number';
                        fireableInput.min = '0';
                        fireableInput.className = 'annotation-input';
                        fireableInput.placeholder = '0';
                        fireableInput.style.width = '100%';
                        fireableInput.style.boxSizing = 'border-box';
                        fireableInput.value = argsMap.get('fireableWithoutInput') ?? '';
                        fireableInput.addEventListener('input', () => {
                            const val = fireableInput.value.trim();
                            if (val && val !== '0') argsMap.set('fireableWithoutInput', val);
                            else argsMap.delete('fireableWithoutInput');
                        });
                        fireableWrapper.appendChild(fireableLabel);
                        fireableWrapper.appendChild(fireableInput);
                        advGrid.appendChild(fireableWrapper);
                        body.appendChild(advGrid);

                        // 7. Backend transport. Three distinct categories — a REST API call
                        // (http), a one-shot CLI subprocess (*-cli), or a persistent ACP protocol
                        // session (opencode-acp) — so they're grouped, and the CLI-only tooling
                        // below dims when the HTTP API is selected (it doesn't apply there).
                        const backendGrid = document.createElement('div');
                        backendGrid.style.display = 'grid';
                        backendGrid.style.gridTemplateColumns = '1fr 1fr';
                        backendGrid.style.gap = '8px';
                        backendGrid.style.marginTop = '8px';

                        const noneSentinel = clientBehavior().noneSentinel;
                        const cliToolsOptions = [
                            ...(noneSentinel ? [{ value: noneSentinel, label: noneSentinel }] : []),
                            { value: 'native', label: 'native' }
                        ];
                        const cliToolsWrap = createSelect('cliToolsMode', 'CLI Tools', cliToolsOptions, noneSentinel ?? 'native');
                        const reasoningWrap = createSelect('reasoningEffort', 'Reasoning', [
                            { value: '', label: 'default' },
                            { value: 'minimal', label: 'minimal' },
                            { value: 'high', label: 'high' },
                            { value: 'max', label: 'max' }
                        ], '');

                        // CLI Tools / Reasoning apply to the CLI + ACP transports, not the HTTP API.
                        const updateBackendRelevance = (transportVal: string): void => {
                            const isHttp = (transportVal || 'http') === 'http';
                            for (const w of [cliToolsWrap, reasoningWrap]) {
                                w.style.opacity = isHttp ? '0.45' : '1';
                                w.title = isHttp ? 'Applies to CLI / ACP transports, not the HTTP API' : '';
                                const s = w.querySelector('select') as HTMLSelectElement | null;
                                if (s) s.disabled = isHttp;
                            }
                        };

                        const transportWrap = createSelect('transport', 'Transport', [
                            { value: 'http', label: 'http', group: 'REST API' },
                            { value: 'opencode-acp', label: 'opencode-acp', group: 'ACP (protocol session)' },
                            { value: 'opencode-cli', label: 'opencode-cli', group: 'CLI (subprocess)' },
                            { value: 'claude-cli', label: 'claude-cli', group: 'CLI (subprocess)' },
                            { value: 'codex-cli', label: 'codex-cli', group: 'CLI (subprocess)' }
                        ], 'http', updateBackendRelevance);
                        updateBackendRelevance(this.stripQuotesIfStringLiteral(argsMap.get('transport') ?? '').trim() || 'http');

                        backendGrid.appendChild(transportWrap);
                        backendGrid.appendChild(cliToolsWrap);
                        backendGrid.appendChild(reasoningWrap);
                        body.appendChild(backendGrid);
                    }

                    if (name === 'path') {
                        if (argsMap.has('path') && !argsMap.has('paths')) {
                            argsMap.set('paths', argsMap.get('path') ?? '');
                            argsMap.delete('path');
                        }

                        const pathsContainer = document.createElement('div');
                        pathsContainer.className = 'annotation-args-container';

                        const pathsHeader = document.createElement('div');
                        pathsHeader.className = 'annotation-args-header';

                        const pathsTitle = document.createElement('div');
                        pathsTitle.className = 'annotation-args-title';
                        pathsTitle.textContent = 'paths (list)';

                        const pathsMode = document.createElement('div');
                        pathsMode.className = 'annotation-args-mode';

                        const toRawBtn = document.createElement('button');
                        toRawBtn.type = 'button';
                        toRawBtn.className = 'mini-btn';
                        toRawBtn.textContent = 'Raw…';

                        const toListBtn = document.createElement('button');
                        toListBtn.type = 'button';
                        toListBtn.className = 'mini-btn';
                        toListBtn.textContent = 'List…';

                        pathsMode.appendChild(toListBtn);
                        pathsMode.appendChild(toRawBtn);
                        pathsHeader.appendChild(pathsTitle);
                        pathsHeader.appendChild(pathsMode);

                        const pathsHelp = document.createElement('div');
                        pathsHelp.className = 'annotation-args-help';
                        pathsHelp.textContent = 'Each row is a directory path (string literal).';

                        const pathsList = document.createElement('div');
                        pathsList.className = 'annotation-args-list';

                        const addPathBtn = document.createElement('button');
                        addPathBtn.type = 'button';
                        addPathBtn.className = 'mini-btn';
                        addPathBtn.textContent = 'Add path';

                        const rawRow = document.createElement('div');
                        rawRow.className = 'annotation-field';
                        const rawLabel = document.createElement('div');
                        rawLabel.className = 'annotation-label';
                        rawLabel.textContent = 'paths (expression)';
                        const rawTextarea = document.createElement('textarea');
                        rawTextarea.className = 'annotation-input annotation-textarea';
                        rawTextarea.rows = 3;
                        rawTextarea.placeholder = 'e.g. ["./bin", "./tools"]';
                        rawRow.appendChild(rawLabel);
                        rawRow.appendChild(rawTextarea);

                        let pathItems: string[] = [];
                        let mode: 'list' | 'raw' = 'list';

                        const renderPathList = () => {
                            pathsList.innerHTML = '';
                            pathItems.forEach((val, idx) => {
                                const row = document.createElement('div');
                                row.className = 'annotation-args-item';

                                const idxEl = document.createElement('div');
                                idxEl.className = 'annotation-args-index';
                                idxEl.textContent = String(idx);

                                const inp = document.createElement('input');
                                inp.className = 'annotation-input annotation-args-input';
                                inp.value = val;
                                inp.placeholder = 'path';
                                inp.addEventListener('input', () => {
                                    pathItems[idx] = inp.value;
                                    argsMap.set('paths', this.serializeWfStringListExpr(pathItems));
                                });

                                const rm = document.createElement('button');
                                rm.type = 'button';
                                rm.className = 'mini-btn danger icon-only';
                                rm.title = 'Remove path';
                                rm.setAttribute('aria-label', 'Remove path');
                                const rmIcon = document.createElement('span');
                                rmIcon.className = 'codicon codicon-remove';
                                rm.appendChild(rmIcon);
                                rm.addEventListener('click', () => {
                                    pathItems.splice(idx, 1);
                                    argsMap.set('paths', this.serializeWfStringListExpr(pathItems));
                                    renderPathList();
                                });

                                row.appendChild(idxEl);
                                row.appendChild(inp);
                                row.appendChild(rm);
                                pathsList.appendChild(row);
                            });
                        };

                        const setMode = (next: 'list' | 'raw') => {
                            mode = next;
                            const showList = mode === 'list';
                            pathsList.style.display = showList ? '' : 'none';
                            addPathBtn.style.display = showList ? '' : 'none';
                            pathsHelp.style.display = showList ? '' : 'none';
                            rawRow.style.display = showList ? 'none' : '';
                        };

                        addPathBtn.addEventListener('click', () => {
                            pathItems.push('');
                            argsMap.set('paths', this.serializeWfStringListExpr(pathItems));
                            renderPathList();
                        });

                        rawTextarea.addEventListener('input', () => {
                            argsMap.set('paths', rawTextarea.value);
                        });

                        toRawBtn.addEventListener('click', () => {
                            rawTextarea.value = argsMap.get('paths') ?? '';
                            setMode('raw');
                        });

                        toListBtn.addEventListener('click', () => {
                            const parsed = this.tryParseWfStringListExpr(argsMap.get('paths') ?? '');
                            if (!parsed) {
                                VscodeUi.instance.infoMessage('Cannot switch to list mode: paths is not a list of string literals.');
                                setMode('raw');
                                return;
                            }
                            pathItems = parsed;
                            argsMap.set('paths', this.serializeWfStringListExpr(pathItems));
                            renderPathList();
                            setMode('list');
                        });

                        const initialPathsExpr = argsMap.get('paths') ?? '';
                        const parsed = this.tryParseWfStringListExpr(initialPathsExpr);
                        if (parsed) {
                            pathItems = parsed;
                            argsMap.set('paths', this.serializeWfStringListExpr(pathItems));
                            renderPathList();
                            setMode('list');
                        } else {
                            rawTextarea.value = initialPathsExpr;
                            setMode('raw');
                        }

                        pathsContainer.appendChild(pathsHeader);
                        pathsContainer.appendChild(pathsHelp);
                        pathsContainer.appendChild(pathsList);
                        pathsContainer.appendChild(addPathBtn);
                        pathsContainer.appendChild(rawRow);
                        body.appendChild(pathsContainer);
                    }

                    // Show remaining args (custom annotation args, or tool extras)
                    const reserved = new Set(
                        name === 'tool'
                            ? ['cmd', 'args', 'inheritStdio']
                            : (name === 'path'
                                ? ['paths', 'path']
                                : (name === 'agent' ? [
                                    // Identity / model
                                    'prompt', 'claudeAgent', 'skill', 'model', 'provider', 'endpoint',
                                    'timeoutMs', 'contextBudget', 'stateful',
                                    // Backend / runtime controls (dropdowns above)
                                    'truncationStrategy', 'fireableWithoutInput', 'transport', 'cliToolsMode', 'reasoningEffort',
                                    // Sub-block toggles
                                    'useClaudeAgent', 'useSkill', 'usePrompt', 'useSkillHooks',
                                    // MCP block
                                    'useMcp', 'mcpServers', 'mcpServerConfigs', 'mcpTransport',
                                    // LSP block (+ shorthand scalars)
                                    'useLsp', 'lspServers', 'lspServerConfigs', 'lspCommand', 'lspArgs',
                                    'lspLanguageId', 'lspExtraFlags', 'lspPort', 'lspSeverityThreshold', 'lspMaxRepairAttempts',
                                    // Output validators editor
                                    'outputValidators'
                                ] : []))
                    );
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

    protected describeSkillStatus(skill: WorkflowAgentSkill): string {
        const desc = (skill.description ?? '').trim();
        if (desc) {
            return desc;
        }
        return skill.hasSkillMd
            ? `Skill '${skill.name}' has no description in SKILL.md.`
            : `Skill '${skill.name}' is missing SKILL.md.`;
    }

    protected skillWarningSummary(skill: WorkflowAgentSkill): string {
        const warnings: string[] = [];
        if (!skill.hasSkillMd) {
            warnings.push('SKILL.md missing');
        }
        if ((skill.missingDeclaredHooks?.length ?? 0) > 0) {
            warnings.push(`Missing scripts: ${skill.missingDeclaredHooks?.join(', ')}`);
        }
        if ((skill.warnings?.length ?? 0) > 0) {
            warnings.push(...(skill.warnings ?? []));
        }
        return warnings.join(' | ');
    }

    protected primeAgentSkillsCacheFromRoot(): void {
        const rootArgs = (this.lastRoot as any)?.args as Record<string, unknown> | undefined;
        const raw = typeof rootArgs?.['wf:agentSkillsSnapshot'] === 'string'
            ? String(rootArgs['wf:agentSkillsSnapshot'])
            : '';
        if (!raw) {
            return;
        }
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                return;
            }
            const skills = parsed as WorkflowAgentSkill[];
            // An empty snapshot must not clobber a cache the on-demand request already populated
            // (the snapshot is computed at model-load time and can lag behind live discovery).
            if (skills.length === 0) {
                return;
            }
            if (!this.lastRenderedNodeId) {
                return;
            }
            const store = (WorkflowShowAgentSkillsActionHandler as any).skillsByElementId;
            if (store && typeof store.set === 'function') {
                store.set(this.lastRenderedNodeId, skills);
            }
        } catch {
            // ignore best-effort snapshot parse
        }
    }

    protected primeClaudeAgentsCacheFromRoot(): void {
        const rootArgs = (this.lastRoot as any)?.args as Record<string, unknown> | undefined;
        const raw = typeof rootArgs?.['wf:claudeAgentsSnapshot'] === 'string'
            ? String(rootArgs['wf:claudeAgentsSnapshot'])
            : '';
        if (!raw) {
            return;
        }
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                return;
            }
            const agents = parsed as WorkflowClaudeAgentProfile[];
            // Don't let an empty snapshot clobber a cache the on-demand request already populated.
            if (agents.length === 0) {
                return;
            }
            if (!this.lastRenderedNodeId) {
                return;
            }
            const store = (WorkflowShowClaudeAgentsActionHandler as any).agentsByElementId;
            if (store && typeof store.set === 'function') {
                store.set(this.lastRenderedNodeId, agents);
            }
        } catch {
            // ignore best-effort snapshot parse
        }
    }

    protected extractConfiguredSkillName(agentSpec: Record<string, unknown> | undefined): string {
        if (!agentSpec || typeof agentSpec !== 'object') {
            return '';
        }
        const raw = agentSpec['skill'];
        if (typeof raw === 'string') {
            return raw.trim();
        }
        return '';
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected buildDefinitionParametersSection(elementId: string, args: any): HTMLElement {
        const defParams = (args?.[WorkflowDiagramMetadata.ENTITY_DEFINITION_PARAMETERS] as any[]) || [];
        const isNetworkModelInstance = this.isNetworkRuntime()
            && args?.[WorkflowDiagramMetadata.IS_NETWORK_INSTANCE] === true;

        const section = this.createSection(
            isNetworkModelInstance
                ? `Network Parameters (${Array.isArray(defParams) ? defParams.length : 0})`
                : `Definition Parameters (${Array.isArray(defParams) ? defParams.length : 0})`
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
            { body: this.definitionParamEditorBody(elementId, rows, 'No parameters on the referenced definition.') }
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

        const section = this.createSection(`${this.isNetworkRuntime() ? 'Network' : 'Workflow'} Parameters (${parameters.length})`);
        if (!factoryName) {
            for (const parameter of parameters) {
                const value = parameter.valueText || '(unspecified)';
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

        const basicSection = this.createSection(usesNetworkModel ? 'Network' : 'Workflow');
        this.addProperty(basicSection, 'Name', workflowName ?? '(unknown)');
        if (factoryName) {
            this.addProperty(basicSection, 'Factory', factoryName);
        }
        if (referencedUri) {
            this.addProperty(basicSection, 'Source', referencedUri);
        }
        content.appendChild(basicSection);

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

    protected buildGraphLoadIssuesSection(rootArgs: Record<string, unknown>): HTMLElement | undefined {
        const partial = rootArgs['wf:partial'] === true;
        const errors = this.normalizeGraphLoadErrors(rootArgs['wf:errors']);
        if (!partial && errors.length === 0) {
            return undefined;
        }

        const section = this.createSection('Graph Load Issues');
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
        const section = this.createSection(title);
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

            const typeField = document.createElement('button');
            typeField.type = 'button';
            typeField.className = 'port-field port-type';
            typeField.title = 'Double-click to change type';
            typeField.textContent = portType;
            typeField.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                void this.actionDispatcher.dispatch({
                    kind: WorkflowPromptLabelEditAction.KIND,
                    labelId: `${node.id}_label_type`,
                    title: 'Change Port Type',
                    value: portType
                } as any);
            });

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

    protected createSection(title: string): HTMLElement {
        const section = document.createElement('div');
        section.className = 'property-section';
        
        const header = document.createElement('div');
        header.className = 'property-section-header';
        const titleEl = document.createElement('span');
        titleEl.className = 'section-title';
        titleEl.textContent = title;
        const chevron = document.createElement('span');
        chevron.className = 'section-icon codicon codicon-chevron-down';
        header.appendChild(chevron);
        header.appendChild(titleEl);
        header.onclick = (e) => {
            // Don't collapse when clicking a header action button.
            if ((e.target as HTMLElement).closest('.section-actions')) return;
            section.classList.toggle('collapsed');
        };
        section.appendChild(header);
        
        const content = document.createElement('div');
        content.className = 'property-section-content';
        section.appendChild(content);
        
        return section;
    }

    /**
     * Build a collapsible section whose body (and optional header action) is a
     * declarative Lit template. Reuses createSection so collapse + chevron work.
     */
    protected litSection(
        title: string,
        opts: { headerAction?: TemplateResult; body: TemplateResult; extraClass?: string }
    ): HTMLElement {
        const section = this.createSection(title);
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

    /** Basic Info section: name, type (kind + chip + Change), optional skill status. */
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
            skillStatus?: string;
        }
    ): HTMLElement {
        const onChange = () =>
            void this.actionDispatcher.dispatch(
                WorkflowRequestWorkspaceEntitiesOperation.create({
                    elementId: node.id,
                    expectedType: info.isNetworkInstance ? 'workflow' : 'task',
                    currentType: info.entityType,
                })
            );
        const body = html`
            <div class="pp-arow">
                <span class="pp-akey">Name</span>
                <span class="pp-aval">${info.entityName}</span>
            </div>
            <div class="pp-arow">
                <span class="pp-akey">Type</span>
                <span class="pp-aval">
                    <span>${info.typeLabel}</span>
                    <code class="pp-chip" title=${info.typeBadge}>${info.typeBadge}</code>
                    ${info.isBoundary
                        ? nothing
                        : html`<button
                              class="pp-icon-btn pp-change"
                              title="Change referenced type"
                              @click=${onChange}
                          >
                              <span class="codicon codicon-edit"></span>
                          </button>`}
                </span>
            </div>
            ${info.skillStatus
                ? html`<div class="pp-arow">
                      <span class="pp-akey">Skill</span>
                      <span class="pp-aval pp-aval-wrap">${info.skillStatus}</span>
                  </div>`
                : nothing}
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
        return this.litSection(`${label} (${ports.length})`, { headerAction, body });
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

    protected escapeHtml(unsafe: string): string {
        if (!unsafe) return '';
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    /**
     * Header row for an item card in a list editor (MCP / LSP / Output Validators):
     * the item's title on the left, a remove button on the right, in normal flow.
     * Replaces the old absolutely-positioned X that floated over the first field and
     * clipped (tooltip and all) at the panel's right edge.
     */
    private buildRemovableCardHeader(noun: string, title: string, onRemove: () => void): HTMLElement {
        const header = document.createElement('div');
        header.className = 'pp-card-head';
        const titleEl = document.createElement('span');
        titleEl.className = 'pp-card-title';
        titleEl.textContent = title;
        const rm = document.createElement('button');
        rm.className = 'mini-btn icon-only danger';
        rm.innerHTML = '<span class="codicon codicon-close"></span>';
        rm.title = `Remove this ${noun}`;
        rm.setAttribute('aria-label', `Remove this ${noun}`);
        rm.addEventListener('click', onRemove);
        header.appendChild(titleEl);
        header.appendChild(rm);
        return header;
    }

    /**
     * Inline "Removed … · Undo" bar for the list editors, so an accidental card
     * removal is recoverable. Returns the bar element; the caller owns the snapshot
     * state plus the restore (`onUndo`) and dismiss (`onDismiss`) behaviour.
     */
    private buildCardUndoBar(noun: string, removedTitle: string, onUndo: () => void, onDismiss: () => void): HTMLElement {
        const bar = document.createElement('div');
        bar.className = 'pp-undo-bar';
        const msg = document.createElement('span');
        msg.className = 'pp-undo-msg';
        const named = (removedTitle ?? '').trim();
        msg.textContent = named ? `Removed “${named}”.` : `Removed ${noun}.`;
        const actions = document.createElement('div');
        actions.className = 'pp-undo-actions';
        const undoBtn = document.createElement('button');
        undoBtn.className = 'mini-btn';
        undoBtn.textContent = 'Undo';
        undoBtn.title = `Restore this ${noun}`;
        undoBtn.addEventListener('click', onUndo);
        const dismissBtn = document.createElement('button');
        dismissBtn.className = 'mini-btn icon-only';
        dismissBtn.innerHTML = '<span class="codicon codicon-close"></span>';
        dismissBtn.title = 'Dismiss';
        dismissBtn.setAttribute('aria-label', 'Dismiss');
        dismissBtn.addEventListener('click', onDismiss);
        actions.appendChild(undoBtn);
        actions.appendChild(dismissBtn);
        bar.appendChild(msg);
        bar.appendChild(actions);
        return bar;
    }

    private stripQuotesIfStringLiteral(expr: string): string {
        const trimmed = (expr ?? '').trim();
        if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
            const inner = trimmed.slice(1, -1);
            let out = '';
            for (let i = 0; i < inner.length; i++) {
                const ch = inner[i];
                if (ch !== '\\') {
                    out += ch;
                    continue;
                }
                const next = inner[i + 1];
                if (next === undefined) {
                    out += '\\';
                    continue;
                }
                if (next === 'n') {
                    out += '\n';
                    i++;
                    continue;
                }
                if (next === 'r') {
                    out += '\r';
                    i++;
                    continue;
                }
                if (next === 't') {
                    out += '\t';
                    i++;
                    continue;
                }
                if (next === '"' || next === '\\') {
                    out += next;
                    i++;
                    continue;
                }
                out += next;
                i++;
            }
            return out;
        }
        return trimmed;
    }

    private toWfStringLiteral(value: string): string {
        const s = (value ?? '')
            .replace(/\\/g, '\\\\')
            .replace(/\r/g, '\\r')
            .replace(/\n/g, '\\n')
            .replace(/\t/g, '\\t')
            .replace(/"/g, '\\"');
        return `"${s}"`;
    }

    private normalizeMultilineStringForEditor(value: string): string {
        const normalized = (value ?? '').replace(/\r\n?/g, '\n');
        if (!normalized.includes('\n')) {
            return normalized;
        }

        const lines = normalized.split('\n');
        if (lines.length <= 1) {
            return normalized;
        }

        const trailing = lines.slice(1);
        const nonEmptyTrailing = trailing.filter(line => line.trim().length > 0);
        if (nonEmptyTrailing.length === 0) {
            return normalized;
        }

        const minIndent = nonEmptyTrailing.reduce((min, line) => {
            const m = line.match(/^[\t ]*/);
            const indent = m ? m[0].length : 0;
            return Math.min(min, indent);
        }, Number.POSITIVE_INFINITY);

        if (!Number.isFinite(minIndent) || minIndent <= 0) {
            return normalized;
        }

        const dedentedTrailing = trailing.map(line => {
            if (line.trim().length === 0) {
                return '';
            }
            const m = line.match(/^[\t ]*/);
            const indent = m ? m[0].length : 0;
            return line.slice(Math.min(indent, minIndent));
        });

        return [lines[0], ...dedentedTrailing].join('\n');
    }

    private tryParseWfStringListExpr(expr: string): string[] | undefined {
        const trimmed = (expr ?? '').trim();
        if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
            return undefined;
        }

        // Very small parser for list of *string literals* only: ["a", "b"]
        // Supports escaped \" and \\ inside strings.
        const inner = trimmed.slice(1, -1).trim();
        if (!inner) {
            return [];
        }

        const items: string[] = [];
        let i = 0;
        const n = inner.length;
        const skipWs = () => {
            while (i < n && /\s/.test(inner[i])) i++;
        };

        const parseString = (): string | undefined => {
            if (inner[i] !== '"') {
                return undefined;
            }
            i++; // skip opening quote
            let out = '';
            while (i < n) {
                const ch = inner[i];
                if (ch === '"') {
                    i++;
                    return out;
                }
                if (ch === '\\') {
                    const next = inner[i + 1];
                    if (next === '"' || next === '\\') {
                        out += next;
                        i += 2;
                        continue;
                    }
                    // Unknown escape: keep as-is.
                    out += ch;
                    i++;
                    continue;
                }
                out += ch;
                i++;
            }
            return undefined;
        };

        while (i < n) {
            skipWs();
            const s = parseString();
            if (s === undefined) {
                return undefined;
            }
            items.push(s);
            skipWs();
            if (i >= n) {
                break;
            }
            if (inner[i] === ',') {
                i++;
                continue;
            }
            // Unexpected token.
            return undefined;
        }
        return items;
    }

    private serializeWfStringListExpr(items: string[]): string {
        const parts = (items ?? []).map(v => this.toWfStringLiteral(v));
        return `[${parts.join(', ')}]`;
    }

    private buildParameterDefinitionText(name: string, typeText: string, defaultText: string): string {
        const head = typeText ? `${name}: ${typeText}` : name;
        if (!defaultText) {
            return head;
        }
        return `${head} = ${defaultText}`;
    }
}
