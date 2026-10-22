/**
 * The header view draws the badge labels as pills on the right and centres
 * the name in what is left; read from the source, since the views need a
 * browser to render.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = readFileSync(path.resolve(here, '../src/views.ts'), 'utf8');
const CSS = readFileSync(path.resolve(here, '../src/diagram-client.css'), 'utf8');
const HEADER_VIEW = /export class HeaderCompartmentView[\s\S]*?\n}\n/.exec(VIEWS)?.[0] ?? '';

describe('header badges', () => {
    it('are drawn as pills carrying their tone class, after the labels', () => {
        expect(HEADER_VIEW).toContain("'header-badge': true, [tone]: true");
        expect(HEADER_VIEW).toContain("'header-badge-text': true");
        expect(HEADER_VIEW.indexOf('...labelChildren')).toBeLessThan(HEADER_VIEW.indexOf('...badgeChildren'));
    });

    it('leave the name centred in the width the badges do not take', () => {
        expect(HEADER_VIEW).toContain('const centerX = (width - badgesWidth) / 2;');
        expect(HEADER_VIEW).toContain('child instanceof GLabel && !isBadge(child)');
    });

    it('have a colour per tone', () => {
        for (const tone of ['neutral', 'info', 'warning', 'error']) {
            expect(CSS).toMatch(new RegExp(`\\.header-badge\\.badge-tone-${tone} rect\\s*\\{[^}]*fill`));
        }
    });
});
