/**
 * The agent workflow UI: the `@tool` and `@agent` annotation editors, the agent
 * sections of a node's panel, and the wizard's `@tool` and `@viewer` templates.
 *
 * `agentUiModule` binds all of it. The stock bundle does not load it: a
 * product's own webview bundle passes it to
 * `startStockDiagram({ features: [agentUiModule] })`, imported by path as
 * `@dialogram/diagram-client/agent-ui/index`.
 */
import { ContainerModule, type interfaces } from 'inversify';
import { configureActionHandler } from '@eclipse-glsp/client';
import { AnnotationEditor } from '../annotation-editor';
import { AnnotationTemplate } from '../annotation-template';
import { NodeSectionContribution } from '../node-section';
import {
    WorkflowShowAgentSkillsAction,
    WorkflowShowAgentSkillsActionHandler,
    WorkflowShowClaudeAgentsAction,
    WorkflowShowClaudeAgentsActionHandler
} from '../editing-action-handlers';
import { AgentAnnotationEditor } from './agent-editor';
import { AgentNodeSections } from './agent-sections';
import { ToolAnnotationEditor } from './tool-editor';
import { ToolAnnotationTemplate } from './tool-template';
import { ViewerAnnotationTemplate } from './viewer-template';

/** Fresh instances, in the order the panel shows them. */
export function agentUiEditors(): AnnotationEditor[] {
    return [new ToolAnnotationEditor(), new AgentAnnotationEditor()];
}

/** A fresh instance: it keeps the chat history it last drew. */
export function agentUiNodeSections(): NodeSectionContribution[] {
    return [new AgentNodeSections()];
}

/** The wizard's templates, in its menu order. */
export function agentUiTemplates(): AnnotationTemplate[] {
    return [new ToolAnnotationTemplate(), new ViewerAnnotationTemplate()];
}

/** What a feature module's registry is handed, as GLSP's helpers take it. */
export interface ModuleContext {
    bind: interfaces.Bind;
    unbind: interfaces.Unbind;
    isBound: interfaces.IsBound;
    rebind: interfaces.Rebind;
}

/**
 * Bind fresh instances of all of it into a feature module, and the handlers
 * of the server's answers to the `@agent` editor's discovery requests (the
 * skills and agent presets it found), whose caches the editor and the Skill
 * row read.
 */
export function bindAgentUi(context: ModuleContext): void {
    const { bind } = context;
    configureActionHandler(context, WorkflowShowAgentSkillsAction.KIND, WorkflowShowAgentSkillsActionHandler);
    configureActionHandler(context, WorkflowShowClaudeAgentsAction.KIND, WorkflowShowClaudeAgentsActionHandler);
    for (const editor of agentUiEditors()) {
        bind(AnnotationEditor).toConstantValue(editor);
    }
    for (const sections of agentUiNodeSections()) {
        bind(NodeSectionContribution).toConstantValue(sections);
    }
    for (const template of agentUiTemplates()) {
        bind(AnnotationTemplate).toConstantValue(template);
    }
}

/** The agent workflow UI as a feature module of its own. */
export const agentUiModule = new ContainerModule((bind, unbind, isBound, rebind) => bindAgentUi({ bind, unbind, isBound, rebind }));
