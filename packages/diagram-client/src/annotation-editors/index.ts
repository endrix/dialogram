/**
 * The annotation editors the stock client ships: `@tool` and `@agent`.
 */
import type { AnnotationEditor } from '../annotation-editor';
import { AgentAnnotationEditor } from './agent-editor';
import { ToolAnnotationEditor } from './tool-editor';

/** Fresh instances, in the order the panel shows them. */
export function stockAnnotationEditors(): AnnotationEditor[] {
    return [new ToolAnnotationEditor(), new AgentAnnotationEditor()];
}
