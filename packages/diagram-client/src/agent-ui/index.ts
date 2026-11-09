/**
 * The agent workflow UI the stock client ships: the `@tool` and `@agent`
 * annotation editors, and the agent sections of a node's panel.
 */
import type { AnnotationEditor } from '../annotation-editor';
import type { NodeSectionContribution } from '../node-section';
import { AgentAnnotationEditor } from './agent-editor';
import { AgentNodeSections } from './agent-sections';
import { ToolAnnotationEditor } from './tool-editor';

/** Fresh instances, in the order the panel shows them. */
export function stockAnnotationEditors(): AnnotationEditor[] {
    return [new ToolAnnotationEditor(), new AgentAnnotationEditor()];
}

/** A fresh instance: it keeps the chat history it last drew. */
export function stockNodeSections(): NodeSectionContribution[] {
    return [new AgentNodeSections()];
}
