/**
 * The annotation wizard's `@viewer` template: open a task's last token, diff two,
 * or open one with a chosen editor, which it can remember in the settings.
 */
import type { AnnotationTemplate } from '../annotation-template';
import { settingsNamespace } from '../profile';
import { VscodeUi } from '../vscode-ui';
import { toWfStringLiteral } from './literals';

export class ViewerAnnotationTemplate implements AnnotationTemplate {
    readonly annotationName = 'viewer';
    readonly label = '@viewer (open outputs in VS Code)';
    readonly description = 'open, diff, openWith (viewType)';

    async compose(): Promise<string | undefined> {
        let annotationText = '';

        const action = await VscodeUi.instance.quickPick({
            items: [
                { id: 'open', label: 'Open (single file)', description: 'Open last token using default editor' },
                { id: 'diff', label: 'Diff (two files)', description: 'Compare last tokens in VS Code diff editor' },
                { id: 'openWith', label: 'Open With…', description: 'Open using a specific VS Code editor viewType' }
            ],
            placeHolder: '@viewer.action'
        });
        if (!action) return;

        const defaultInputsExpr = action === 'diff' ? '["left", "right"]' : '["In"]';
        const inputsExpr = await VscodeUi.instance.inputBox({
            prompt: 'viewer.inputs (wf-lang expression, e.g. ["In"] or ["left","right"])',
            value: defaultInputsExpr
        });
        if (inputsExpr === undefined) return;

        let viewType: string | undefined;
        if (action === 'openWith') {
            const editors = await VscodeUi.instance.getViewerEditors();
            const picked = await VscodeUi.instance.quickPick({
                items: [
                    ...editors.map(e => ({
                        id: e.viewType,
                        label: e.label,
                        description: e.description
                    })),
                    { id: '__custom__', label: 'Custom viewType…', description: 'Enter any VS Code editor viewType string' }
                ],
                placeHolder: 'Choose an editor (viewType)'
            });
            if (!picked) return;

            if (picked === '__custom__') {
                const customViewType = await VscodeUi.instance.inputBox({
                    prompt: 'VS Code editor viewType (for vscode.openWith)',
                    value: ''
                });
                if (customViewType === undefined) return;
                const trimmed = customViewType.trim();
                if (!trimmed) return;

                viewType = trimmed;

                const add = await VscodeUi.instance.quickPick({
                    items: [
                        { id: 'yes', label: 'Add this editor to settings', description: `Append to ${settingsNamespace()}.viewerEditors` },
                        { id: 'no', label: 'Do not add' }
                    ],
                    placeHolder: 'Remember this editor?'
                });
                if (add === 'yes') {
                    const label = await VscodeUi.instance.inputBox({
                        prompt: 'Display label for this editor',
                        value: trimmed
                    });
                    if (label !== undefined) {
                        await VscodeUi.instance.appendViewerEditor({
                            label: label.trim() || trimmed,
                            viewType: trimmed
                        });
                    }
                }
            } else {
                viewType = picked;
            }

            // Special-case: "default" means normal open (not openWith).
            if (viewType === 'default') {
                annotationText = `@viewer(\n    action="open",\n    inputs=${inputsExpr.trim()},\n    token="last"\n)`;
            } else {
                annotationText = `@viewer(\n    action="openWith",\n    inputs=${inputsExpr.trim()},\n    token="last",\n    viewType=${toWfStringLiteral(viewType)}\n)`;
            }
        }

        if (action === 'open') {
            annotationText = `@viewer(\n    action="open",\n    inputs=${inputsExpr.trim()},\n    token="last"\n)`;
        }

        if (action === 'diff') {
            const title = await VscodeUi.instance.inputBox({
                prompt: 'viewer.title (optional; shown in the diff editor tab)',
                value: 'Workflow Diff'
            });
            if (title === undefined) return;
            annotationText = `@viewer(\n    action="diff",\n    inputs=${inputsExpr.trim()},\n    token="last",\n    title=${toWfStringLiteral(title)}\n)`;
        }

        return annotationText;
    }
}
