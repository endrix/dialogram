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

@injectable()
export class RunningAgentsBar implements IDiagramStartup {
    private host?: HTMLElement;
    private scheduled = false;

    postModelInitialization(): void {
        this.ensureHost();
        window.addEventListener('dialogram.runAgents.updated', () => this.scheduleRender());
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
        const visible = active || agents.length > 0;
        // eslint-disable-next-line no-console
        console.log(`[wf-lang overlay] RunningAgentsBar render: agents=${agents.length} active=${active} visible=${visible}`);
        this.host.classList.toggle('hidden', !visible);
        if (!visible) {
            render(nothing, this.host);
            return;
        }
        render(this.template(agents, active), this.host);
        // Keep each streaming card pinned to the latest text.
        for (const box of Array.from(this.host.querySelectorAll<HTMLElement>('.wf-rab-text.stream'))) {
            box.scrollTop = box.scrollHeight;
        }
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
            <div class="wf-rab-card ${a.status}">
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
