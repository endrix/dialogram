import { inject, injectable, optional } from 'inversify';
import { AgentEditOutcomeSink } from '@dialogram/diagram-server/server/agent-edit-outcome';
import * as vscode from 'vscode';
import { URI } from 'vscode-uri';
import { SidecarRuntimeService, type CreateNodeStrings, type CreateNodeBehavior, CreateNodeVariant } from '../sidecar-runtime-config';
import { parseCapabilitiesDiagnostic, type SidecarCapabilities, type SidecarEdgeRole } from '../../sidecar-capabilities';
import { invokeSidecar, type SidecarOpResult } from '../../sidecar-transport';

/** What one sidecar request came back as; the transport's result. */
export type SidecarInvocationResult = SidecarOpResult;

@injectable()
export class SidecarInvoker {
    /** What each sidecar command says it can do, asked once per session. */
    private readonly capabilitiesByCommand = new Map<string, Promise<SidecarCapabilities | undefined>>();

    /** Where an agent's diagram tool reads what its edits were answered (see AgentEditOutcomeSink). */
    @inject(AgentEditOutcomeSink)
    @optional()
    protected readonly editOutcomes?: AgentEditOutcomeSink;

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
        const result = await this.invokeSidecar(sourceUri, payload);
        this.editOutcomes?.record({ op: payload.op, ok: result.ok, ...(result.ok ? {} : { message: result.message }) });
        return result;
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
        const roles = (await this.capabilities(sourceUri))?.edgeRoles;
        return roles && roles.length > 0 ? roles : undefined;
    }

    /**
     * Whether the sidecar declares a feature (`getCapabilities.features`);
     * false when it declares none, or cannot be asked.
     */
    async hasFeature(sourceUri: string, feature: string): Promise<boolean> {
        return (await this.capabilities(sourceUri))?.features[feature] === true;
    }

    /**
     * Whether the sidecar lists `op` (its bare name) among the ops it does;
     * false when it lists none, or cannot be asked.
     */
    async supportsOp(sourceUri: string, op: string): Promise<boolean> {
        return (await this.capabilities(sourceUri))?.supportedOps.has(op) === true;
    }

    /**
     * What the sidecar says it can do: asked once per sidecar command for the
     * session, not on every edit. Each ask is a process of its own, and what
     * a sidecar offers does not change while it is running. A failed ask is
     * not kept, so the next one tries again.
     */
    private async capabilities(sourceUri: string): Promise<SidecarCapabilities | undefined> {
        let key: string;
        try {
            key = this.sidecarCommand(vscode.Uri.parse(sourceUri));
        } catch {
            key = sourceUri;
        }
        let pending = this.capabilitiesByCommand.get(key);
        if (!pending) {
            pending = this.sendSidecarCapabilitiesDetailed(sourceUri).then(result => {
                if (!result.ok || !result.response) {
                    this.capabilitiesByCommand.delete(key);
                    return undefined;
                }
                return parseCapabilitiesDiagnostic(result.response.diagnostic, '');
            });
            this.capabilitiesByCommand.set(key, pending);
        }
        return pending;
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
