/**
 * The agent sections of a node's panel: Basic Info's Skill row, Agent Tools
 * (after Annotations) and the live Agent Context (last), with the skills and
 * agent presets taken from the root's snapshots before a node is drawn and the
 * redraw when discovery answers for the node shown.
 */
import { html, render, nothing, type TemplateResult } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { looksLikeDiff, isBlock, parseEmbedded } from '../agent-outputs';
import { renderMarkdownSafe, looksLikeMarkdown as looksLikeMarkdownShared } from '../markdown';
import { renderInto } from '../property-fields';
import type { PropertyElement } from '../property-model';
import { createPropertySection, escapeHtml, shortenPath } from '../property-section';
import { commandId, offersRun } from '../profile';
import { VscodeUi } from '../vscode-ui';
import type { NodeInfoRow, NodeSectionContext, NodeSectionContribution, NodeSectionHost, PanelModelRoot } from '../node-section';
import {
    type WorkflowAgentSkill,
    type WorkflowClaudeAgentProfile,
    WorkflowShowAgentSkillsActionHandler,
    WorkflowShowClaudeAgentsActionHandler
} from '../editing-action-handlers';
import { describeSkillStatus } from './agent-editor';

export class AgentNodeSections implements NodeSectionContribution {
    /** The chat history the Agent Context last drew, so it redraws only when that changes. */
    private lastHistoryJson: string | undefined;

    install(host: NodeSectionHost): void {
        window.addEventListener('dialogram.agentSkills.updated', (event: Event) => {
            const detail = (event as CustomEvent<{ elementId?: string }>).detail;
            const elementId = typeof detail?.elementId === 'string' ? detail.elementId : undefined;
            if (elementId) {
                host.redrawIfShowing(elementId);
            }
        });
    }

    prepare(node: PropertyElement, root: PanelModelRoot | undefined): void {
        this.primeAgentSkillsCacheFromRoot(node, root);
        this.primeClaudeAgentsCacheFromRoot(node, root);
    }

    /** The configured skill's status; also written back into args for downstream consumers. */
    infoRows(node: PropertyElement): readonly NodeInfoRow[] {
        const args = node.args || {};
        const agentSpec = args['wf:agentSpec'] as Record<string, unknown> | undefined;
        const configuredSkill = this.extractConfiguredSkillName(agentSpec);
        if (!configuredSkill) {
            return [];
        }
        const discovered = WorkflowShowAgentSkillsActionHandler.getSkillsForElement(node.id);
        const matched = discovered.find((s) => s.name === configuredSkill);
        const skillStatus = matched
            ? describeSkillStatus(matched)
            : `Skill '${configuredSkill}' not discovered in configured roots.`;
        args[WorkflowDiagramMetadata.AGENT_SKILL_STATUS] = skillStatus;
        return [{ label: 'Skill', value: skillStatus }];
    }

    /** Agent Tools, for an @agent node where a run driver is behind the diagram: its two commands are the driver's. */
    afterAnnotations(node: PropertyElement, context: NodeSectionContext): HTMLElement | undefined {
        return offersRun() ? this.buildAgentToolsSection(context.entityName, node.args || {}) ?? undefined : undefined;
    }

    /** The live chat history of a stateful agent task. */
    last(node: PropertyElement): HTMLElement | undefined {
        const args = node.args || {};
        this.lastHistoryJson = args[WorkflowDiagramMetadata.AGENT_CHAT_HISTORY] as string | undefined;
        return this.buildAgentContextSection(args);
    }

    /** While a run streams, only the Agent Context changes: redraw it in place. */
    modelChanged(node: PropertyElement, content: HTMLElement): void {
        const historyJson = node.args?.[WorkflowDiagramMetadata.AGENT_CHAT_HISTORY] as string | undefined;
        if (historyJson !== this.lastHistoryJson) {
            this.lastHistoryJson = historyJson;
            this.refreshAgentContext(node, content);
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
    protected refreshAgentContext(node: any, content: HTMLElement): void {
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
        content.appendChild(section);
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
        const section = createPropertySection(this.agentSectionTitle(parsed));
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
                if (task) { metaDiv.innerHTML += `<span class="agent-json-tag">task</span> <span class="agent-json-val">${escapeHtml(task)}</span>`; }
                if (instance) { metaDiv.innerHTML += `<span class="agent-json-tag">instance</span> <span class="agent-json-val">${escapeHtml(instance)}</span>`; }
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
                    row.innerHTML = `<span class="agent-json-key">${escapeHtml(key)}</span>`;
                    const valSpan = document.createElement('span');
                    valSpan.className = 'agent-json-val';
                    valSpan.textContent = shortenPath(String(val));
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
                    fileHeader.innerHTML = `<span class="agent-json-file-icon codicon codicon-file"></span> <span class="agent-json-key">${escapeHtml(key)}</span> <span class="agent-json-file-name">${escapeHtml(shortenPath(filePath ?? key))}</span> <span class="agent-chat-expand-arrow codicon codicon-chevron-right"></span>`;
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
            // A port's value is itself JSON: unwrap it and show its fields
            // rather than one escaped line.
            const embedded = parseEmbedded(value);
            if (embedded !== value) {
                this.renderJsonTree(container, embedded, depth);
                return;
            }
            // A diff must not go through Markdown: its removed lines begin
            // with `-` and would render as a bullet list.
            if (looksLikeDiff(value) || isBlock(value)) {
                const pre = document.createElement('pre');
                pre.className = looksLikeDiff(value) ? 'agent-json-pre agent-json-diff' : 'agent-json-pre';
                pre.textContent = value.replace(/\s+$/, '');
                container.appendChild(pre);
                return;
            }
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

        const section = createPropertySection('Agent Tools');
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

    protected primeAgentSkillsCacheFromRoot(node: PropertyElement, root: PanelModelRoot | undefined): void {
        const rootArgs = (root as any)?.args as Record<string, unknown> | undefined;
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
            if (!node.id) {
                return;
            }
            const store = (WorkflowShowAgentSkillsActionHandler as any).skillsByElementId;
            if (store && typeof store.set === 'function') {
                store.set(node.id, skills);
            }
        } catch {
            // ignore best-effort snapshot parse
        }
    }

    protected primeClaudeAgentsCacheFromRoot(node: PropertyElement, root: PanelModelRoot | undefined): void {
        const rootArgs = (root as any)?.args as Record<string, unknown> | undefined;
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
            if (!node.id) {
                return;
            }
            const store = (WorkflowShowClaudeAgentsActionHandler as any).agentsByElementId;
            if (store && typeof store.set === 'function') {
                store.set(node.id, agents);
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
}
