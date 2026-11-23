/**
 * Read-only "Running agents" bar — live view of a running workflow's agents.
 *
 * The host forwards a run's SSE events (agent message deltas, reasoning, tool
 * calls, lifecycle) to the diagram client through the neutral execution-overlay
 * seam (EXECUTION_OVERLAY_ACTION_KIND); that handler folds them into per-instance
 * live state and fires `dialogram.runAgents.updated`.
 * This bar listens for that event and renders the agents' streaming output. It is
 * strictly read-only and lives in its own DOM host appended to <body> — outside the
 * Sprotty SVG canvas — so it cannot affect diagram rendering.
 */
import { IDiagramStartup } from '@eclipse-glsp/client';
import { injectable } from 'inversify';
import { html, render, nothing, type TemplateResult } from 'lit';
import { RunAgentStreamActionHandler, type LiveAgentState } from './editing-action-handlers';
import { FLOATING_PANELS_MOVED } from './floating-panels';

/** The bar's width when nothing is in its way (the stylesheet's). */
const BAR_WIDTH_PX = 340;
/** Narrower than this, the bar does not move aside: it would show too little. */
const BAR_MIN_WIDTH_PX = 240;
const BAR_GAP_PX = 12;

/**
 * Where the bar goes, given the open panels that float in the same corner
 * (the outlines beside the button lane, bottom right): left of the leftmost,
 * as wide as the room there allows. `undefined` keeps the stylesheet's place,
 * beside the button lane: no panel is open, or the room left of them is too
 * narrow, and then the outlines cover it until they close (the bar stays under
 * the floating panels, tooltips and the canvas's issue overlay).
 */
export function agentsBarPlacement(
    openPanels: ReadonlyArray<{ left: number; width: number }>,
    viewportWidth: number,
    canvasLeft = 0
): { right: number; width: number } | undefined {
    const shown = openPanels.filter(panel => panel.width > 0);
    if (shown.length === 0) {
        return undefined;
    }
    const leftmost = Math.min(...shown.map(panel => panel.left));
    const right = Math.round(viewportWidth - leftmost + BAR_GAP_PX);
    const room = Math.floor(leftmost - BAR_GAP_PX - canvasLeft - BAR_GAP_PX);
    if (room < BAR_MIN_WIDTH_PX) {
        return undefined;
    }
    return { right, width: Math.min(BAR_WIDTH_PX, room) };
}

@injectable()
export class RunningAgentsBar implements IDiagramStartup {
    private host?: HTMLElement;
    private scheduled = false;
    /** The chat panel shows a running agent: one place for the run, not two. */
    private behindChat = false;

    postModelInitialization(): void {
        this.ensureHost();
        window.addEventListener('dialogram.runAgents.updated', () => this.scheduleRender());
        window.addEventListener('dialogram.chat.runView', (e) => {
            this.behindChat = Boolean((e as CustomEvent<{ visible?: boolean }>).detail?.visible);
            this.scheduleRender();
        });
        // The outlines open in the same corner: keep clear of them.
        window.addEventListener(FLOATING_PANELS_MOVED, () => this.placeBesidePanels());
        window.addEventListener('resize', () => this.placeBesidePanels());
        this.scheduleRender();
        // eslint-disable-next-line no-console
        console.log('[wf-lang overlay] RunningAgentsBar mounted; listening for dialogram.runAgents.updated');
    }

    private ensureHost(): void {
        let el = document.getElementById('wf-running-agents-bar');
        if (!el) {
            el = document.createElement('div');
            el.id = 'wf-running-agents-bar';
            el.className = 'wf-running-agents-bar hidden';
            document.body.appendChild(el);
        }
        this.host = el;
    }

    private scheduleRender(): void {
        if (this.scheduled) {
            return;
        }
        this.scheduled = true;
        requestAnimationFrame(() => {
            this.scheduled = false;
            this.renderNow();
        });
    }

    private renderNow(): void {
        if (!this.host) {
            return;
        }
        const agents = RunAgentStreamActionHandler.getAgents();
        const active = RunAgentStreamActionHandler.isRunActive();
        const visible = !this.behindChat && (active || agents.length > 0);
        // eslint-disable-next-line no-console
        console.log(`[wf-lang overlay] RunningAgentsBar render: agents=${agents.length} active=${active} visible=${visible}`);
        this.host.classList.toggle('hidden', !visible);
        if (!visible) {
            render(nothing, this.host);
            return;
        }
        render(this.template(agents, active), this.host);
        this.placeBesidePanels();
        // Keep each streaming card pinned to the latest text.
        for (const box of Array.from(this.host.querySelectorAll<HTMLElement>('.wf-rab-text.stream'))) {
            box.scrollTop = box.scrollHeight;
        }
    }

    /** Beside the open outlines, not under them. */
    private placeBesidePanels(): void {
        const host = this.host;
        if (!host || host.classList.contains('hidden')) {
            return;
        }
        const open = Array.from(document.querySelectorAll<HTMLElement>('.workflow-hierarchy-outline'))
            .filter(panel => !panel.hidden)
            .map(panel => panel.getBoundingClientRect());
        // The canvas, not the window: a docked property panel takes part of the window.
        const canvas = document.querySelector<HTMLElement>('.sprotty-container')?.getBoundingClientRect();
        const place = agentsBarPlacement(open, window.innerWidth, canvas && canvas.width > 0 ? canvas.left : 0);
        host.style.right = place ? `${place.right}px` : '';
        host.style.width = place ? `${place.width}px` : '';
    }

    private template(agents: LiveAgentState[], active: boolean): TemplateResult {
        return html`
            <div class="wf-rab-head">
                <span class="codicon codicon-broadcast"></span>
                <span class="wf-rab-title">Running agents</span>
                <span class="wf-rab-count">${agents.length || ''}</span>
                ${active ? html`<span class="wf-rab-live">live</span>` : nothing}
                <button
                    class="wf-rab-close"
                    title="Hide (read-only view; clears when a new run starts)"
                    aria-label="Hide running agents"
                    @click=${() => RunAgentStreamActionHandler.reset()}
                >
                    <span class="codicon codicon-close"></span>
                </button>
            </div>
            <div class="wf-rab-body">
                ${agents.length === 0
                    ? html`<div class="wf-rab-empty">Waiting for agents…</div>`
                    : agents.map(a => this.card(a))}
            </div>
        `;
    }

    private card(a: LiveAgentState): TemplateResult {
        return html`
            <div
                class="wf-rab-card ${a.status}"
                title="Open in the chat"
                @click=${() => window.dispatchEvent(new CustomEvent('dialogram.chat.showAgent', { detail: { instance: a.instance } }))}
            >
                <div class="wf-rab-card-head">
                    <span class="wf-rab-dot ${a.status}"></span>
                    <span class="wf-rab-name" title=${a.instance}>${a.instance}</span>
                    ${a.toolCalls.length
                        ? html`<span class="wf-rab-tools" title=${a.toolCalls.join(', ')}>
                              <span class="codicon codicon-tools"></span>${a.toolCalls.length}
                          </span>`
                        : nothing}
                    <span class="wf-rab-status">${a.status === 'running' ? 'streaming…' : 'done'}</span>
                </div>
                ${a.reasoning
                    ? html`<details class="wf-rab-reasoning">
                          <summary>reasoning</summary>
                          <div class="wf-rab-text">${a.reasoning}</div>
                      </details>`
                    : nothing}
                <div class="wf-rab-text stream">${a.text || (a.status === 'running' ? '…' : '')}</div>
            </div>
        `;
    }
}
