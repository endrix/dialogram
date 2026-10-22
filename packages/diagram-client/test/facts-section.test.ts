/**
 * The Facts section shows what the producer said, in the order it said it.
 *
 * A fact is a labelled value the platform does not understand, so the only
 * things it can get wrong are the ones pinned here: the count in the header,
 * the order, a Markdown value rendered as markup instead of shown as its
 * source, and a section appearing when there is nothing to put in it.
 *
 * The vitest env is `node`, and this package has no DOM. Like the collapse
 * test, this installs a minimal fake `document` — a little richer, since the
 * section fills its body and the assertions read it back.
 *
 * The Markdown renderer is the real one; only its sanitizer is stood in for.
 * DOMPurify's node build is a bare factory with no `sanitize` (it needs a
 * window to work on), so without a stand-in the Markdown case could not run
 * at all, and mocking the whole renderer instead would prove nothing about
 * `**bold**` becoming `<strong>`. What the stand-in does not prove is the
 * sanitizing itself, which is DOMPurify's job in the webview.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { PropertyPanel } from '../src/property-panel';

vi.mock('dompurify', () => ({ default: { sanitize: (html: string) => html } }));

// ── Minimal fake DOM ────────────────────────────────────────────────────────

class FakeClassList {
    private set = new Set<string>();
    add(...cs: string[]) { cs.forEach(c => c && this.set.add(c)); }
    contains(c: string) { return this.set.has(c); }
    toggle(c: string) {
        const want = !this.set.has(c);
        if (want) { this.set.add(c); } else { this.set.delete(c); }
        return want;
    }
    replaceAll(value: string) { this.set = new Set(value.split(/\s+/).filter(Boolean)); }
    toString() { return [...this.set].join(' '); }
}

class FakeElement {
    classList = new FakeClassList();
    children: FakeElement[] = [];
    textContent = '';
    innerHTML = '';
    onclick: ((e: any) => void) | null = null;
    constructor(public tagName: string) {}
    get className(): string { return this.classList.toString(); }
    set className(value: string) { this.classList.replaceAll(value); }
    appendChild(child: FakeElement) { this.children.push(child); return child; }
    /** Just enough of a selector engine for `.one-class`, depth first. */
    querySelector(selector: string): FakeElement | null {
        const cls = selector.replace(/^\./, '');
        for (const child of this.children) {
            if (child.classList.contains(cls)) return child;
            const deeper = child.querySelector(selector);
            if (deeper) return deeper;
        }
        return null;
    }
}

const original = { document: (globalThis as any).document, window: (globalThis as any).window };

beforeEach(() => {
    (globalThis as any).document = { createElement: (tag: string) => new FakeElement(tag) };
    (globalThis as any).window = { addEventListener: () => undefined };
});

afterEach(() => {
    (globalThis as any).document = original.document;
    (globalThis as any).window = original.window;
});

/** The panel with its chrome/window wiring skipped; only the section is exercised. */
class TestPanel extends PropertyPanel {
    protected override initialize(): void {
        // no chrome, no global listeners
    }
    facts(args: Record<string, unknown> | undefined): any {
        return this.buildFactsSection(args);
    }
}

const sectionFor = (facts: unknown): any =>
    new TestPanel().facts({ [WorkflowDiagramMetadata.FACTS]: facts });

const titleOf = (section: any): string => section.children[0].querySelector('.section-title').textContent;
const rowsOf = (section: any): any[] => section.querySelector('.property-section-content').children;
const keyOf = (row: any): string => row.querySelector('.pp-akey').textContent;

describe('the Facts section', () => {
    it('shows one row per fact, in the producer’s order, under a header that counts them', () => {
        const section = sectionFor([
            { label: 'Clock', value: '200 MHz' },
            { label: 'Area', value: '12 LUT' },
            { label: 'Revision', value: 'r7' }
        ]);

        expect(titleOf(section)).toBe('Facts (3)');
        const rows = rowsOf(section);
        expect(rows).toHaveLength(3);
        expect(rows.map(keyOf)).toEqual(['Clock', 'Area', 'Revision']);
        expect(rows.map(row => row.querySelector('.pp-aval').textContent)).toEqual(['200 MHz', '12 LUT', 'r7']);
    });

    it('shows a plain value as text, not as markup', () => {
        // The control for the Markdown case: a producer that did not ask for
        // Markdown gets its asterisks back exactly as written.
        const [row] = rowsOf(sectionFor([{ label: 'Note', value: 'not **bold**' }]));

        expect(row.querySelector('.pp-aval').textContent).toBe('not **bold**');
        expect(row.querySelector('.pp-fact-markdown')).toBeNull();
    });

    it('renders a Markdown value as HTML, as a block under its label', () => {
        const [row] = rowsOf(sectionFor([{ label: 'Note', value: 'a **bold** claim', markdown: true }]));

        const block = row.querySelector('.pp-fact-markdown');
        expect(block.innerHTML).toContain('<strong>bold</strong>');
        expect(block.innerHTML).not.toContain('**');
        expect(row.classList.contains('pp-fact-block')).toBe(true);
    });

    it('is a collapsible section like the others', () => {
        const section = sectionFor([{ label: 'Clock', value: '200 MHz' }]);

        expect(section.classList.contains('property-section')).toBe(true);
        expect(section.classList.contains('collapsed')).toBe(false);
        section.children[0].onclick?.({ target: { closest: () => null } });
        expect(section.classList.contains('collapsed')).toBe(true);
    });

    it('is not built at all when there are no facts', () => {
        expect(sectionFor(undefined)).toBeUndefined();
        expect(sectionFor([])).toBeUndefined();
        expect(new TestPanel().facts(undefined)).toBeUndefined();
        expect(new TestPanel().facts({})).toBeUndefined();
    });

    it('skips an entry the server would have dropped, should one arrive anyway', () => {
        const section = sectionFor([
            { label: 'Clock', value: '200 MHz' },
            { label: 'Area' },
            { value: 'orphaned' },
            null
        ]);

        expect(titleOf(section)).toBe('Facts (1)');
        expect(rowsOf(section).map(keyOf)).toEqual(['Clock']);
    });
});
