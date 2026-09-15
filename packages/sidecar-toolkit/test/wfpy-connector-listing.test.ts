// A product whose CLI is not wfpy lists the connectors with the wfpy beside
// that CLI (the same venv), else with wfpy on the PATH.
import { describe, expect, it } from 'vitest';
import { wfpyConnectorListing } from '../src/wfpy-connector-listing';

describe('wfpyConnectorListing', () => {
    const args = ['connectors', '--json', '--workspace', '/w'];

    it('takes wfpy from beside a CLI given as a path', () => {
        expect(wfpyConnectorListing('/venv/bin/calpy', '/w', p => p === '/venv/bin/wfpy')).toEqual({ cmd: '/venv/bin/wfpy', args });
        expect(wfpyConnectorListing('/venv/bin/python', '/w', p => p === '/venv/bin/wfpy')).toEqual({ cmd: '/venv/bin/wfpy', args });
    });

    it('falls back to the PATH when the CLI is bare or has no wfpy beside it', () => {
        expect(wfpyConnectorListing('calpy', '/w', () => true)).toEqual({ cmd: 'wfpy', args });
        expect(wfpyConnectorListing('/opt/calpy/bin/calpy', '/w', () => false)).toEqual({ cmd: 'wfpy', args });
    });
});
