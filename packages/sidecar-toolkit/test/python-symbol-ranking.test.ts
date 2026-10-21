import { describe, expect, it } from 'vitest';
import { pickBestWorkspaceSymbol } from '../src/python-symbol-ranking';

const NETWORK = '/repo/gen/network/gemmini.py';

describe('pickBestWorkspaceSymbol', () => {
    it('prefers the class over a same-file instance variable whose name differs only in case', () => {
        // `load, store = Load(), Store()` in the network: the workspace symbol
        // search for "Load" also returns the local `load`.
        const best = pickBestWorkspaceSymbol([
            { name: 'load', isDeclaration: false, path: NETWORK, id: 'variable' },
            { name: 'Load', isDeclaration: true, path: '/repo/gen/load/load.py', id: 'class' }
        ], 'Load', NETWORK);

        expect(best?.id).toBe('class');
    });

    it('ignores a symbol that is not a class or a def, however close or well named', () => {
        // `Div = ()`, a Variant member, is not the actor `Div`.
        expect(pickBestWorkspaceSymbol([
            { name: 'Load', isDeclaration: false, path: NETWORK, id: 'import' },
            { name: 'Load', isDeclaration: false, path: '/repo/gen/isa/alu.py', id: 'member' }
        ], 'Load', NETWORK)).toBeUndefined();
    });

    it('prefers the declaration closest to the source among equal names', () => {
        const best = pickBestWorkspaceSymbol([
            { name: 'Load', isDeclaration: true, path: '/other/load.py', id: 'far' },
            { name: 'Load', isDeclaration: true, path: '/repo/gen/network/load.py', id: 'near' }
        ], 'Load', NETWORK);

        expect(best?.id).toBe('near');
    });

    it('ignores a name that differs only in case', () => {
        expect(pickBestWorkspaceSymbol([
            { name: 'load', isDeclaration: false, path: NETWORK, id: 'variable' }
        ], 'Load', NETWORK)).toBeUndefined();
    });

    it('returns undefined when no candidate is related to the name', () => {
        expect(pickBestWorkspaceSymbol([
            { name: 'LoadReq', isDeclaration: false, path: '/repo/gen/load/load_req.py', id: 'x' }
        ], 'Load', NETWORK)).toBeUndefined();
    });
});
