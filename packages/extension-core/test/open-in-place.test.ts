/**
 * An open reveals the editor a file already has, in the group it is in,
 * instead of opening a second one beside the diagram.
 */
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { inPlace, openColumnFor } from '../src/extension/diagram/open-in-place';

const uri = (file: string) => vscode.Uri.file(file);
const text = (file: string) => ({ input: { uri: uri(file) } });
const custom = (file: string, viewType: string) => ({ input: { uri: uri(file), viewType } });
const notebook = (file: string) => ({ input: { uri: uri(file), notebookType: 'jupyter-notebook' } });
const diff = (file: string) => ({ input: { original: uri(file), modified: uri(file) } });
const group = (viewColumn: number, ...tabs: { input?: unknown }[]) => ({ viewColumn, tabs });

describe('where a file is already open', () => {
    const diagram = group(1, custom('/w/flow.py', 'workflow.networkDiagram'));
    const beside = group(2, text('/w/task.py'), text('/w/flow.py'), diff('/w/other.py'), custom('/w/out.gds', 'gds.viewer'), notebook('/w/n.ipynb'));

    it('is the group beside the diagram, for a text file open there', () => {
        expect(openColumnFor(uri('/w/task.py'), 'text', [diagram, beside], diagram)).toBe(2);
    });

    it('is nowhere to name when the active group has it, or none has', () => {
        expect(openColumnFor(uri('/w/task.py'), 'text', [diagram, beside], beside)).toBeUndefined();
        expect(openColumnFor(uri('/w/new.py'), 'text', [diagram, beside], diagram)).toBeUndefined();
        expect(openColumnFor(uri('/w/task.py'), 'text', [], undefined)).toBeUndefined();
    });

    it('is the kind of editor asked for: the diagram of a file is not its text, nor a diff its editor', () => {
        // flow.py is a diagram in group 1 and text in group 2.
        expect(openColumnFor(uri('/w/flow.py'), 'text', [diagram, beside], diagram)).toBe(2);
        expect(openColumnFor(uri('/w/flow.py'), { viewType: 'workflow.networkDiagram' }, [diagram, beside], beside)).toBe(1);
        expect(openColumnFor(uri('/w/other.py'), 'text', [diagram, beside], diagram)).toBeUndefined();
        expect(openColumnFor(uri('/w/out.gds'), 'text', [diagram, beside], diagram)).toBeUndefined();
    });

    it('takes whatever editor a default open gives, but not the diagram’s own', () => {
        expect(openColumnFor(uri('/w/out.gds'), { default: true }, [diagram, beside], diagram)).toBe(2);
        expect(openColumnFor(uri('/w/n.ipynb'), { default: true }, [diagram, beside], diagram)).toBe(2);
        const only = group(3, custom('/w/sub.py', 'workflow.networkDiagram'));
        expect(openColumnFor(uri('/w/sub.py'), { default: true, exceptViewType: 'workflow.networkDiagram' }, [diagram, only], diagram)).toBeUndefined();
        expect(openColumnFor(uri('/w/sub.py'), { default: true }, [diagram, only], diagram)).toBe(3);
    });

    it('leaves a column the caller named alone, and adds nothing when there is none to add', () => {
        expect(inPlace(uri('/w/x.py'), 'text', { viewColumn: 2, preview: true })).toEqual({ viewColumn: 2, preview: true });
        const options = { preview: true };
        expect(inPlace(uri('/w/x.py'), 'text', options)).toBe(options);
    });
});
