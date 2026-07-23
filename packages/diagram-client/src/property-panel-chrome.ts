/**
 * Window-management ("chrome") for the properties panel: show/hide/pin, docked
 * resize + width persistence, floating mode, and header drag. Extracted from
 * PropertyPanel so that class can focus on *content* rendering.
 *
 * The chrome talks to the panel DOM directly (by id), localStorage, and the
 * document body — it has no dependency on the rendered content. Its only inbound
 * coupling is `getFallbackNodeId()` (to place the floating panel near the active
 * node when nothing is explicitly selected). The owning panel reads `pinned` /
 * `floatingMode`, sets `lastSelectedElement`, and calls `show()` /
 * `positionPanelNearElement()` from its selection flow.
 */
export class PropertyPanelChrome {
    /** Pinned: panel stays visible across selection changes (auto-shown on select). */
    pinned = false;

    /** Floating (Miro-style) vs docked-to-left-edge. */
    floatingMode = false;

    /** Last selected element, used to reposition the floating panel. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lastSelectedElement: any | undefined;

    private dragState: { startX: number; startY: number; panelStartX: number; panelStartY: number } | undefined;
    private panelResizeObserver: ResizeObserver | undefined;
    private panelResizeRaf: number | undefined;
    private lastSyncedPanelWidthPx: number | undefined;

    private static readonly VISIBLE_BODY_CLASS = 'workflow-properties-visible';
    private static readonly PANEL_WIDTH_CSS_VAR = '--workflow-property-panel-width';
    private static readonly PANEL_WIDTH_STORAGE_KEY = 'workflow.diagram.propertyPanel.widthPx';
    private static readonly FLOATING_MODE_STORAGE_KEY = 'workflow.diagram.propertyPanel.floatingMode';
    private static readonly PANEL_MIN_WIDTH_PX = 280;
    private static readonly PANEL_MAX_WIDTH_RATIO = 0.6;

    /** @param getFallbackNodeId active node id when no element is explicitly selected. */
    constructor(private readonly getFallbackNodeId: () => string | undefined) {}

    initialize(): void {
        this.initializePanelResize();
        this.initializeFloatingMode();

        const closeBtn = document.getElementById('btn-close-properties');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.hide());
        }

        const pinBtn = document.getElementById('btn-pin-properties');
        if (pinBtn) {
            pinBtn.addEventListener('click', () => this.togglePinned());
        }

        const floatBtn = document.getElementById('btn-float-properties');
        if (floatBtn) {
            floatBtn.addEventListener('click', () => this.toggleFloatingMode());
        }

        const toggleBtn = document.getElementById('btn-toggle-properties');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => this.toggle());
        }

        // 'P' toggles the panel (unless typing in a field).
        document.addEventListener('keydown', (e) => {
            if (e.key === 'p' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const activeElement = document.activeElement;
                if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
                    return;
                }
                this.toggle();
            }
        });

        // Ensure initial layout matches the initial DOM state.
        this.syncViewportLayoutFromDom();
    }

    // ── Docked resize + width persistence ───────────────────────────────

    private initializePanelResize(): void {
        const panel = document.getElementById('property-panel');
        if (!panel) {
            return;
        }

        const storedWidth = this.readStoredPanelWidthPx();
        if (storedWidth !== undefined) {
            this.applyPanelWidthPx(storedWidth, false);
        }

        if (typeof ResizeObserver !== 'undefined') {
            this.panelResizeObserver = new ResizeObserver((entries) => {
                const entry = entries[0];
                if (!entry) {
                    return;
                }
                this.applyPanelWidthPx(entry.contentRect.width, true);
            });
            this.panelResizeObserver.observe(panel);
        }

        window.addEventListener('resize', () => {
            if (this.lastSyncedPanelWidthPx !== undefined) {
                this.applyPanelWidthPx(this.lastSyncedPanelWidthPx, true);
            }
        });
    }

    private readStoredPanelWidthPx(): number | undefined {
        try {
            const raw = window.localStorage.getItem(PropertyPanelChrome.PANEL_WIDTH_STORAGE_KEY);
            if (!raw) {
                return undefined;
            }
            const parsed = Number(raw);
            return Number.isFinite(parsed) ? parsed : undefined;
        } catch {
            return undefined;
        }
    }

    private clampPanelWidthPx(rawWidthPx: number): number {
        const minWidth = PropertyPanelChrome.PANEL_MIN_WIDTH_PX;
        const maxByViewport = Math.max(minWidth, Math.floor(window.innerWidth * PropertyPanelChrome.PANEL_MAX_WIDTH_RATIO));
        return Math.max(minWidth, Math.min(maxByViewport, Math.round(rawWidthPx)));
    }

    private applyPanelWidthPx(rawWidthPx: number, persist: boolean): void {
        if (!Number.isFinite(rawWidthPx)) {
            return;
        }

        const panel = document.getElementById('property-panel');
        if (!panel) {
            return;
        }

        const clampedWidthPx = this.clampPanelWidthPx(rawWidthPx);
        if (this.lastSyncedPanelWidthPx === clampedWidthPx) {
            return;
        }

        this.lastSyncedPanelWidthPx = clampedWidthPx;
        const widthCss = `${clampedWidthPx}px`;

        panel.style.width = widthCss;
        document.documentElement.style.setProperty(PropertyPanelChrome.PANEL_WIDTH_CSS_VAR, widthCss);

        if (persist) {
            try {
                window.localStorage.setItem(PropertyPanelChrome.PANEL_WIDTH_STORAGE_KEY, String(clampedWidthPx));
            } catch {
                // Ignore storage failures in restricted environments.
            }
        }

        this.scheduleViewportResizeEvent();
    }

    private scheduleViewportResizeEvent(): void {
        if (this.panelResizeRaf !== undefined) {
            return;
        }
        this.panelResizeRaf = requestAnimationFrame(() => {
            this.panelResizeRaf = undefined;
            window.dispatchEvent(new Event('resize'));
        });
    }

    // ── Show / hide / pin ───────────────────────────────────────────────

    show(): void {
        const panel = document.getElementById('property-panel');
        if (panel) {
            panel.classList.remove('collapsed');
        }
        this.updateToggleButtonState(true);
    }

    hide(): void {
        const panel = document.getElementById('property-panel');
        // Option A: closing the panel also unpins it.
        this.pinned = false;

        const pinBtn = document.getElementById('btn-pin-properties');
        if (pinBtn) {
            pinBtn.classList.remove('pinned');
            pinBtn.title = 'Pin panel (keeps visible)';
        }

        if (panel) {
            panel.classList.remove('pinned');
            panel.classList.add('collapsed');
        }

        this.updateToggleButtonState(false);
    }

    toggle(): void {
        const panel = document.getElementById('property-panel');
        if (panel) {
            const isCollapsed = panel.classList.toggle('collapsed');
            this.updateToggleButtonState(!isCollapsed);
        }
    }

    private togglePinned(): void {
        this.pinned = !this.pinned;
        const pinBtn = document.getElementById('btn-pin-properties');
        const panel = document.getElementById('property-panel');
        if (pinBtn) {
            pinBtn.classList.toggle('pinned', this.pinned);
            pinBtn.title = this.pinned ? 'Unpin panel (auto-updates on selection)' : 'Pin panel (keeps visible)';
        }
        if (panel) {
            panel.classList.toggle('pinned', this.pinned);
        }

        // Pinned state should not change viewport layout by itself; only visibility does.
        this.syncViewportLayoutFromDom();
    }

    private updateToggleButtonState(isVisible: boolean): void {
        const toggleBtn = document.getElementById('btn-toggle-properties');
        if (toggleBtn) {
            toggleBtn.classList.toggle('active', isVisible);
            toggleBtn.title = isVisible ? 'Hide Properties' : 'Show Properties';
        }

        // Viewport layout should follow actual visibility.
        this.syncViewportLayoutFromDom();
    }

    private syncViewportLayoutFromDom(): void {
        const panel = document.getElementById('property-panel');
        const isVisible = !!panel && !panel.classList.contains('collapsed');
        // In floating mode the panel doesn't push the canvas.
        const reserveSpace = isVisible && !this.floatingMode;
        document.body.classList.toggle(PropertyPanelChrome.VISIBLE_BODY_CLASS, reserveSpace);

        // Force sprotty to recompute canvas bounds.
        // A microtask/RAF avoids measuring mid-transition.
        this.scheduleViewportResizeEvent();
    }

    // ── Floating mode + drag ────────────────────────────────────────────

    private initializeFloatingMode(): void {
        // Restore persisted floating state
        try {
            const stored = window.localStorage.getItem(PropertyPanelChrome.FLOATING_MODE_STORAGE_KEY);
            if (stored === 'true') {
                this.floatingMode = true;
                const panel = document.getElementById('property-panel');
                if (panel) {
                    panel.classList.add('floating');
                }
                this.updateFloatButtonState();
            }
        } catch { /* ignore */ }

        // Set up drag support on the panel header
        this.initializePanelDrag();
    }

    private toggleFloatingMode(): void {
        this.floatingMode = !this.floatingMode;
        const panel = document.getElementById('property-panel');
        if (panel) {
            panel.classList.toggle('floating', this.floatingMode);
            if (this.floatingMode) {
                // Position panel near last selected node
                this.positionPanelNearElement(panel);
                // Remove inline width set by docked resize
                panel.style.width = '';
            } else {
                // Re-dock: clear floating inline position
                panel.style.top = '';
                panel.style.left = '';
                panel.style.right = '';
                // Restore stored docked width
                const storedWidth = this.readStoredPanelWidthPx();
                if (storedWidth !== undefined) {
                    this.applyPanelWidthPx(storedWidth, false);
                }
            }
        }
        this.updateFloatButtonState();
        this.syncViewportLayoutFromDom();

        // Persist preference
        try {
            window.localStorage.setItem(PropertyPanelChrome.FLOATING_MODE_STORAGE_KEY, String(this.floatingMode));
        } catch { /* ignore */ }
    }

    private updateFloatButtonState(): void {
        const btn = document.getElementById('btn-float-properties');
        if (!btn) return;
        btn.classList.toggle('active', this.floatingMode);
        btn.title = this.floatingMode ? 'Dock panel to left edge' : 'Float panel near node';
        // Update icon
        const icon = btn.querySelector('.codicon');
        if (icon) {
            icon.className = this.floatingMode
                ? 'codicon codicon-layout-sidebar-left'
                : 'codicon codicon-move';
        }
    }

    /**
     * Position the floating panel near the currently selected sprotty node.
     * Falls back to viewport center if no node DOM element found.
     */
    positionPanelNearElement(panel: HTMLElement): void {
        const nodeId = this.lastSelectedElement?.id || this.getFallbackNodeId();
        if (nodeId) {
            // Sprotty prefixes element IDs with `${clientId}_`.
            // Try the prefixed ID first, then fall back to the raw ID.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const diagramId = (window as any).diagramIdentifier?.clientId;
            const prefixedId = diagramId ? `${diagramId}_${nodeId}` : nodeId;
            const svgEl = document.getElementById(prefixedId)
                       || document.getElementById(nodeId)
                       || document.querySelector(`[id$="_${CSS.escape(nodeId)}"]`) as SVGElement | null;
            if (svgEl) {
                const rect = svgEl.getBoundingClientRect();
                const panelWidth = 380;
                const panelHeight = 400;
                const gap = 16;
                let left = rect.right + gap;
                let top = rect.top;
                // Keep panel within viewport.
                if (left + panelWidth > window.innerWidth) {
                    left = rect.left - panelWidth - gap;
                }
                if (left < 0) left = gap;
                if (top + panelHeight > window.innerHeight) {
                    top = window.innerHeight - panelHeight - gap;
                }
                if (top < 0) top = gap;
                panel.style.top = `${Math.round(top)}px`;
                panel.style.left = `${Math.round(left)}px`;
                return;
            }
        }
        // Fallback: center in viewport
        panel.style.top = '80px';
        panel.style.left = `${Math.round(window.innerWidth / 2 - 190)}px`;
    }

    /** Make floating panel draggable by its header. */
    private initializePanelDrag(): void {
        const header = document.querySelector('.property-panel-header') as HTMLElement | null;
        if (!header) return;

        header.addEventListener('mousedown', (e: MouseEvent) => {
            if (!this.floatingMode) return;
            // Ignore clicks on buttons inside the header.
            if ((e.target as HTMLElement).closest('button')) return;

            const panel = document.getElementById('property-panel');
            if (!panel) return;

            e.preventDefault();
            header.style.cursor = 'grabbing';
            const panelRect = panel.getBoundingClientRect();
            this.dragState = {
                startX: e.clientX,
                startY: e.clientY,
                panelStartX: panelRect.left,
                panelStartY: panelRect.top
            };

            const onMouseMove = (ev: MouseEvent) => {
                if (!this.dragState) return;
                const dx = ev.clientX - this.dragState.startX;
                const dy = ev.clientY - this.dragState.startY;
                panel.style.left = `${this.dragState.panelStartX + dx}px`;
                panel.style.top = `${this.dragState.panelStartY + dy}px`;
            };

            const onMouseUp = () => {
                this.dragState = undefined;
                header.style.cursor = '';
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }
}
