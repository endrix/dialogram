import { describe, expect, it } from 'vitest';
import { candidateModuleFiles, findImportingModules } from '../src/python-import-resolution';

describe('findImportingModules', () => {
    it('finds the module a name is imported from', () => {
        expect(findImportingModules('from pcpi.div import Div\nfrom pcpi.mul import Mul\n', 'Div')).toEqual(['pcpi.div']);
    });

    it('reads comma lists, aliases and parenthesized lists over several lines', () => {
        const source = [
            'from tokens import Cmd, Irq as Interrupt',
            'from exec.exec import (',
            '    Exec,',
            '    ExecDone,',
            ')'
        ].join('\n');
        expect(findImportingModules(source, 'Irq')).toEqual(['tokens']);
        expect(findImportingModules(source, 'Exec')).toEqual(['exec.exec']);
        expect(findImportingModules(source, 'Interrupt')).toEqual([]);
    });

    it('does not take a longer name or a comment for the name', () => {
        expect(findImportingModules('from load.load_req import LoadReq  # not Load\n', 'Load')).toEqual([]);
    });

    it('keeps relative modules as written', () => {
        expect(findImportingModules('from .div import Div\nfrom .. import Div\n', 'Div')).toEqual(['.div', '..']);
    });
});

describe('candidateModuleFiles', () => {
    it('tries the module under every ancestor of the source, nearest first', () => {
        expect(candidateModuleFiles('pcpi.div', '/ws/gen/network/top.py')).toEqual([
            '/ws/gen/network/pcpi/div.py',
            '/ws/gen/network/pcpi/div/__init__.py',
            '/ws/gen/pcpi/div.py',
            '/ws/gen/pcpi/div/__init__.py',
            '/ws/pcpi/div.py',
            '/ws/pcpi/div/__init__.py',
            '/pcpi/div.py',
            '/pcpi/div/__init__.py'
        ]);
    });

    it('resolves a relative module from the source directory only', () => {
        expect(candidateModuleFiles('.div', '/ws/gen/pcpi/top.py')).toEqual(['/ws/gen/pcpi/div.py', '/ws/gen/pcpi/div/__init__.py']);
        expect(candidateModuleFiles('..isa.alu', '/ws/gen/pcpi/top.py')).toEqual(['/ws/gen/isa/alu.py', '/ws/gen/isa/alu/__init__.py']);
        expect(candidateModuleFiles('..', '/ws/gen/pcpi/top.py')).toEqual([]);
    });
});
