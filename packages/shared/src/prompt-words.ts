/**
 * Words a prompt builds from the diagram or the product.
 *
 * The platform does not know a producer's type language: an example of a
 * port type is one the diagram already uses (its most frequent), which the
 * producer accepts, not one written here. A kind's name is the product's
 * (`typeLabel`); the article before it is chosen by how it starts.
 */
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from './diagram-types';

interface ElementLike {
    type?: string;
    args?: Record<string, unknown>;
    children?: readonly ElementLike[];
}

/** The elements that are ports a reader declared: an instance's, and the network's own (its boundary nodes). Not the copies a group frame or a bus draws. */
const DECLARED_PORTS = new Set<string>([
    WorkflowDiagramTypes.PORT_INPUT,
    WorkflowDiagramTypes.PORT_OUTPUT,
    WorkflowDiagramTypes.NODE_BOUNDARY_INPUT,
    WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT
]);

/** The port types the diagram's ports have, the most frequent first (ties in the order met). */
export function portTypesUsed(root: ElementLike | undefined): string[] {
    const counts = new Map<string, number>();
    const visit = (element: ElementLike | undefined): void => {
        if (!element) {
            return;
        }
        const type = element.args?.[WorkflowDiagramMetadata.PORT_TYPE];
        if (DECLARED_PORTS.has(element.type ?? '') && typeof type === 'string' && type.trim() !== '') {
            counts.set(type, (counts.get(type) ?? 0) + 1);
        }
        for (const child of element.children ?? []) {
            visit(child);
        }
    };
    visit(root);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([type]) => type);
}

/** `word` with its indefinite article: "an actor", "a network". */
export function withArticle(word: string): string {
    return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;
}
