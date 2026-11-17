/**
 * A paste or a duplicate makes the entities and the workflow's ports before
 * any connection, and makes a connection only where its ends are:
 *
 *   - one selected before its entity still joins the copy;
 *   - one whose writing end was not copied reads from it, in its file;
 *   - one into an input of an entity that was not copied is left out (that
 *     input has its writer), as is, in another file, one whose end is not
 *     there;
 *   - in another file only literal arguments are carried; one the type
 *     cannot be made without is asked, the original's text offered, before
 *     anything is written (Escape makes nothing); what else is left out is
 *     said.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkflowDiagramTypes, type DiagramClipboardItem } from '@dialogram/shared';
import { recreateItems } from '../src/server/operations/recreate-items.js';
import { saying } from './edits-on-disk';

const made: string[] = [];
const windowAny = vscode.window as any;
const savedInput = windowAny.showInputBox;
afterEach(() => {
    windowAny.showInputBox = savedInput;
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

async function recreate(
    items: DiagramClipboardItem[],
    copiedFrom: string,
    into: string,
    options: { required?: string[]; typed?: (box: { prompt?: string; value?: string }) => string | undefined; made?: boolean } = {}
) {
    const sent: Array<{ op: string; args: Record<string, unknown> }> = [];
    const listed: string[] = [];
    const asked: Array<{ title?: string; prompt?: string; value?: string }> = [];
    windowAny.showInputBox = async (box: any) => {
        asked.push({ title: box?.title, prompt: box?.prompt, value: box?.value });
        return (options.typed ?? (b => b.value))(box ?? {});
    };
    const sidecar = {
        sidecarOp: (op: string) => `wfpy.${op}`,
        hasFeature: async () => true,
        sendSidecarListDetailed: async (_uri: string, request: { op: string }) => (listed.push(request.op), {
            ok: true,
            response: { diagnostic: { parameters: [...(options.required ?? []).map(name => ({ name, type: 'str' })), { name: 'size', type: 'int', defaultValue: '1' }] } }
        }),
        sendSidecarOpDetailed: async (_uri: string, payload: { op: string; args: Record<string, unknown> }) => {
            sent.push(payload);
            return { ok: true };
        }
    };
    const said = await saying(async said => {
        const before = await recreateItems(sidecar as any, into, 'flow', { version: 1, sourceUri: copiedFrom, items }, new Set(['a', 'b', 'c']));
        expect(before !== undefined).toBe(options.made ?? true);
        return said;
    });
    const connects = sent.filter(each => each.op === 'wfpy.connect').map(each => {
        const end = (port: any) => port.type === 'workflow' ? `"${port.name}"` : `${port.actor}.${port.port}`;
        return `${end(each.args.from_port)} -> ${end(each.args.to_port)}`;
    });
    return { sent, said, connects, asked, listed };
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

describe('an entity made in another file, of a type it cannot be made without an argument it was given', () => {
    const copy = [entity('a', { text: 'FRONT_OPTIONS', size: '4' })];

    it('is made with what is answered, the original’s text offered', async () => {
        const { sent, said, asked } = await recreate(copy, file('top.py'), file('other.py'), {
            required: ['text'], typed: () => 'OTHER_OPTIONS'
        });
        expect(asked).toEqual([{
            title: 'a2 = Text(…)',
            prompt: "'text' (str) has no default: the copy was given FRONT_OPTIONS, which may name nothing here. The expression to give it",
            value: 'FRONT_OPTIONS'
        }]);
        expect(sent.map(each => each.args)).toEqual([{ workflow: 'flow', type: 'Text', name: 'a2', expressions: { size: '4', text: 'OTHER_OPTIONS' } }]);
        expect(said).toEqual([]);
    });

    it('is not made, nor anything else, when the question is escaped', async () => {
        const { sent } = await recreate([...copy, entity('b')], file('top.py'), file('other.py'), {
            required: ['text'], typed: () => undefined, made: false
        });
        expect(sent).toEqual([]);
    });
});

describe('several entities of one type made in another file', () => {
    it('ask the producer what the type takes once', async () => {
        const { listed, sent } = await recreate(['a', 'b', 'c'].map(name => entity(name, { size: '2' })), file('top.py'), file('other.py'));
        expect(listed).toEqual(['wfpy.typeParameters']);
        expect(sent).toHaveLength(3);
    });
});
