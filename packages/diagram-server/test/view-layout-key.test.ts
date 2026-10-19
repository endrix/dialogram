/**
 * A view of a workflow other than its structure draws other nodes, so its
 * layout cannot be the structure's: it lives under the workflow's key with
 * the view's suffix, standalone and per instance alike.
 */
import { describe, expect, it } from 'vitest';
import { URI } from 'vscode-uri';
import { instanceLayoutFor, viewKey } from '../src/server/layout-target';
import { parseNavigationTrailArg } from '../src/server/graph-load-request-options';

const toPath = (uri: string) => URI.parse(uri).fsPath;
const TOP = 'file:///w/top.vhd';
const LEAF = 'file:///w/adder.vhd';

describe('the layout key of a view', () => {
    it('is the workflow’s with the view’s suffix', () => {
        expect(viewKey('adder', 'synth')).toBe('adder@synth');
        expect(viewKey('adder', undefined)).toBe('adder');
    });

    it('follows the instance path for a view reached through a node', () => {
        const trail = parseNavigationTrailArg(JSON.stringify([
            { sourceUri: TOP, workflowName: 'top' },
            { sourceUri: LEAF, workflowName: 'adder', workflowInstanceName: 'u_add', view: 'synth', viewLabel: 'Synthesis View' }
        ]));
        expect(trail[1]).toMatchObject({ view: 'synth', viewLabel: 'Synthesis View' });
        expect(instanceLayoutFor(trail, { filePath: '/w/adder.vhd', workflowName: 'adder' }, toPath)).toEqual({
            target: { filePath: '/w/top.vhd', networkId: 'top/u_add/adder@synth' },
            fallback: { filePath: '/w/adder.vhd', networkId: 'adder@synth' }
        });
    });
});
