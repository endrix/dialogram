/**
 * The definitions of a module are those at its top level: a task class's own
 * `class Ports:` and the `@workflow def` a factory makes inside its body are
 * not types a node can be made of (the type picker offered "Ports — task" for
 * every task of a project).
 */
import { describe, expect, it } from 'vitest';
import { extractTopLevelPythonDefinitions } from '../src/server/python-text';

const SOURCE = [
    'from wfpy import Port, task, workflow',
    '',
    '@task',
    'class Text:',
    '    class Ports:',
    '        Out = Port[str](direction="out")',
    '',
    '    @action',
    '    def emit(self):',
    '        pass',
    '',
    'def gemmini(plusargs):',
    '    @workflow(outputs={"Log": str})',
    '    def gemmini():',
    '        pass',
    '    return gemmini',
    '',
    '@workflow(',
    '    outputs={"Metrics": str},',
    ')',
    'def flow():',
    '    pass',
    ''
].join('\n');

describe('the top-level definitions of a module', () => {
    it('are its own, not those inside a class or a function', () => {
        expect(extractTopLevelPythonDefinitions(SOURCE).map(d => [d.name, d.kind, d.decorators.map(line => line.split('(')[0])])).toEqual([
            ['Text', 'class', ['@task']],
            ['gemmini', 'function', []],
            ['flow', 'function', ['@workflow']]
        ]);
    });
});
