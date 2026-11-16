/**
 * The arguments a node is made with.
 *
 * A type whose parameters have no default cannot be instantiated without
 * them: `text = Text()` is written, and the workflow then fails as it is
 * planned, the node never drawn. A producer that can say what a type takes
 * (`features.typeParameters`: `typeParameters {type}` answers
 * `diagnostic.parameters: [{name, type?, defaultValue?}]`) is asked before
 * the node is made, and each parameter without a default is asked of the
 * user. What is answered is source text, written as given (`createNode`'s
 * `expressions {name: text}`, `features.createNodeExpressions`); a copy of a
 * node carries the original's the same way.
 */
import type { SidecarInvoker } from './sidecar-invoker';

/** `typeParameters {type}`: the parameters an instance of a type is made with. */
export const TYPE_PARAMETERS = 'typeParameters';
/** `createNode` takes `expressions {name: source text}`, written verbatim. */
export const CREATE_NODE_EXPRESSIONS = 'createNodeExpressions';

export interface TypeParameter {
    name: string;
    type?: string;
    /** The default, as written; none: the parameter has to be given. */
    defaultValue?: string;
}

function isTypeParameter(value: unknown): value is TypeParameter {
    const v = value as TypeParameter | null;
    return !!v && typeof v === 'object' && typeof v.name === 'string' && v.name.trim() !== ''
        && (v.type === undefined || typeof v.type === 'string')
        && (v.defaultValue === undefined || typeof v.defaultValue === 'string');
}

/**
 * The parameters of `typeName` that have no default; nothing when the
 * producer cannot say (no `typeParameters`, or it could not resolve the
 * type: `createNode` then says why).
 */
export async function requiredParametersOf(
    sidecar: Pick<SidecarInvoker, 'hasFeature' | 'sidecarOp' | 'sendSidecarListDetailed'>,
    sourceUri: string,
    typeName: string
): Promise<TypeParameter[] | undefined> {
    if (!(await sidecar.hasFeature(sourceUri, TYPE_PARAMETERS))) {
        return undefined;
    }
    const result = await sidecar.sendSidecarListDetailed(sourceUri, {
        op: sidecar.sidecarOp('typeParameters'),
        args: { type: typeName }
    });
    const parameters = result.ok ? result.response?.diagnostic?.parameters : undefined;
    if (!Array.isArray(parameters)) {
        return undefined;
    }
    return parameters.filter(isTypeParameter).filter(parameter => parameter.defaultValue === undefined);
}
