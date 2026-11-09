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
import { AnnotationEditor } from '../annotation-editor';
import { AnnotationTemplate } from '../annotation-template';
import { NodeSectionContribution } from '../node-section';
import { AgentAnnotationEditor } from './agent-editor';
import { AgentNodeSections } from './agent-sections';
import { ToolAnnotationEditor } from './tool-editor';
import { ToolAnnotationTemplate } from './tool-template';
import { ViewerAnnotationTemplate } from './viewer-template';

/** Fresh instances, in the order the panel shows them. */
export function stockAnnotationEditors(): AnnotationEditor[] {
    return [new ToolAnnotationEditor(), new AgentAnnotationEditor()];
}

/** A fresh instance: it keeps the chat history it last drew. */
export function stockNodeSections(): NodeSectionContribution[] {
    return [new AgentNodeSections()];
}

/** The wizard's templates, in its menu order. */
export function stockAnnotationTemplates(): AnnotationTemplate[] {
    return [new ToolAnnotationTemplate(), new ViewerAnnotationTemplate()];
}

/** Bind fresh instances of all of it into a feature module. */
export function bindAgentUi(bind: interfaces.Bind): void {
    for (const editor of stockAnnotationEditors()) {
        bind(AnnotationEditor).toConstantValue(editor);
    }
    for (const sections of stockNodeSections()) {
        bind(NodeSectionContribution).toConstantValue(sections);
    }
    for (const template of stockAnnotationTemplates()) {
        bind(AnnotationTemplate).toConstantValue(template);
    }
}

/** The agent workflow UI as a feature module of its own. */
export const agentUiModule = new ContainerModule(bind => bindAgentUi(bind));
