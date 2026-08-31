/**
 * Empty property sections open collapsed — but stay openable.
 *
 * Selecting a boundary port used to hand you four expanded sections that all
 * said nothing: "Annotations (0)", "Definition Parameters (0)", "Input Ports
 * (0)", "Output Ports (0)". Each header already carries its count, so an empty
 * body is a screenful of nothing between you and the fields that do have
 * content.
 *
 * The risk in "collapsed by default" is shipping "collapsed, permanently" — a
 * section built pre-collapsed whose header toggle no longer opens it would look
 * exactly like a section with nothing in it, and nobody would file that as a
 * bug. So this pins both halves: the initial state, and that the toggle still
 * works from it.
 *
 * The vitest env is `node`, and this package has no DOM. Rather than take on
 * jsdom for one test, this installs the same kind of minimal fake `document`
 * the chrome test uses — `createSection` touches very little of it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PropertyPanel } from '../src/property-panel';

// ── Minimal fake DOM ────────────────────────────────────────────────────────

class FakeClassList {
    private set = new Set<string>();
    add(...cs: string[]) { cs.forEach(c => c && this.set.add(c)); }
    remove(c: string) { this.set.delete(c); }
    contains(c: string) { return this.set.has(c); }
    toggle(c: string) {
        const want = !this.set.has(c);
        if (want) { this.set.add(c); } else { this.set.delete(c); }
        return want;
    }
    replaceAll(value: string) {
        this.set = new Set(value.split(/\s+/).filter(Boolean));
    }
}

class FakeElement {
    classList = new FakeClassList();
    children: FakeElement[] = [];
    textContent = '';
    onclick: ((e: any) => void) | null = null;
    // className and classList are two views of one value in a real DOM, and
    // createSection writes className first then classList.add — so the fake has
    // to keep them in step or the assertion below would pass vacuously.
    get className(): string { return ''; }
    set className(value: string) { this.classList.replaceAll(value); }
    appendChild(child: FakeElement) { this.children.push(child); return child; }
    querySelector() { return null; }
}

const original = { document: (globalThis as any).document, window: (globalThis as any).window };

beforeEach(() => {
    (globalThis as any).document = { createElement: () => new FakeElement() };
    (globalThis as any).window = { addEventListener: () => undefined };
});

afterEach(() => {
    (globalThis as any).document = original.document;
    (globalThis as any).window = original.window;
});

/** The panel with its chrome/window wiring skipped; only sections are exercised. */
class TestPanel extends PropertyPanel {
    protected override initialize(): void {
        // no chrome, no global listeners
    }
    build(title: string, opts?: { collapsed?: boolean }): any {
        return this.createSection(title, opts);
    }
}

/** Click the section header the way a user would. */
function clickHeader(section: any): void {
    const header = section.children[0];
    header.onclick?.({ target: { closest: () => null } });
}

describe('property section collapse', () => {
    it('opens expanded by default', () => {
        const section = new TestPanel().build('Input Ports (2)');

        expect(section.classList.contains('collapsed')).toBe(false);
    });

    it('opens collapsed when asked', () => {
        const section = new TestPanel().build('Input Ports (0)', { collapsed: true });

        expect(section.classList.contains('collapsed')).toBe(true);
    });

    /** The failure worth guarding: pre-collapsed but no longer openable. */
    it('still opens on click when it started collapsed', () => {
        const panel = new TestPanel();
        const section = panel.build('Annotations (0)', { collapsed: true });

        clickHeader(section);
        expect(section.classList.contains('collapsed')).toBe(false);

        clickHeader(section);
        expect(section.classList.contains('collapsed')).toBe(true);
    });

    it('keeps the section class alongside the collapsed one', () => {
        const section = new TestPanel().build('Output Ports (0)', { collapsed: true });

        // Guards the fake as much as the code: if `className =` clobbered the
        // classList, `collapsed` would survive and `property-section` would not.
        expect(section.classList.contains('property-section')).toBe(true);
        expect(section.classList.contains('collapsed')).toBe(true);
    });
});
