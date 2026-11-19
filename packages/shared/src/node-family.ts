/**
 * The family a node belongs to (`NodeFamilySpec`), by its definition's
 * annotations: the one rule the canvas colours a node by, the server names
 * its class by, and a node list (`NodeListSpec`) finds its nodes by.
 *
 * Declaration order decides, so a node in two families lands in the one the
 * product listed first: a node can carry the annotation that makes it
 * openable AND the one that says what it is, and only the second describes
 * the node.
 */
import type { NodeFamilySpec } from './diagram-seams';

/** A definition's annotations, as the exporter writes them (`cal:entityDefAnnotations`). */
export type NodeAnnotationList = Array<{ name?: string; arguments?: Array<{ name?: string; value?: string }> }>;

export function resolveNodeFamily(
    annotations: NodeAnnotationList | undefined,
    families: readonly NodeFamilySpec[]
): NodeFamilySpec | undefined {
    const byName = new Map((Array.isArray(annotations) ? annotations : []).map(a => [a?.name ?? '', a]));
    return families.find(family => {
        const annotation = byName.get(family.annotation);
        if (!annotation) {
            return false;
        }
        if (!family.match) {
            return true;
        }
        const argument = annotation.arguments?.find(arg => arg?.name === family.match!.argument);
        // Values arrive serialized, so a string is quoted.
        const value = (argument?.value ?? '').replace(/^["']|["']$/g, '').toLowerCase();
        return family.match.oneOf.some(candidate => candidate.toLowerCase() === value);
    });
}

/** A family's name: its `id`, else its annotation. */
export function nodeFamilyName(family: NodeFamilySpec): string {
    return family.id ?? family.annotation;
}
