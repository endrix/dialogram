/**
 * The `@tool` annotation's editor: the command, its argument list and whether
 * it inherits stdio.
 */
import type { AnnotationEditor, AnnotationEditorContext } from '../annotation-editor';
import { VscodeUi } from '../vscode-ui';
import { serializeWfStringListExpr, stripQuotesIfStringLiteral, toWfStringLiteral, tryParseWfStringListExpr } from './literals';

export class ToolAnnotationEditor implements AnnotationEditor {
    readonly annotationName = 'tool';
    readonly reservedArgs = ['cmd', 'args', 'inheritStdio'];
    readonly mergeArgUpdates = true;
    readonly quickAdd = {
        label: 'Add @tool',
        title: 'Add or update @tool annotation',
        annotationText: '@tool(\n    cmd="bash",\n    args=["-lc", ""],\n    inheritStdio=true\n)'
    };

    /** `@tool(cmd=..., args=..., inherit_stdio=...)` first, in that order, then the rest. */
    formatAnnotation(argsMap: ReadonlyMap<string, string>, pairs: ReadonlyArray<readonly [string, string]>): string {
        const cmd = argsMap.get('cmd')?.trim();
        const argsExpr = argsMap.get('args')?.trim();
        const inherit = argsMap.get('inheritStdio')?.trim() ?? argsMap.get('inherit_stdio')?.trim();

        const ordered: Array<[string, string]> = [];
        if (cmd) ordered.push(['cmd', cmd]);
        if (argsExpr) ordered.push(['args', argsExpr]);
        if (inherit) {
            const normalizedBool = /^(true|false)$/i.test(inherit)
                ? (inherit.toLowerCase() === 'true' ? 'True' : 'False')
                : inherit;
            ordered.push(['inherit_stdio', normalizedBool]);
        }

        for (const [k, v] of pairs) {
            if (k === 'cmd' || k === 'args' || k === 'inheritStdio' || k === 'inherit_stdio') continue;
            ordered.push([k, v]);
        }

        return ordered.length === 0
            ? '@tool'
            : `@tool(\n${ordered.map(([k, v]) => `    ${k}=${v}`).join(',\n')}\n)`;
    }

    render(context: AnnotationEditorContext): void {
        const { args: argsMap, body } = context;

        // cmd (string)
        const cmdRow = document.createElement('div');
        cmdRow.className = 'annotation-field';

        const cmdLabel = document.createElement('div');
        cmdLabel.className = 'annotation-label';
        cmdLabel.textContent = 'cmd (string)';

        const cmdInput = document.createElement('input');
        cmdInput.className = 'annotation-input';
        cmdInput.placeholder = 'e.g. bash';
        cmdInput.value = stripQuotesIfStringLiteral(argsMap.get('cmd') ?? '');
        cmdInput.addEventListener('input', () => {
            argsMap.set('cmd', toWfStringLiteral(cmdInput.value));
        });

        cmdRow.appendChild(cmdLabel);
        cmdRow.appendChild(cmdInput);
        body.appendChild(cmdRow);

        // args (list of strings) + raw expression fallback
        const argsContainer = document.createElement('div');
        argsContainer.className = 'annotation-args-container';

        const argsHeader = document.createElement('div');
        argsHeader.className = 'annotation-args-header';

        const argsTitle = document.createElement('div');
        argsTitle.className = 'annotation-args-title';
        argsTitle.textContent = 'args (list)';

        const argsMode = document.createElement('div');
        argsMode.className = 'annotation-args-mode';

        const toRawBtn = document.createElement('button');
        toRawBtn.type = 'button';
        toRawBtn.className = 'mini-btn';
        toRawBtn.textContent = 'Raw…';

        const toListBtn = document.createElement('button');
        toListBtn.type = 'button';
        toListBtn.className = 'mini-btn';
        toListBtn.textContent = 'List…';

        argsMode.appendChild(toListBtn);
        argsMode.appendChild(toRawBtn);
        argsHeader.appendChild(argsTitle);
        argsHeader.appendChild(argsMode);

        const argsHelp = document.createElement('div');
        argsHelp.className = 'annotation-args-help';
        argsHelp.textContent = 'Each row is one CLI argument (string).';

        const argsList = document.createElement('div');
        argsList.className = 'annotation-args-list';

        const addArgBtn = document.createElement('button');
        addArgBtn.type = 'button';
        addArgBtn.className = 'mini-btn';
        addArgBtn.textContent = 'Add item';

        const rawRow = document.createElement('div');
        rawRow.className = 'annotation-field';
        const rawLabel = document.createElement('div');
        rawLabel.className = 'annotation-label';
        rawLabel.textContent = 'args (expression)';
        const rawTextarea = document.createElement('textarea');
        rawTextarea.className = 'annotation-input annotation-textarea';
        rawTextarea.rows = 3;
        rawTextarea.placeholder = 'e.g. ["-lc", "{in.exe} {in.input} > {out.stdout}"]';
        rawRow.appendChild(rawLabel);
        rawRow.appendChild(rawTextarea);

        let argsItems: string[] = [];
        let mode: 'list' | 'raw' = 'list';

        const renderArgsList = () => {
            argsList.innerHTML = '';
            argsItems.forEach((val, idx) => {
                const row = document.createElement('div');
                row.className = 'annotation-args-item';

                const idxEl = document.createElement('div');
                idxEl.className = 'annotation-args-index';
                idxEl.textContent = String(idx);

                const inp = document.createElement('input');
                inp.className = 'annotation-input annotation-args-input';
                inp.value = val;
                inp.placeholder = 'argument';
                inp.addEventListener('input', () => {
                    argsItems[idx] = inp.value;
                    argsMap.set('args', serializeWfStringListExpr(argsItems));
                });

                const rm = document.createElement('button');
                rm.type = 'button';
                rm.className = 'mini-btn danger icon-only';
                rm.title = 'Remove item';
                rm.setAttribute('aria-label', 'Remove item');
                const rmIcon = document.createElement('span');
                rmIcon.className = 'codicon codicon-remove';
                rm.appendChild(rmIcon);
                rm.addEventListener('click', () => {
                    argsItems.splice(idx, 1);
                    argsMap.set('args', serializeWfStringListExpr(argsItems));
                    renderArgsList();
                });

                row.appendChild(idxEl);
                row.appendChild(inp);
                row.appendChild(rm);
                argsList.appendChild(row);
            });
        };

        const setMode = (next: 'list' | 'raw') => {
            mode = next;
            const showList = mode === 'list';
            argsList.style.display = showList ? '' : 'none';
            addArgBtn.style.display = showList ? '' : 'none';
            argsHelp.style.display = showList ? '' : 'none';
            rawRow.style.display = showList ? 'none' : '';
        };

        addArgBtn.addEventListener('click', () => {
            argsItems.push('');
            argsMap.set('args', serializeWfStringListExpr(argsItems));
            renderArgsList();
        });

        rawTextarea.addEventListener('input', () => {
            argsMap.set('args', rawTextarea.value);
        });

        toRawBtn.addEventListener('click', () => {
            rawTextarea.value = argsMap.get('args') ?? '';
            setMode('raw');
        });

        toListBtn.addEventListener('click', () => {
            const parsed = tryParseWfStringListExpr(argsMap.get('args') ?? '');
            if (!parsed) {
                VscodeUi.instance.infoMessage('Cannot switch to list mode: args is not a list of string literals.');
                setMode('raw');
                return;
            }
            argsItems = parsed;
            argsMap.set('args', serializeWfStringListExpr(argsItems));
            renderArgsList();
            setMode('list');
        });

        // Initialize
        const initialArgsExpr = argsMap.get('args') ?? '';
        const parsed = tryParseWfStringListExpr(initialArgsExpr);
        if (parsed) {
            argsItems = parsed;
            argsMap.set('args', serializeWfStringListExpr(argsItems));
            renderArgsList();
            setMode('list');
        } else {
            rawTextarea.value = initialArgsExpr;
            setMode('raw');
        }

        argsContainer.appendChild(argsHeader);
        argsContainer.appendChild(argsHelp);
        argsContainer.appendChild(argsList);
        argsContainer.appendChild(addArgBtn);
        argsContainer.appendChild(rawRow);
        body.appendChild(argsContainer);

        // inheritStdio (bool)
        const inheritRow = document.createElement('div');
        inheritRow.className = 'annotation-field';
        const inheritLabel = document.createElement('div');
        inheritLabel.className = 'annotation-label';
        inheritLabel.textContent = 'inheritStdio (bool)';

        const inheritWrap = document.createElement('div');
        inheritWrap.className = 'annotation-checkbox-wrap';

        const inherit = document.createElement('input');
        inherit.type = 'checkbox';
        inherit.className = 'annotation-checkbox';
        const cur = (argsMap.get('inheritStdio') ?? '').trim().toLowerCase();
        inherit.checked = cur === 'true';
        argsMap.set('inheritStdio', inherit.checked ? 'true' : 'false');
        inherit.addEventListener('change', () => {
            argsMap.set('inheritStdio', inherit.checked ? 'true' : 'false');
        });

        const inheritText = document.createElement('div');
        inheritText.className = 'annotation-checkbox-text';
        inheritText.textContent = inherit.checked ? 'true' : 'false';
        inherit.addEventListener('change', () => {
            inheritText.textContent = inherit.checked ? 'true' : 'false';
        });

        inheritWrap.appendChild(inherit);
        inheritWrap.appendChild(inheritText);
        inheritRow.appendChild(inheritLabel);
        inheritRow.appendChild(inheritWrap);
        body.appendChild(inheritRow);
    }
}
