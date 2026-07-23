import { describe, expect, it } from 'vitest';
import { extractDecoratedDefinitionNames, hasRequestedDecoratedDefinition } from '../src/python-diagram-definitions';

describe('python diagram definitions', () => {
    it('extracts decorated network definitions from python source', () => {
        const sourceText = [
            '@network',
            'def Main():',
            '    return None',
            '',
            '@workflow',
            'def Pipeline():',
            '    return None'
        ].join('\n');

        expect(extractDecoratedDefinitionNames(sourceText, 'network')).toEqual(['Main']);
    });

    it('extracts decorated async network definitions from python source', () => {
        const sourceText = [
            '@network',
            'async def AsyncMain():',
            '    return None'
        ].join('\n');

        expect(extractDecoratedDefinitionNames(sourceText, 'network')).toEqual(['AsyncMain']);
    });

    it('ignores nested decorated network definitions inside factory helpers', () => {
        const sourceText = [
            'def make_decoder_layer():',
            '    @network(',
            '        inputs={"hidden": "Tensor"},',
            '        outputs={"hidden_out": "Tensor"},',
            '    )',
            '    def decoder_layer(hidden):',
            '        return hidden',
            '    return decoder_layer'
        ].join('\n');

        expect(extractDecoratedDefinitionNames(sourceText, 'network')).toEqual([]);
    });

    it('rejects diagram opening for files without a requested network definition', async () => {
        const hasNetwork = await hasRequestedDecoratedDefinition(
            '/external/project/layer.py',
            'network',
            'Layer',
            async () => [
                'def helper():',
                '    return 1'
            ].join('\n')
        );

        expect(hasNetwork).toBe(false);
    });
});