import { describe, expect, it } from 'vitest';
import { extractTypePorts } from '../src/server/python-text';

describe('extractTypePorts', () => {
    it('reads ports nested under a `class Ports:` block with direction kwargs', () => {
        const source = [
            'from wfpy import Port',
            '',
            'class Producer:',
            '    class Ports:',
            '        Out = Port[int](direction="out")',
            '        Aux = Port[str](direction="in")',
            '',
            '    def run(self):',
            '        pass',
            ''
        ].join('\n');
        expect(extractTypePorts(source, 'Producer')).toEqual([
            { name: 'Out', direction: 'out' },
            { name: 'Aux', direction: 'in' }
        ]);
    });

    it('reads ports declared directly in the class body', () => {
        const source = [
            'from wfpy.core import workflow',
            '',
            'class Boundary:',
            '    In = Port[int]()',
            '    pass',
            ''
        ].join('\n');
        expect(extractTypePorts(source, 'Boundary')).toEqual([
            { name: 'In', direction: 'unknown' }
        ]);
    });

    it('infers direction from an Input/Output type prefix', () => {
        const source = [
            'class Mixed:',
            '    a = InputPort[int]()',
            '    b = OutputPort[int]()',
            ''
        ].join('\n');
        expect(extractTypePorts(source, 'Mixed')).toEqual([
            { name: 'a', direction: 'in' },
            { name: 'b', direction: 'out' }
        ]);
    });

    it('returns [] when the class is not present (type defined elsewhere)', () => {
        const source = 'class Other:\n    pass\n';
        expect(extractTypePorts(source, 'Absent')).toEqual([]);
    });

    it('stops at the class dedent and ignores unrelated assignments', () => {
        const source = [
            'class A:',
            '    p = Port[int](direction="in")',
            '    x = 5',
            '',
            'class B:',
            '    q = Port[int](direction="out")',
            ''
        ].join('\n');
        // Only A's port; the `x = 5` assignment is not a Port; B is a different class.
        expect(extractTypePorts(source, 'A')).toEqual([{ name: 'p', direction: 'in' }]);
    });
});
