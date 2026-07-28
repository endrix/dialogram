import { Action, Command, ModelState, OperationHandler } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { readAuthoritativeSourceText } from './authoritative-source-text';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { ReversibleWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-workspace-edit-command';
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
    }

    export function is(action: unknown): action is Operation {
        return !!action && typeof action === 'object' && (action as any).kind === KIND;
    }

    export function create(opts: Omit<Operation, 'kind'> & { isOperation?: boolean }): Operation {
        return { kind: KIND, ...opts };
    }
}

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
        const defName = unqualifyName(entityType);
        if (!defName) {
            return undefined;
        }

        const vscodeUri = vscode.Uri.parse(sourceUri);

        const command = new ReversibleWorkspaceEditCommand({
            label: (operation.action === 'remove' ? 'Remove Annotation' : 'Update Annotation') + this.sidecar.undoLabelSuffix(),
            uri: vscodeUri,
            computeEdits: async () => {
                const beforeText = (await vscode.workspace.openTextDocument(vscodeUri)).getText();
                let sidecarOp: string;
                let sidecarArgs: Record<string, unknown>;
                if (operation.action === 'remove') {
                    sidecarOp = this.sidecar.sidecarOp('removeDefinitionAnnotation');
                    sidecarArgs = {
                        entityType: defName,
                        annotationName: operation.annotationName,
                    };
                } else if (operation.argUpdates) {
                    // Merge mode: only update listed args, preserve everything else
                    sidecarOp = this.sidecar.sidecarOp('mergeDefinitionAnnotationArgs');
                    sidecarArgs = {
                        entityType: defName,
                        annotationName: operation.annotationName,
                        argUpdates: operation.argUpdates,
                    };
                } else {
                    sidecarOp = this.sidecar.sidecarOp('updateDefinitionAnnotation');
                    const normalizedAnnotationText = normalizePythonLiteralNames(operation.annotationText ?? '');
                    sidecarArgs = {
                        entityType: defName,
                        annotationName: operation.annotationName,
                        annotationText: normalizedAnnotationText,
                    };
                }
                const ok = await this.sendSidecarOp(sourceUri, {
                    op: sidecarOp,
                    args: sidecarArgs,
                });
                if (!ok) {
                    return undefined;
                }
                const afterText = await readAuthoritativeSourceText(vscodeUri);
                (command as any)._sourceBeforeText = beforeText;
                (command as any)._sourceAfterText = afterText;
                return [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')];
            },
        });
        return command;
    }

    private async sendSidecarOp(sourceUri: string, payload: { op: string; args: Record<string, unknown> }): Promise<boolean> {
        return this.sidecar.sendSidecarOp(sourceUri, payload);
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

function unqualifyName(name: string): string {
    const afterDots = name.split('.').pop() ?? name;
    const parts = afterDots.split('__');
    return parts.length > 0 ? (parts[parts.length - 1] ?? '') : afterDots;
}
