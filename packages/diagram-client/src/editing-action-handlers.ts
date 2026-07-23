import { inject, injectable, optional } from 'inversify';
import { EditorContextService, IActionDispatcher, IGridManager, TYPES } from '@eclipse-glsp/client';
import { Action as GlspAction, ApplyLabelEditOperation, ICommand, IActionHandler } from '@eclipse-glsp/sprotty';
import { VscodeUi, type VscodeQuickPickItem } from './vscode-ui';
import { settingsNamespace } from './profile';
import { EXECUTION_OVERLAY_ACTION_KIND, type ExecutionOverlayActionPayload } from '@dialogram/shared';

export type WorkflowWorkspaceEntity = {
    name: string;
    type: 'task' | 'workflow';
    namespace: string;
    documentUri: string;
    inputPorts: string[];
    outputPorts: string[];
    importAlias?: string;
    /** Optional: text to use when referencing this type (e.g. alias.Task) */
    referenceText?: string;
};

export type WorkflowAgentSkill = {
    name: string;
    description?: string;
    root: string;
    skillDir: string;
    skillMdPath: string;
    hasSkillMd: boolean;
    hooks: string[];
    declaredHooks?: {
        pre?: string;
        post?: string;
    };
    missingDeclaredHooks?: string[];
    warnings?: string[];
};

export type WorkflowClaudeAgentProfile = {
    name: string;
    description?: string;
    path: string;
    ignoredFields?: string[];
    warnings?: string[];
};

export namespace WorkflowPromptLabelEditAction {
    export const KIND = 'dialogram.promptLabelEdit';

    export interface PromptLabelEditAction extends GlspAction {
        kind: typeof KIND;
        labelId: string;
        title: string;
        value?: string;
        placeholder?: string;
    }

    export function is(action: unknown): action is PromptLabelEditAction {
        return !!action && typeof action === 'object' && (action as any).kind === KIND;
    }
}

export namespace WorkflowPromptRenameEntityAction {
    export const KIND = 'dialogram.promptRenameEntity';

    export interface Action extends GlspAction {
        kind: typeof KIND;
        elementId: string;
        title: string;
        value?: string;
        placeholder?: string;
    }

    export function is(action: unknown): action is Action {
        return !!action && typeof action === 'object' && (action as any).kind === KIND;
    }
}

export namespace WorkflowRenameEntityOperation {
    export const KIND = 'dialogram.renameEntity';

    export interface Operation extends GlspAction {
        kind: typeof KIND;
        isOperation: true;
        elementId: string;
        newName: string;
    }

    export function create(options: Omit<Operation, 'kind'>): Operation {
        return { kind: KIND, ...options };
    }
}

export namespace WorkflowEditParametersAction {
    export const KIND = 'dialogram.editParameters';

    export interface EditParametersAction extends GlspAction {
        kind: typeof KIND;
        elementId: string;
    }

    export function is(action: unknown): action is EditParametersAction {
        return !!action && typeof action === 'object' && (action as any).kind === KIND;
    }
}

export namespace WorkflowEditAnnotationsAction {
    export const KIND = 'dialogram.editAnnotations';

    export interface Action extends GlspAction {
        kind: typeof KIND;
        elementId: string;
    }

    export function is(action: unknown): action is Action {
        return !!action && typeof action === 'object' && (action as any).kind === KIND;
    }
}

export namespace WorkflowUpdateDefinitionAnnotationOperation {
    export const KIND = 'dialogram.updateDefinitionAnnotation';

    export type UpdateAction = 'upsert' | 'remove';

    export interface Operation extends GlspAction {
        kind: typeof KIND;
        isOperation: true;
        elementId: string;
        action: UpdateAction;
        annotationName: string;
        /** Raw annotation text starting with '@name'. For action='upsert'. */
        annotationText?: string;
        /** When set, uses merge semantics: only listed args are updated; unlisted args are preserved. */
        argUpdates?: Record<string, string>;
    }

    export function create(options: Omit<Operation, 'kind'>): Operation {
        return { kind: KIND, ...options };
    }
}

export namespace WorkflowUpdateDefinitionParameterOperation {
    export const KIND = 'dialogram.updateDefinitionParameter';

    export type UpdateAction = 'upsert' | 'remove';

    export interface Operation extends GlspAction {
        kind: typeof KIND;
        isOperation: true;
        elementId: string;
        action: UpdateAction;
        parameterName: string;
        /** Raw parameter text (for action='upsert'), e.g. 'File path = "./x"'. */
        parameterText?: string;
    }

    export function create(options: Omit<Operation, 'kind'>): Operation {
        return { kind: KIND, ...options };
    }
}

export namespace WorkflowUpdateEntityParameterOperation {
    export const KIND = 'dialogram.updateEntityParameter';

    export interface Operation extends GlspAction {
        kind: typeof KIND;
        elementId: string;
        parameterName: string;
        newValue: string;
    }

    export function create(options: Omit<Operation, 'kind'>): Operation {
        return { kind: KIND, ...options };
    }
}

export namespace WorkflowUpdateEdgeCapacityOperation {
    export const KIND = 'dialogram.updateEdgeCapacity';

    export interface Operation extends GlspAction {
        kind: typeof KIND;
        elementId: string;
        /** New queue capacity, or null to clear it (revert to the runtime default). */
        capacity: number | null;
    }

    export function create(options: Omit<Operation, 'kind'>): Operation {
        return { kind: KIND, ...options };
    }
}

export namespace WorkflowRequestWorkspaceEntitiesOperation {
    export const KIND = 'dialogram.requestWorkspaceEntities';

    export type ExpectedType = 'task' | 'workflow' | 'any';

    export interface Operation extends GlspAction {
        kind: typeof KIND;
        elementId: string;
        expectedType?: ExpectedType;
        currentType?: string;
    }

    export function create(options: Omit<Operation, 'kind'>): Operation {
        return { kind: KIND, ...options };
    }
}

export namespace WorkflowRequestAgentSkillsOperation {
    export const KIND = 'dialogram.requestAgentSkills';

    export type RootsMode = 'all' | 'project';

    export interface Operation extends GlspAction {
        kind: typeof KIND;
        elementId: string;
        rootsMode?: RootsMode;
    }

    export function create(options: Omit<Operation, 'kind'>): Operation {
        return { kind: KIND, ...options };
    }
}

export namespace WorkflowShowWorkspaceEntitiesAction {
    export const KIND = 'dialogram.showWorkspaceEntities';

    export interface Action extends GlspAction {
        kind: typeof KIND;
        elementId: string;
        expectedType?: WorkflowRequestWorkspaceEntitiesOperation.ExpectedType;
        currentType?: string;
        entities: WorkflowWorkspaceEntity[];
    }

    export function is(action: unknown): action is Action {
        return !!action && typeof action === 'object' && (action as any).kind === KIND;
    }
}

export namespace WorkflowShowAgentSkillsAction {
    export const KIND = 'dialogram.showAgentSkills';

    export interface Action extends GlspAction {
        kind: typeof KIND;
        elementId: string;
        skills: WorkflowAgentSkill[];
    }

    export function is(action: unknown): action is Action {
        return !!action && typeof action === 'object' && (action as any).kind === KIND;
    }
}

export namespace WorkflowRequestClaudeAgentsOperation {
    export const KIND = 'dialogram.requestClaudeAgents';

    export interface Operation extends GlspAction {
        kind: typeof KIND;
        elementId: string;
    }

    export function create(options: Omit<Operation, 'kind'>): Operation {
        return { kind: KIND, ...options };
    }
}

export namespace WorkflowShowClaudeAgentsAction {
    export const KIND = 'dialogram.showClaudeAgents';

    export interface Action extends GlspAction {
        kind: typeof KIND;
        elementId: string;
        agents: WorkflowClaudeAgentProfile[];
    }

    export function is(action: unknown): action is Action {
        return !!action && typeof action === 'object' && (action as any).kind === KIND;
    }
}

export namespace WorkflowUpdateEntityInstanceTypeOperation {
    export const KIND = 'dialogram.updateEntityInstanceType';

    export interface Operation extends GlspAction {
        kind: typeof KIND;
        elementId: string;
        newEntityName: string;
        inputPorts: string[];
        outputPorts: string[];
    }

    export function create(options: Omit<Operation, 'kind'>): Operation {
        return { kind: KIND, ...options };
    }
}

export namespace WorkflowCreateBoundaryPortOperation {
    export const KIND = 'dialogram.createBoundaryPort';

    export interface Operation extends GlspAction {
        kind: typeof KIND;
        direction: 'input' | 'output';
        portName: string;
        portType: string;
    }

    export function create(options: Omit<Operation, 'kind'>): Operation {
        return { kind: KIND, ...options };
    }
}

export namespace WorkflowUpdateEntityPortOperation {
    export const KIND = 'dialogram.updateEntityPort';

    export interface Operation extends GlspAction {
        kind: typeof KIND;
        /** Referenced entity type name (as used in the workflow, e.g. TaskName). */
        entityType: string;
        /** If known, the document URI where the task is defined (for cross-file edits). */
        entityDocumentUri?: string;
        portDirection: 'input' | 'output';
        /** Current port name (before edit). */
        portName: string;
        /** GModel port element id (e.g. <nodeId>_port_<portName>). */
        portElementId: string;
        field: 'name' | 'type';
        newValue: string;
    }

    export function create(options: Omit<Operation, 'kind'>): Operation {
        return { kind: KIND, ...options };
    }
}

export namespace WorkflowRerouteEdgesAvoidOverlapsOperation {
    export const KIND = 'dialogram.rerouteEdgesAvoidOverlaps';

    export interface Operation extends GlspAction {
        kind: typeof KIND;
        /** If empty/undefined, reroutes all edges in the diagram. */
        elementIds?: string[];
        /** Optional: provide current drag positions to make server routing match drag preview. */
        movedElements?: { elementId: string; position: { x: number; y: number } }[];
        /** When true, update the model but skip persistence (useful for drag preview). */
        preview?: boolean;
    }

    export function create(options: Omit<Operation, 'kind'>): Operation {
        return { kind: KIND, ...options };
    }
}

export namespace WorkflowToggleGridAction {
    export const KIND = 'dialogram.toggleGrid';

    export interface Action extends GlspAction {
        kind: typeof KIND;
        show?: boolean;
    }

    export function is(action: unknown): action is Action {
        return !!action && typeof action === 'object' && (action as any).kind === KIND;
    }
}

@injectable()
export class WorkflowPromptLabelEditActionHandler implements IActionHandler {
    @inject(TYPES.IActionDispatcher)
    protected readonly actionDispatcher!: IActionDispatcher;

    handle(action: GlspAction): ICommand | GlspAction | void {
        if (!WorkflowPromptLabelEditAction.is(action)) {
            return;
        }
        void this.promptAndApply(action);
    }

    protected async promptAndApply(action: WorkflowPromptLabelEditAction.PromptLabelEditAction): Promise<void> {
        const title = action.title || 'Edit';
        const currentValue = action.value ?? '';

        const next = await VscodeUi.instance.inputBox({
            prompt: title,
            value: currentValue,
            placeHolder: action.placeholder
        });
        if (next === undefined) {
            return;
        }

        const trimmed = next.trim();

        // Dispatch directly; this is an Operation and will be routed to the server.
        await this.actionDispatcher.dispatch(
            ApplyLabelEditOperation.create({
                labelId: action.labelId,
                text: trimmed
            })
        );
    }
}

@injectable()
export class WorkflowToggleGridActionHandler implements IActionHandler {
    @inject(TYPES.IActionDispatcher)
    protected readonly actionDispatcher!: IActionDispatcher;

    @optional()
    @inject(TYPES.IGridManager)
    protected readonly gridManager?: IGridManager;

    handle(action: GlspAction): ICommand | GlspAction | void {
        if (!WorkflowToggleGridAction.is(action)) {
            return;
        }

        const nextVisible = typeof action.show === 'boolean'
            ? action.show
            : !(this.gridManager?.isGridVisible ?? true);

        if (this.gridManager) {
            this.gridManager.setGridVisible(nextVisible);
            return;
        }

        void this.actionDispatcher.dispatch({ kind: 'showGrid', show: nextVisible } as any);
    }
}

@injectable()
export class WorkflowPromptRenameEntityActionHandler implements IActionHandler {
    @inject(TYPES.IActionDispatcher)
    protected readonly actionDispatcher!: IActionDispatcher;

    handle(action: GlspAction): ICommand | GlspAction | void {
        if (!WorkflowPromptRenameEntityAction.is(action)) {
            return;
        }
        void this.promptAndApply(action);
    }

    protected async promptAndApply(action: WorkflowPromptRenameEntityAction.Action): Promise<void> {
        const title = action.title || 'Rename';
        const currentValue = action.value ?? '';

        const next = await VscodeUi.instance.inputBox({
            prompt: title,
            value: currentValue,
            placeHolder: action.placeholder
        });
        if (next === undefined) {
            return;
        }

        const trimmed = next.trim();
        if (!trimmed) {
            return;
        }

        await this.actionDispatcher.dispatch(
            WorkflowRenameEntityOperation.create({
                isOperation: true,
                elementId: action.elementId,
                newName: trimmed
            })
        );
    }
}

@injectable()
export class WorkflowEditParametersActionHandler implements IActionHandler {
    @inject(EditorContextService)
    protected readonly editorContext!: EditorContextService;

    @inject(TYPES.IActionDispatcher)
    protected readonly actionDispatcher!: IActionDispatcher;

    handle(action: GlspAction): ICommand | GlspAction | void {
        if (!WorkflowEditParametersAction.is(action)) {
            return;
        }
        void this.promptAndUpdate(action);
    }

    protected async promptAndUpdate(action: WorkflowEditParametersAction.EditParametersAction): Promise<void> {
        const root: any = this.editorContext.modelRoot as any;
        const element: any = root?.index?.getById?.(action.elementId) ?? root?.index?.find?.(action.elementId);
        const args: any = element?.args ?? {};

        const defParams: Array<{ name: string; kind: 'type' | 'value'; defaultValue?: string }> =
            (args['cal:entityDefParams'] as any[]) ?? [];
        const entityParams: Array<{ name: string; value: string }> = (args['cal:entityParameters'] as any[]) ?? [];

        if (!element || defParams.length === 0) {
            VscodeUi.instance.infoMessage('No parameters available for this element.');
            return;
        }

        const instantiatedNames = new Set(entityParams.map(p => p.name));
        const editable = defParams.filter(p => instantiatedNames.has(p.name));
        if (editable.length === 0) {
            VscodeUi.instance.infoMessage('No instantiated parameters to edit yet.');
            return;
        }

        const items: VscodeQuickPickItem[] = editable.map(p => ({ id: p.name, label: p.name }));
        const paramName = await VscodeUi.instance.quickPick({
            items,
            placeHolder: 'Select a parameter to edit'
        });
        if (!paramName) {
            return;
        }

        const current = entityParams.find(p => p.name === paramName)?.value;
        const newValue = await VscodeUi.instance.inputBox({
            prompt: `New value for ${paramName}`,
            value: current ?? ''
        });
        if (newValue === undefined) {
            return;
        }

        await this.actionDispatcher.dispatch(
            WorkflowUpdateEntityParameterOperation.create({
                elementId: action.elementId,
                parameterName: paramName,
                newValue: newValue.trim()
            })
        );
    }
}

function unqualifyName(name: string): string {
    const afterDots = name.split('.').pop() ?? name;
    const parts = afterDots.split('__');
    return parts.length > 0 ? parts[parts.length - 1] : afterDots;
}

function toWfStringLiteral(value: string): string {
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
}

@injectable()
export class WorkflowEditAnnotationsActionHandler implements IActionHandler {
    @inject(EditorContextService)
    protected readonly editorContext!: EditorContextService;

    @inject(TYPES.IActionDispatcher)
    protected readonly actionDispatcher!: IActionDispatcher;

    handle(action: GlspAction): ICommand | GlspAction | void {
        if (!WorkflowEditAnnotationsAction.is(action)) {
            return;
        }
        void this.promptAndUpdate(action);
    }

    protected async promptAndUpdate(action: WorkflowEditAnnotationsAction.Action): Promise<void> {
        const root: any = this.editorContext.modelRoot as any;
        const element: any = root?.index?.getById?.(action.elementId) ?? root?.index?.find?.(action.elementId);
        const args: any = element?.args ?? {};

        if (!element) {
            VscodeUi.instance.errorMessage('Cannot edit annotations: element not found.');
            return;
        }

        const defAnnotations: Array<{ name: string; text?: string; arguments?: Array<{ name: string; value: string }> }> =
            (args['cal:entityDefAnnotations'] as any[]) ?? [];
        const annotationNames = defAnnotations.map(a => a.name).filter(Boolean);

        const op = await VscodeUi.instance.quickPick({
            items: [
                { id: 'upsert', label: 'Add or Update Annotation…' },
                { id: 'remove', label: 'Remove Annotation…' }
            ],
            placeHolder: 'Choose an annotation operation'
        });
        if (!op) {
            return;
        }

        if (op === 'remove') {
            const toRemove = await VscodeUi.instance.quickPick({
                items: annotationNames.map(n => ({ id: n, label: `@${n}` })),
                placeHolder: 'Select an annotation to remove'
            });
            if (!toRemove) {
                return;
            }
            await this.actionDispatcher.dispatch(
                WorkflowUpdateDefinitionAnnotationOperation.create({
                    isOperation: true,
                    elementId: action.elementId,
                    action: 'remove',
                    annotationName: toRemove
                })
            );
            return;
        }

        // Upsert
        const template = await VscodeUi.instance.quickPick({
            items: [
                { id: 'tool', label: '@tool (external execution)', description: 'cmd, args, inheritStdio, ...' },
                { id: 'viewer', label: '@viewer (open outputs in VS Code)', description: 'open, diff, openWith (viewType)' },
                { id: 'path', label: '@path (external tool search paths)', description: 'paths=["./bin", "./tools"]' },
                { id: 'custom', label: 'Custom annotation…', description: 'Enter any name and arguments' }
            ],
            placeHolder: 'Choose an annotation template'
        });
        if (!template) {
            return;
        }

        let annotationName = '';
        let annotationText = '';

        if (template === 'tool') {
            annotationName = 'tool';

            // Try to seed from existing @tool if present
            const existing = defAnnotations.find(a => a.name === 'tool');
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

            const cmdExpr = existingArgs.has('cmd') && existingArgs.get('cmd')?.trim().startsWith('"')
                ? toWfStringLiteral(cmdRaw)
                : toWfStringLiteral(cmdRaw);

            annotationText = `@tool(\n    cmd=${cmdExpr},\n    args=${argsExpr.trim()},\n    inheritStdio=${inherit}\n)`;
        } else if (template === 'viewer') {
            annotationName = 'viewer';

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
        } else if (template === 'path') {
            annotationName = 'path';

            const paths: string[] = [];

            for (;;) {
                const next = await VscodeUi.instance.inputBox({
                    prompt: paths.length === 0 ? 'Add path (e.g. ./bin)' : 'Add another path (optional)'
                });
                if (next === undefined) return;
                const trimmed = next.trim();
                if (trimmed) {
                    paths.push(trimmed);
                }

                if (paths.length === 0) {
                    continue;
                }

                const addMore = await VscodeUi.instance.quickPick({
                    items: [
                        { id: 'yes', label: 'Add another path' },
                        { id: 'no', label: 'Done' }
                    ],
                    placeHolder: 'Add another path?'
                });
                if (addMore !== 'yes') {
                    break;
                }
            }

            if (paths.length === 0) return;

            const listExpr = `[${paths.map(p => toWfStringLiteral(p)).join(', ')}]`;
            annotationText = `@path(\n    paths=${listExpr}\n)`;
        } else {
            const name = await VscodeUi.instance.inputBox({
                prompt: 'Annotation name (without @)',
                value: ''
            });
            if (name === undefined) return;
            annotationName = unqualifyName(name.trim());
            if (!annotationName) return;

            const argsRaw = await VscodeUi.instance.inputBox({
                prompt: `Arguments for @${annotationName} (optional, e.g. key=\"value\", other=[1,2])`,
                value: ''
            });
            if (argsRaw === undefined) return;

            const trimmedArgs = argsRaw.trim();
            annotationText = trimmedArgs ? `@${annotationName}(${trimmedArgs})` : `@${annotationName}`;
        }

        if (!annotationText.startsWith('@')) {
            annotationText = `@${annotationText}`;
        }

        await this.actionDispatcher.dispatch(
            WorkflowUpdateDefinitionAnnotationOperation.create({
                isOperation: true,
                elementId: action.elementId,
                action: 'upsert',
                annotationName,
                annotationText
            })
        );
    }
}

@injectable()
export class WorkflowShowWorkspaceEntitiesActionHandler implements IActionHandler {
    @inject(TYPES.IActionDispatcher)
    protected readonly actionDispatcher!: IActionDispatcher;

    handle(action: GlspAction): ICommand | GlspAction | void {
        if (!WorkflowShowWorkspaceEntitiesAction.is(action)) {
            return;
        }
        void this.promptAndApply(action);
    }

    protected async promptAndApply(action: WorkflowShowWorkspaceEntitiesAction.Action): Promise<void> {
        const entities = action.entities ?? [];
        if (entities.length === 0) {
            VscodeUi.instance.infoMessage('No workspace entities available (or none imported into this file).');
            return;
        }

        const expected = action.expectedType ?? 'any';
        const filtered = expected === 'any'
            ? entities
            : entities.filter(e => e.type === expected);

        const items: VscodeQuickPickItem[] = filtered.map(e => ({
            id: e.referenceText ?? `${e.namespace ? e.namespace + '.' : ''}${e.name}`,
            label: e.referenceText ?? `${e.namespace ? e.namespace + '.' : ''}${e.name}`,
            description: e.type,
            detail: e.documentUri
        }));

        const chosenId = await VscodeUi.instance.quickPick({
            items,
            placeHolder: 'Select a new type'
        });
        if (!chosenId) {
            return;
        }

        const chosen =
            filtered.find(e => (e.referenceText ?? e.name) === chosenId) ??
            entities.find(e => (e.referenceText ?? e.name) === chosenId);
        if (!chosen) {
            VscodeUi.instance.errorMessage('Selected entity not found.');
            return;
        }

        await this.actionDispatcher.dispatch(
            WorkflowUpdateEntityInstanceTypeOperation.create({
                elementId: action.elementId,
                newEntityName: chosen.referenceText ?? chosen.name,
                inputPorts: chosen.inputPorts ?? [],
                outputPorts: chosen.outputPorts ?? []
            })
        );
    }
}

@injectable()
export class WorkflowShowAgentSkillsActionHandler implements IActionHandler {
    private static readonly skillsByElementId = new Map<string, WorkflowAgentSkill[]>();

    static getSkillsForElement(elementId: string): WorkflowAgentSkill[] {
        return this.skillsByElementId.get(elementId) ?? [];
    }

    handle(action: GlspAction): ICommand | GlspAction | void {
        if (!WorkflowShowAgentSkillsAction.is(action)) {
            return;
        }
        const elementId = String(action.elementId ?? '').trim();
        if (!elementId) {
            return;
        }
        const skills = Array.isArray(action.skills) ? action.skills : [];
        WorkflowShowAgentSkillsActionHandler.skillsByElementId.set(elementId, skills);
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(new CustomEvent('dialogram.agentSkills.updated', {
                detail: { elementId, count: skills.length }
            }));
        }
    }
}

@injectable()
export class WorkflowShowClaudeAgentsActionHandler implements IActionHandler {
    private static readonly agentsByElementId = new Map<string, WorkflowClaudeAgentProfile[]>();

    static getAgentsForElement(elementId: string): WorkflowClaudeAgentProfile[] {
        return this.agentsByElementId.get(elementId) ?? [];
    }

    handle(action: GlspAction): ICommand | GlspAction | void {
        if (!WorkflowShowClaudeAgentsAction.is(action)) {
            return;
        }
        const elementId = String(action.elementId ?? '').trim();
        if (!elementId) {
            return;
        }
        const agents = Array.isArray(action.agents) ? action.agents : [];
        WorkflowShowClaudeAgentsActionHandler.agentsByElementId.set(elementId, agents);
    }
}

// ── Live run agent stream (read-only observation of a running workflow) ──────
// A run streams agent message deltas over SSE; the host forwards them to the
// diagram client as batched events under the neutral EXECUTION_OVERLAY_ACTION_KIND
// (the execution-overlay seam's opaque events channel). This handler folds the
// events into per-instance live state and notifies the read-only UI via a window
// event (same decoupling pattern as WorkflowShowAgentSkillsAction).
export interface RunStreamEvent {
    seq?: number;
    type?: string;
    instance?: string;
    field?: string;
    delta?: string;
    name?: string;
    stopReason?: string;
    [key: string]: unknown;
}

export interface LiveAgentState {
    instance: string;
    text: string;
    reasoning: string;
    status: 'running' | 'done';
    toolCalls: string[];
    lastSeq: number;
    updatedAt: number;
}


@injectable()
export class RunAgentStreamActionHandler implements IActionHandler {
    private static readonly agents = new Map<string, LiveAgentState>();
    private static runActive = false;

    static getAgents(): LiveAgentState[] {
        return Array.from(RunAgentStreamActionHandler.agents.values())
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    static isRunActive(): boolean {
        return RunAgentStreamActionHandler.runActive;
    }

    /** Clear all live state (e.g. when a new run starts or the panel is dismissed). */
    static reset(): void {
        RunAgentStreamActionHandler.agents.clear();
        RunAgentStreamActionHandler.runActive = false;
        RunAgentStreamActionHandler.notify();
    }

    private static notify(): void {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            // eslint-disable-next-line no-console
            console.log('[wf-lang overlay] firing dialogram.runAgents.updated CustomEvent');
            window.dispatchEvent(new CustomEvent('dialogram.runAgents.updated'));
        }
    }

    handle(action: GlspAction): ICommand | GlspAction | void {
        if (!action || (action as { kind?: unknown }).kind !== EXECUTION_OVERLAY_ACTION_KIND) {
            return;
        }
        // Idempotency guard. The same `actionMessage` notification object can reach
        // this handler through BOTH the stock GLSP model-source path AND the raw
        // ExecutionOverlayMessageBridge (which routes client-only kinds when the
        // stock path drops them). window 'message' listeners share one event.data
        // object, so a per-object mark makes double-delivery a no-op — the stream
        // deltas must never be applied twice.
        const guarded = action as GlspAction & { __wfOverlayHandled?: boolean };
        if (guarded.__wfOverlayHandled) {
            return;
        }
        guarded.__wfOverlayHandled = true;
        const payload = action as unknown as ExecutionOverlayActionPayload;
        const events = Array.isArray(payload.events) ? (payload.events as RunStreamEvent[]) : [];
        for (const ev of events) {
            this.apply(ev);
        }
        // Permanent, ungated bisection log (deliverable): pairs with the host-side
        // `[wf-lang overlay] sent …` log. If this line appears in the webview
        // console but the bar stays dark, the fault is in rendering, not routing.
        // eslint-disable-next-line no-console
        console.log(
            `[wf-lang overlay] received ${events.length} events ` +
            `(${RunAgentStreamActionHandler.agents.size} agents, active=${RunAgentStreamActionHandler.runActive})`
        );
        RunAgentStreamActionHandler.notify();
    }

    private apply(ev: RunStreamEvent): void {
        const store = RunAgentStreamActionHandler.agents;
        const type = String(ev.type ?? '');
        if (type === 'run.started') {
            store.clear(); // fresh state for a new run
            RunAgentStreamActionHandler.runActive = true;
            return;
        }
        if (type === 'run.finished' || type === 'run.stream.closing') {
            RunAgentStreamActionHandler.runActive = false;
            for (const s of store.values()) {
                s.status = 'done';
            }
            return;
        }
        const instance = String(ev.instance ?? '').trim();
        if (!instance) {
            return;
        }
        let state = store.get(instance);
        if (!state) {
            state = { instance, text: '', reasoning: '', status: 'running', toolCalls: [], lastSeq: 0, updatedAt: 0 };
            store.set(instance, state);
        }
        state.lastSeq = typeof ev.seq === 'number' ? ev.seq : state.lastSeq;
        state.updatedAt = Date.now();
        switch (type) {
            case 'agent.message.start':
                // New firing: reset the in-progress message so the view shows the current turn.
                state.status = 'running';
                state.text = '';
                state.reasoning = '';
                state.toolCalls = [];
                break;
            case 'agent.message.delta':
                if (ev.field === 'reasoning') {
                    state.reasoning += String(ev.delta ?? '');
                } else {
                    state.text += String(ev.delta ?? '');
                }
                break;
            case 'agent.tool_call':
                if (ev.name) {
                    state.toolCalls.push(String(ev.name));
                }
                break;
            case 'agent.message.end':
                state.status = 'done';
                break;
            default:
                break;
        }
    }
}
