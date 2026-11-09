/**
 * The annotation wizard's `@tool` template: the command, its argument list and
 * whether it inherits stdio, seeded from the definition's `@tool` if it has one.
 */
import type { AnnotationTemplate, AnnotationTemplateContext } from '../annotation-template';
import { VscodeUi } from '../vscode-ui';
import { toWfStringLiteral } from './literals';

export class ToolAnnotationTemplate implements AnnotationTemplate {
    readonly annotationName = 'tool';
    readonly label = '@tool (external execution)';
    readonly description = 'cmd, args, inheritStdio, ...';

    async compose(context: AnnotationTemplateContext): Promise<string | undefined> {
        // Seed from the definition's @tool, if it has one.
        const existing = context.existing;
        const existingArgs = new Map((existing?.arguments ?? []).map(a => [a.name, a.value]));

        const cmdRaw = await VscodeUi.instance.inputBox({
            prompt: 'tool.cmd (program to run)',
            value: existingArgs.get('cmd')?.replace(/^"|"$/g, '') ?? 'bash'
        });
        if (cmdRaw === undefined) return;

        const argsExpr = await VscodeUi.instance.inputBox({
            prompt: 'tool.args (wf-lang expression, e.g. ["-lc", "..."])',
            value: existingArgs.get('args') ?? '["-lc", "{in.exe} {in.input} > {out.stdout}"]'
        });
        if (argsExpr === undefined) return;

        const inherit = await VscodeUi.instance.quickPick({
            items: [
                { id: 'true', label: 'inheritStdio=true' },
                { id: 'false', label: 'inheritStdio=false' }
            ],
            placeHolder: 'tool.inheritStdio'
        });
        if (!inherit) return;

        const cmdExpr = toWfStringLiteral(cmdRaw);

        return `@tool(\n    cmd=${cmdExpr},\n    args=${argsExpr.trim()},\n    inheritStdio=${inherit}\n)`;
    }
}
