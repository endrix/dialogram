/**
 * The agent workflow UI the stock client ships: the `@tool` and `@agent`
 * annotation editors.
 */
import type { AnnotationEditor } from '../annotation-editor';
import { AgentAnnotationEditor } from './agent-editor';
import { ToolAnnotationEditor } from './tool-editor';

/** Fresh instances, in the order the panel shows them. */
export function stockAnnotationEditors(): AnnotationEditor[] {
    return [new ToolAnnotationEditor(), new AgentAnnotationEditor()];
}
