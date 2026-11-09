/**
 * The property panel's building blocks that its contributions share: the
 * collapsible section every panel section is, and two text helpers.
 */

/**
 * A collapsible section.
 *
 * `collapsed` sets the INITIAL state only — the header toggle still works,
 * and nothing here remembers the choice, so reopening the panel starts from
 * the default again. Callers pass it for sections that turned out empty:
 * an "(0)" section costs a screenful of nothing to scroll past, and the
 * count in the header already says everything its body would.
 */
export function createPropertySection(title: string, opts?: { collapsed?: boolean }): HTMLElement {
    const section = document.createElement('div');
    section.className = 'property-section';
    if (opts?.collapsed) {
        section.classList.add('collapsed');
    }

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

export function escapeHtml(unsafe: string): string {
    if (!unsafe) return '';
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/**
 * Shorten a file path to just the last 2 path segments for display.
 */
export function shortenPath(p: string): string {
    const parts = p.replace(/\\/g, '/').split('/');
    if (parts.length <= 2) return p;
    return '…/' + parts.slice(-2).join('/');
}
