/**
 * Draw the icons a product contributed.
 *
 * A palette icon is only a class name. GLSP builds `<i class="codicon
 * codicon-<id>">` and nothing more, so an icon exists only if some CSS rule
 * draws that class — which is why the platform's own custom entries each carry
 * a hand-written rule in `diagram-client.css`.
 *
 * A product's mark cannot live there: the platform is product-neutral, and its
 * gates reject branded assets in core. So the product supplies the artwork
 * through `clientBehavior.paletteIcons` and this writes the rules for it. The
 * platform ends up rendering bytes it was handed and containing none of them.
 *
 * `background-image` rather than the `mask-image` the built-in rules use: a
 * mask flattens everything to one colour, which is right for a monochrome glyph
 * and wrong for a mark with its own palette. That is also why light and dark are
 * separate images rather than one image tinted twice.
 */
import { IDiagramStartup } from '@eclipse-glsp/client';
import { injectable } from 'inversify';
import { clientBehavior } from './profile';

const STYLE_ELEMENT_ID = 'dialogram-contributed-palette-icons';

/** Only ids a CSS class can safely be built from. */
const SAFE_ICON_ID = /^[a-z][a-z0-9-]*$/;

/**
 * Only `data:` and `blob:` sources are written into the rule.
 *
 * The value reaches this from the host, and it lands in a stylesheet — a
 * remote `url()` would be a request the diagram makes on someone's behalf,
 * which an icon has no business doing. It would also simply fail: the webview's
 * CSP has no `img-src` for arbitrary origins.
 */
function isRenderableSource(value: unknown): value is string {
    return typeof value === 'string'
        && (value.startsWith('data:') || value.startsWith('blob:'))
        && !value.includes(')');
}

function ruleFor(id: string, source: string, selectorSuffix = ''): string {
    return `.codicon.codicon-${id}${selectorSuffix}:before {
    content: '';
    display: inline-block;
    width: 16px;
    height: 16px;
    background-image: url("${source}");
    background-repeat: no-repeat;
    background-position: center;
    background-size: contain;
}`;
}

/** The CSS for every contributed icon. Exported for the test; see `installPaletteIcons`. */
export function paletteIconCss(
    icons: Record<string, { dark: string; light?: string }> | undefined
): string {
    const rules: string[] = [];
    for (const [id, sources] of Object.entries(icons ?? {})) {
        if (!SAFE_ICON_ID.test(id) || !isRenderableSource(sources?.dark)) {
            continue;
        }
        // Dark is the base, so an id with only one image still renders.
        rules.push(ruleFor(id, sources.dark));
        if (isRenderableSource(sources.light)) {
            // VS Code stamps the theme on the body; the light rule only has to
            // out-specify the base one, which the extra class does.
            rules.push(ruleFor(id, sources.light, '').replace(
                `.codicon.codicon-${id}:before`,
                `body.vscode-light .codicon.codicon-${id}:before, `
                + `body.vscode-high-contrast-light .codicon.codicon-${id}:before`
            ));
        }
    }
    return rules.join('\n\n');
}

/**
 * Write the contributed icon rules into the document.
 *
 * Idempotent: reuses its own style element, so a reload replaces the rules
 * rather than stacking another copy of them.
 */
export function installPaletteIcons(): void {
    const css = paletteIconCss(clientBehavior().paletteIcons);
    if (!css) {
        return;
    }
    const existing = document.getElementById(STYLE_ELEMENT_ID);
    const style = existing instanceof HTMLStyleElement
        ? existing
        : document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = css;
    if (!existing) {
        document.head.appendChild(style);
    }
}

/**
 * Installs the rules before the first render, so the palette never paints a
 * blank slot and then fills it in.
 */
@injectable()
export class WorkflowPaletteIconStartup implements IDiagramStartup {
    rank = -100;

    preInitialize(): void {
        installPaletteIcons();
    }
}
