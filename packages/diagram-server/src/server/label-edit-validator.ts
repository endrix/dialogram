import { inject, injectable } from 'inversify';
import { LabelEditValidator, ModelState } from '@eclipse-glsp/server';
import { ValidationStatus } from '@eclipse-glsp/protocol';
import { WorkflowDiagramTypes, WorkflowDiagramMetadata } from '@dialogram/shared';

@injectable()
export class WorkflowLabelEditValidator extends LabelEditValidator {
    @inject(ModelState)
    protected readonly modelState!: ModelState;

    override validate(label: string, element: import('@eclipse-glsp/graph').GModelElement): ValidationStatus {
        const newText = (label ?? '').trim();
        const elementAny: any = element as any;
        const type = elementAny.type as string | undefined;

        // Only validate our boundary port labels; everything else OK.
        if (type === WorkflowDiagramTypes.LABEL_BOUNDARY_NAME) {
            if (!newText) {
                return { severity: ValidationStatus.Severity.ERROR, message: 'Port name is required.' };
            }
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(newText)) {
                return { severity: ValidationStatus.Severity.ERROR, message: 'Invalid port name (must be an identifier).' };
            }
            const rootArgs: any = this.modelState.root?.args ?? {};
            const existing = new Set<string>();
            // Best-effort uniqueness check using current model root args
            // (source-of-truth enforcement is done again in the operation handler).
            for (const child of (this.modelState.root as any)?.children ?? []) {
                const n = child?.args?.[WorkflowDiagramMetadata.PORT_NAME];
                if (typeof n === 'string') {
                    existing.add(n);
                }
            }
            if (existing.has(newText)) {
                return { severity: ValidationStatus.Severity.ERROR, message: `Port '${newText}' already exists.` };
            }
            return { severity: ValidationStatus.Severity.OK };
        }

        if (type === WorkflowDiagramTypes.LABEL_BOUNDARY_TYPE) {
            if (!newText) {
                return { severity: ValidationStatus.Severity.ERROR, message: 'Port type is required.' };
            }
            return { severity: ValidationStatus.Severity.OK };
        }

        return { severity: ValidationStatus.Severity.OK };
    }
}
