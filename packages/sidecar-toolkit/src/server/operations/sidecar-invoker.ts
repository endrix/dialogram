import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { URI } from 'vscode-uri';
import { SidecarRuntimeService, type CreateNodeStrings, type CreateNodeBehavior } from '../sidecar-runtime-config';
import { describeChildFailure, runChildProcess } from '../../run-child-process';

export interface SidecarInvocationResult {
    ok: boolean;
    response?: any;
    message?: string;
    code?: string;
    stderr?: string;
}

@injectable()
export class SidecarInvoker {
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

    async sendSidecarOp(sourceUri: string, payload: { op: string; args: Record<string, unknown> }): Promise<boolean> {
        const result = await this.invokeSidecar(sourceUri, payload);
        return result.ok;
    }

    async sendSidecarList(sourceUri: string, payload: { op: string; args: Record<string, unknown> }): Promise<any | undefined> {
        const result = await this.invokeSidecar(sourceUri, payload);
        return result.ok ? result.response : undefined;
    }

    private async invokeSidecar(sourceUri: string, payload: { op: string; args: Record<string, unknown> }): Promise<SidecarInvocationResult> {
        try {
            const command = this.sidecarCommand(vscode.Uri.parse(sourceUri));
            const input = JSON.stringify({
                file: URI.parse(sourceUri).fsPath,
                op: this.rewriteSidecarOperation(payload.op),
                args: payload.args
            }) + '\n';

            // Every diagram edit comes through here, and the caller awaits it inside a
            // workspace edit. A child that never settles used to strand the edit with no
            // error and no way to retry — including the plain case of an unstartable
            // command, whose 'error' event had no listener at all.
            const result = await runChildProcess(command, [], { input });
            const { stdout, stderr } = result;
            const failure = describeChildFailure(command, result);
            if (failure) {
                return {
                    ok: false,
                    message: result.timedOut
                        ? `${failure} (while handling ${payload.op})`
                        : result.spawnError
                          ? failure
                          : `Sidecar exited with code ${result.code} while handling ${payload.op}.`,
                    stderr: stderr.trim() || undefined
                };
            }
            if (stdout.trim() === '') {
                return { ok: true };
            }

            try {
                const response = JSON.parse(stdout.trim());
                if (response?.status === 'ok') {
                    return { ok: true, response };
                }
                return {
                    ok: false,
                    response,
                    message: typeof response?.message === 'string'
                        ? response.message
                        : `Sidecar rejected ${payload.op}.`,
                    code: typeof response?.diagnostic?.code === 'string'
                        ? response.diagnostic.code
                        : undefined,
                    stderr: stderr.trim() || undefined
                };
            } catch {
                return {
                    ok: false,
                    message: `Sidecar returned invalid JSON while handling ${payload.op}.`,
                    stderr: stderr.trim() || undefined
                };
            }
        } catch (error) {
            return {
                ok: false,
                message: error instanceof Error ? error.message : `Unable to start sidecar for ${payload.op}.`
            };
        }
    }
}
