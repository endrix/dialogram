import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { URI } from 'vscode-uri';
import { SidecarRuntimeService, type CreateNodeStrings, type CreateNodeBehavior, CreateNodeVariant } from '../sidecar-runtime-config';
import { parseCapabilitiesDiagnostic, type SidecarEdgeRole } from '../../sidecar-capabilities';
import { invokeSidecar, type SidecarOpResult } from '../../sidecar-transport';

/** What one sidecar request came back as; the transport's result. */
export type SidecarInvocationResult = SidecarOpResult;

@injectable()
export class SidecarInvoker {
    /** The edge kinds each sidecar command offers, asked once per session. */
    private readonly edgeRolesByCommand = new Map<string, Promise<SidecarEdgeRole[] | undefined>>();

    constructor(
        @inject(SidecarRuntimeService)
        private readonly runtimeProfile: SidecarRuntimeService
    ) {}

    settingsNamespace(): string {
        return this.runtimeProfile.settingsNamespace;
    }

    sidecarOp(opName: string): string {
        return this.runtimeProfile.sidecarOp(opName);
    }

    rewriteSidecarOperation(operation: string): string {
        return this.runtimeProfile.rewriteSidecarOperation(operation);
    }

    sidecarCommand(scopeUri?: vscode.Uri): string {
        return this.runtimeProfile.getSidecarCommand(vscode, scopeUri);
    }

    cliCommand(scopeUri?: vscode.Uri): string {
        return this.runtimeProfile.getCliCommand(vscode, scopeUri);
    }

    undoLabelSuffix(): string {
        return this.runtimeProfile.undoLabelSuffix;
    }

    createNodeStrings(): CreateNodeStrings {
        return this.runtimeProfile.createNodeStrings;
    }

    createNodeBehavior(): CreateNodeBehavior {
        return this.runtimeProfile.createNodeBehavior;
    }

    createNodeVariants(): CreateNodeVariant[] {
        return this.runtimeProfile.createNodeVariants;
    }

    operationKindCreateEntityPort(): string {
        return this.runtimeProfile.operationKinds.createEntityPort;
    }

    operationKindDeleteEntityPort(): string {
        return this.runtimeProfile.operationKinds.deleteEntityPort;
    }

    async sendSidecarOpDetailed(sourceUri: string, payload: { op: string; args: Record<string, unknown> }): Promise<SidecarInvocationResult> {
        return this.invokeSidecar(sourceUri, payload);
    }

    async sendSidecarListDetailed(sourceUri: string, payload: { op: string; args: Record<string, unknown> }): Promise<SidecarInvocationResult> {
        return this.invokeSidecar(sourceUri, payload);
    }

    async sendSidecarCapabilitiesDetailed(sourceUri: string): Promise<SidecarInvocationResult> {
        return this.invokeSidecar(sourceUri, {
            op: this.sidecarOp('getCapabilities'),
            args: {}
        });
    }

    /**
     * The kinds of edge the sidecar's `connect` can make
     * (`getCapabilities.edgeRoles`); nothing when it lists none. Asked once per
     * sidecar command for the session, not on every connect: each ask is a
     * process of its own, and what a sidecar offers does not change while it
     * is running. A failed ask is not kept, so the next one tries again.
     */
    async edgeRoles(sourceUri: string): Promise<SidecarEdgeRole[] | undefined> {
        let key: string;
        try {
            key = this.sidecarCommand(vscode.Uri.parse(sourceUri));
        } catch {
            key = sourceUri;
        }
        let pending = this.edgeRolesByCommand.get(key);
        if (!pending) {
            pending = this.sendSidecarCapabilitiesDetailed(sourceUri).then(result => {
                if (!result.ok || !result.response) {
                    this.edgeRolesByCommand.delete(key);
                    return undefined;
                }
                return parseCapabilitiesDiagnostic(result.response.diagnostic, '')?.edgeRoles ?? [];
            });
            this.edgeRolesByCommand.set(key, pending);
        }
        const roles = await pending;
        return roles && roles.length > 0 ? roles : undefined;
    }

    async sendSidecarOp(sourceUri: string, payload: { op: string; args: Record<string, unknown> }): Promise<boolean> {
        const result = await this.invokeSidecar(sourceUri, payload);
        return result.ok;
    }

    async sendSidecarList(sourceUri: string, payload: { op: string; args: Record<string, unknown> }): Promise<any | undefined> {
        const result = await this.invokeSidecar(sourceUri, payload);
        return result.ok ? result.response : undefined;
    }

    private async invokeSidecar(sourceUri: string, payload: { op: string; args: Record<string, unknown> }): Promise<SidecarInvocationResult> {
        let command: string;
        try {
            command = this.sidecarCommand(vscode.Uri.parse(sourceUri));
        } catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : `Unable to start sidecar for ${payload.op}.` };
        }
        // Every diagram edit comes through here, and the caller awaits it inside a
        // workspace edit, so the transport always answers: a child that never
        // settles, or never starts, is a message, not a stranded edit.
        return invokeSidecar({
            command,
            file: URI.parse(sourceUri).fsPath,
            op: this.rewriteSidecarOperation(payload.op),
            args: payload.args
        });
    }
}
