/**
 * The agent workflow UI the stock client ships: the `@tool` and `@agent`
 * annotation editors, the agent sections of a node's panel, and the wizard's
 * `@tool` and `@viewer` templates.
 */
import type { AnnotationEditor } from '../annotation-editor';
import type { AnnotationTemplate } from '../annotation-template';
import type { NodeSectionContribution } from '../node-section';
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
