/**
 * A paste or a duplicate makes the entities and the workflow's ports before
 * any connection, and makes a connection only where its ends are:
 *
 *   - one selected before its entity still joins the copy;
 *   - one whose writing end was not copied reads from it, in its file;
 *   - one into an input of an entity that was not copied is left out (that
 *     input has its writer), as is, in another file, one whose end is not
 *     there;
 *   - in another file only literal arguments are carried, and what is left
 *     out is said.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkflowDiagramTypes, type DiagramClipboardItem } from '@dialogram/shared';
import { recreateItems } from '../src/server/operations/recreate-items.js';
import { saying } from './edits-on-disk';

const made: string[] = [];
afterEach(() => {
    for (const dir of made.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function file(name: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'recreate-items-'));
    made.push(dir);
    const at = path.join(dir, name);
    writeFileSync(at, '');
    return pathToFileURL(at).href;
}

const entity = (name: string, expressions?: Record<string, string>): DiagramClipboardItem =>
    ({ kind: 'entity', elementTypeId: WorkflowDiagramTypes.NODE_ACTOR, name, typeName: 'Text', ...(expressions ? { expressions } : {}) });
const edge = (from: string | undefined, to: string | undefined): DiagramClipboardItem =>
    ({ kind: 'connection', elementTypeId: WorkflowDiagramTypes.EDGE_CONNECTION, from, to, outPort: 'Out', inPort: 'In' });

async function recreate(items: DiagramClipboardItem[], copiedFrom: string, into: string) {
    const sent: Array<{ op: string; args: Record<string, unknown> }> = [];
    const sidecar = {
        sidecarOp: (op: string) => `wfpy.${op}`,
        hasFeature: async () => true,
        sendSidecarOpDetailed: async (_uri: string, payload: { op: string; args: Record<string, unknown> }) => {
            sent.push(payload);
            return { ok: true };
        }
    };
    const said = await saying(async said => {
        expect(await recreateItems(sidecar as any, into, 'flow', { version: 1, sourceUri: copiedFrom, items }, new Set(['a', 'b', 'c']))).toBe(true);
        return said;
    });
    const connects = sent.filter(each => each.op === 'wfpy.connect').map(each => {
        const end = (port: any) => port.type === 'workflow' ? `"${port.name}"` : `${port.actor}.${port.port}`;
        return `${end(each.args.from_port)} -> ${end(each.args.to_port)}`;
    });
    return { sent, said, connects };
}

describe('items made again in the file they were copied from', () => {
    it('make the entities first, and join the copies, read from what was not copied, and leave out an input that has its writer', async () => {
        const here = file('flow.py');
        const { sent, connects } = await recreate([
            edge('a', 'b'),          // selected before its entities
            entity('a'), entity('b'),
            edge('c', 'a'),          // reads from c, which was not copied
            edge('b', 'c'),          // into c's input, which c reads already
            edge(undefined, 'a')     // from the workflow's own port
        ], here, here);

        expect(sent.slice(0, 2).map(each => each.op)).toEqual(['wfpy.createNode', 'wfpy.createNode']);
        expect(connects).toEqual(['a2.Out -> b2.In', 'c.Out -> a2.In', '"Out" -> a2.In']);
    });
});

describe('items made in another file', () => {
    it('leave out a connection to what is not there, and carry only literal arguments, saying what was left out', async () => {
        const { sent, said, connects } = await recreate([
            entity('a', { text: 'FRONT_OPTIONS', size: '4', name: '"x"' }),
            edge('c', 'a'),
            edge(undefined, 'a')
        ], file('top.py'), file('other.py'));

        expect(sent[0].args.expressions).toEqual({ size: '4', name: '"x"' });
        expect(connects).toEqual([]);
        expect(said).toEqual(["Made without a2: text=FRONT_OPTIONS: it names what the file it was copied from binds, maybe nothing here. Give it here if needed."]);
    });
});
