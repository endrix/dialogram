import * as vscode from 'vscode';
import { Action, Command, ModelState, OperationHandler } from '@eclipse-glsp/server';
import { normalizeWorkflowReferenceName } from '../source-analysis';
import { inject, injectable } from 'inversify';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { entityFileOf } from './entity-port-write';
import { producerWriteCommand } from './producer-write';
import { SidecarInvoker } from './sidecar-invoker';

export namespace UpdateDefinitionAnnotationOperation {
    export const KIND = 'dialogram.updateDefinitionAnnotation';

    export type UpdateAction = 'upsert' | 'remove';

    export interface Operation extends Action {
        kind: typeof KIND;
        elementId: string;
        action: UpdateAction;
        annotationName: string;
        annotationText?: string;
        /** When set, uses merge semantics: only listed args are updated; unlisted args are preserved. */
        argUpdates?: Record<string, string>;
        /**
         * Merge semantics too: args to take out of the annotation. Passed on
         * only to a producer that declares `features.mergeArgRemovals`.
         */
        argRemovals?: string[];
    }

    export function is(action: unknown): action is Operation {
        return !!action && typeof action === 'object' && (action as any).kind === KIND;
    }

    export function create(opts: Omit<Operation, 'kind'> & { isOperation?: boolean }): Operation {
        return { kind: KIND, ...opts };
    }
}

/** `mergeDefinitionAnnotationArgs` takes `argRemovals: [name]`, the args to take out. */
export const MERGE_ARG_REMOVALS = 'mergeArgRemovals';

@injectable()
export class UpdateDefinitionAnnotationOperationHandler extends OperationHandler {
    readonly operationType = UpdateDefinitionAnnotationOperation.KIND;

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(SidecarInvoker)
    protected readonly sidecar!: SidecarInvoker;

    createCommand(operation: Action): Command | undefined {
        if (!UpdateDefinitionAnnotationOperation.is(operation)) {
            return undefined;
        }

        const sourceUri = this.modelState.sourceUri;
        if (!sourceUri) {
            return undefined;
        }

        return this.createPythonCommand(operation, sourceUri);
    }

    private createPythonCommand(operation: UpdateDefinitionAnnotationOperation.Operation, sourceUri: string): Command | undefined {
        const element: any = this.modelState.index.find(operation.elementId);
        const args: any = element?.args ?? {};
        const entityType = (args[WorkflowDiagramMetadata.ENTITY_TYPE] as string | undefined) ?? '';
        const defName = normalizeWorkflowReferenceName(entityType) ?? '';
        if (!defName) {
            return undefined;
        }

        // Sent for the definition's own file: a class imported from another
        // module is declared there, not in the diagram's.
        const fileUri = entityFileOf(this.modelState, sourceUri, { entityType: defName, elementId: operation.elementId });
        const removing = operation.action === 'remove';
        // Removals not sent, said once the rest is written.
        let kept: string[] | undefined;
        return producerWriteCommand({
            label: (removing ? 'Remove Annotation' : 'Update Annotation') + this.sidecar.undoLabelSuffix(),
            sidecar: this.sidecar,
            failed: removing
                ? `@${operation.annotationName} was not removed from '${defName}'.`
                : `@${operation.annotationName} of '${defName}' was not changed.`,
            request: async () => {
                let sidecarOp: string;
                let sidecarArgs: Record<string, unknown>;
                if (removing) {
                    sidecarOp = this.sidecar.sidecarOp('removeDefinitionAnnotation');
                    sidecarArgs = {
                        entityType: defName,
                        annotationName: operation.annotationName,
                    };
                } else if (operation.argUpdates || operation.argRemovals?.length) {
                    // Merge mode: only update listed args, preserve everything else
                    sidecarOp = this.sidecar.sidecarOp('mergeDefinitionAnnotationArgs');
                    // The values as the editor wrote them: the producer spells its
                    // own literals, and only it knows its strings.
                    const argUpdates = operation.argUpdates ?? {};
                    let argRemovals = operation.argRemovals?.length ? operation.argRemovals : undefined;
                    kept = undefined;
                    // A producer that predates removals refuses an argument it does
                    // not know, the updates with it: it is sent them only when it
                    // says it takes them, and else the cleared ones stay.
                    if (argRemovals && !(await this.sidecar.hasFeature(sourceUri, MERGE_ARG_REMOVALS))) {
                        kept = argRemovals;
                        argRemovals = undefined;
                    }
                    if (Object.keys(argUpdates).length === 0 && !argRemovals) {
                        if (kept) {
                            void vscode.window.showWarningMessage(
                                `${kept.map(key => `'${key}'`).join(', ')} stay${kept.length === 1 ? 's' : ''} in @${operation.annotationName} of '${defName}': its producer has not said it takes arguments out.`
                            );
                        }
                        return undefined;
                    }
                    sidecarArgs = {
                        entityType: defName,
                        annotationName: operation.annotationName,
                        argUpdates,
                        ...(argRemovals ? { argRemovals } : {}),
                    };
                } else {
                    sidecarOp = this.sidecar.sidecarOp('updateDefinitionAnnotation');
                    sidecarArgs = {
                        entityType: defName,
                        annotationName: operation.annotationName,
                        annotationText: normalizePythonLiteralNames(operation.annotationText ?? ''),
                    };
                }
                return { fileUri, payload: { op: sidecarOp, args: sidecarArgs } };
            },
            afterApply: phase => {
                if (phase === 'execute' && kept) {
                    void vscode.window.showWarningMessage(
                        `${kept.map(key => `'${key}'`).join(', ')} stay${kept.length === 1 ? 's' : ''} in @${operation.annotationName} of '${defName}': its producer has not said it takes arguments out.`
                    );
                }
            }
        });
    }

}

function normalizePythonLiteralNames(text: string): string {
    const src = String(text ?? '');
    let out = '';
    let i = 0;
    let inSingle = false;
    let inDouble = false;
    let escaped = false;

    const isIdentifierStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
    const isIdentifierPart = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);

    while (i < src.length) {
        const ch = src[i] ?? '';

        if (inSingle || inDouble) {
            out += ch;
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (inSingle && ch === "'") {
                inSingle = false;
            } else if (inDouble && ch === '"') {
                inDouble = false;
            }
            i += 1;
            continue;
        }

        if (ch === "'") {
            inSingle = true;
            out += ch;
            i += 1;
            continue;
        }
        if (ch === '"') {
            inDouble = true;
            out += ch;
            i += 1;
            continue;
        }

        if (isIdentifierStart(ch)) {
            let j = i + 1;
            while (j < src.length && isIdentifierPart(src[j] ?? '')) {
                j += 1;
            }
            const token = src.slice(i, j);
            if (token === 'true') {
                out += 'True';
            } else if (token === 'false') {
                out += 'False';
            } else if (token === 'null') {
                out += 'None';
            } else {
                out += token;
            }
            i = j;
            continue;
        }

        out += ch;
        i += 1;
    }

    return out;
}
