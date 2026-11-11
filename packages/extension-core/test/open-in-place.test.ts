/**
 * An open reveals the editor a file already has, in the group it is in,
 * instead of opening a second one beside the diagram.
 */
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { afterEach } from 'vitest';
import { inPlace, openColumnFor, openWithArguments, registerDiagramViewType } from '../src/extension/diagram/open-in-place';

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

describe('an open, through the window’s own tabs', () => {
    const window = vscode.window as unknown as { tabGroups?: unknown };
    const before = window.tabGroups;
    afterEach(() => { window.tabGroups = before; });

    /** The window with the diagram's group active and `beside` next to it. */
    function tabs(...besideTabs: { input?: unknown }[]): void {
        const active = group(1, custom('/w/flow.py', 'workflow.networkDiagram'));
        window.tabGroups = { all: [active, group(2, ...besideTabs)], activeTabGroup: active };
    }

    it('adds the column of the group that has the file to a text open', () => {
        tabs(text('/w/task.py'));
        expect(inPlace(uri('/w/task.py'), 'text', { preview: true })).toEqual({ preview: true, viewColumn: 2 });
        expect(inPlace(uri('/w/absent.py'), 'text', { preview: true })).toEqual({ preview: true });
    });

    it('opens a custom editor where one of that kind shows the file, and as before where none does', () => {
        tabs(custom('/w/out.gds', 'gds.viewer'));
        expect(openWithArguments(uri('/w/out.gds'), 'gds.viewer')).toEqual([uri('/w/out.gds'), 'gds.viewer', 2]);
        expect(openWithArguments(uri('/w/out.gds'), 'other.viewer')).toEqual([uri('/w/out.gds'), 'other.viewer']);
    });

    it('never takes a diagram for the editor of a default open', () => {
        registerDiagramViewType('workflow.networkDiagram');
        tabs(custom('/w/sub.py', 'workflow.networkDiagram'));
        expect(openColumnFor(uri('/w/sub.py'), { default: true })).toBeUndefined();
        // Asked for by name, the diagram is what is wanted.
        expect(openColumnFor(uri('/w/sub.py'), { viewType: 'workflow.networkDiagram' })).toBe(2);
    });
});
