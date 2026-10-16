/**
 * A product says what a new source file starts with.
 *
 * The scaffold was an import line, a decorator and an empty Python function,
 * which is what every Python runtime's file is and what no HDL file is. A
 * `template` on `newContainer` gives the whole text from the name; without
 * one the scaffold is exactly what it was.
 */
import { describe, expect, it } from 'vitest';
import { scaffoldSource } from '../src/new-source-file-command';

describe('the new source file scaffold', () => {
    it('is the decorated function it always was, without a template', () => {
        const text = scaffoldSource(
            { label: 'Workflow', decorator: 'workflow', importLine: 'from wfpy import workflow', sourceExtension: '.py' },
            'pipeline'
        );
        expect(text).toBe('from wfpy import workflow\n\n\n@workflow\ndef pipeline() -> None:\n    pass\n');
    });

    it('is whatever the template says, with one', () => {
        const text = scaffoldSource(
            {
                label: 'Module', decorator: 'module', importLine: '', sourceExtension: '.sv',
                template: name => `module ${name} (\n);\nendmodule\n`
            },
            'top'
        );
        expect(text).toBe('module top (\n);\nendmodule\n');
    });
});
