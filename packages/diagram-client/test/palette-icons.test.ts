/**
 * A product's icon is drawn by the platform without the platform holding it.
 *
 * GLSP builds `<i class="codicon codicon-<id>">` and nothing else, so an icon
 * exists only if a CSS rule draws that class. The platform's own custom entries
 * each carry a hand-written rule; a product's mark cannot join them, because the
 * platform is product-neutral and its gates reject branded assets in core.
 *
 * So the product supplies the artwork and this writes the rule. These pin the
 * two things that decide whether that is safe: what gets a rule, and what does
 * not.
 */
import { describe, expect, it } from 'vitest';
import { paletteIconCss } from '../src/palette-icons';

const DATA_URI = 'data:image/svg+xml,%3Csvg%20viewBox=%270%200%201%201%27%3E%3C/svg%3E';

describe('contributed palette icons', () => {
    it('draws an icon a product supplied', () => {
        const css = paletteIconCss({ 'wf-streamblocks-icon': { dark: DATA_URI } });

        expect(css).toContain('.codicon.codicon-wf-streamblocks-icon:before');
        expect(css).toContain(`url("${DATA_URI}")`);
    });

    /**
     * `background-image`, not the `mask-image` the built-in rules use: a mask
     * flattens the artwork to one colour, which suits a monochrome glyph and
     * ruins a mark with its own palette.
     */
    it('keeps the artwork’s own colours', () => {
        const css = paletteIconCss({ 'wf-icon': { dark: DATA_URI } });

        expect(css).toContain('background-image');
        expect(css).not.toContain('mask-image');
    });

    it('uses the light variant only where the theme is light', () => {
        const light = `${DATA_URI}%3C!--light--%3E`;
        const css = paletteIconCss({ 'wf-icon': { dark: DATA_URI, light } });

        expect(css).toContain('body.vscode-light .codicon.codicon-wf-icon:before');
        expect(css).toContain(light);
    });

    it('still renders when only one variant is given', () => {
        const css = paletteIconCss({ 'wf-icon': { dark: DATA_URI } });

        expect(css).toContain('.codicon.codicon-wf-icon:before');
        expect(css).not.toContain('vscode-light');
    });

    /**
     * The value arrives from the host and lands in a stylesheet. A remote
     * `url()` would be a request the diagram makes on someone's behalf, which an
     * icon has no business doing — and the webview's CSP would block it anyway,
     * silently.
     */
    it('refuses a source that is not inline data', () => {
        const css = paletteIconCss({
            'wf-icon': { dark: 'https://example.com/logo.svg' }
        });

        expect(css).toBe('');
    });

    /** An id becomes part of a selector, so it may only be selector-safe text. */
    it('refuses an id that could break out of the selector', () => {
        const css = paletteIconCss({
            'wf-icon:hover, body { display: none }': { dark: DATA_URI }
        });

        expect(css).toBe('');
    });

    it('refuses a source that could close the url() early', () => {
        const css = paletteIconCss({
            'wf-icon': { dark: 'data:image/svg+xml,%3Csvg%3E%3C/svg%3E"); body { display: none } .x:before { content: url("' }
        });

        expect(css).toBe('');
    });

    it('contributes nothing when a product contributes nothing', () => {
        expect(paletteIconCss(undefined)).toBe('');
        expect(paletteIconCss({})).toBe('');
    });
});

/**
 * The rules only exist if something runs the installer. A channel wired at one
 * end and never called at the other renders an empty palette slot and no error,
 * so the binding is pinned here rather than left to integration.
 */
describe('installing the icons at startup', () => {
    it('runs the installer as a diagram startup', async () => {
        const { diagramBaseModule } = await import('../src/base.module');
        const { recordModuleRegistrations } = await import('./container-registration-recorder');

        const entries = recordModuleRegistrations([diagramBaseModule]);

        expect(entries).toContainEqual(
            expect.objectContaining({
                op: 'bindAsService',
                service: expect.stringContaining('IDiagramStartup'),
                impl: 'WorkflowPaletteIconStartup'
            })
        );
    });

    it('installs before the first render', async () => {
        const { WorkflowPaletteIconStartup } = await import('../src/palette-icons');
        const { WorkflowGridStartup } = await import('../src/grid-startup');

        // Same rank as the grid: both must land before the diagram paints.
        expect(new WorkflowPaletteIconStartup().rank)
            .toBe(new WorkflowGridStartup().rank);
        expect(new WorkflowPaletteIconStartup().rank).toBeLessThan(0);
    });
});
