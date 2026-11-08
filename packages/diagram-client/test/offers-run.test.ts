/**
 * Run and Stop are offered unless the host says no run driver is behind the
 * diagram. The palette header asks {@link offersRun} before adding either.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { offersRun } from '../src/profile';

afterEach(() => {
    delete (globalThis as any).diagramIdentifier;
});

describe('offersRun', () => {
    it('follows the host\'s derived flag', () => {
        (globalThis as any).diagramIdentifier = { clientBehavior: { runDriver: false } };
        expect(offersRun()).toBe(false);
        (globalThis as any).diagramIdentifier = { clientBehavior: { runDriver: true } };
        expect(offersRun()).toBe(true);
    });

    it('keeps them in a webview the host did not describe', () => {
        expect(offersRun()).toBe(true);
    });

    it('is what the palette header asks before adding Run and Stop', () => {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const source = readFileSync(path.join(here, '../src/tool-palette-header-controls.ts'), 'utf8');
        expect(source).toMatch(/offersRun\(\) && !headerTools\.querySelector\('i\.codicon\.codicon-play\.cal-run-workflow'\)/);
        expect(source).toMatch(/offersRun\(\) && !headerTools\.querySelector\('i\.codicon\.codicon-debug-stop\.cal-stop-workflow'\)/);
    });
});
