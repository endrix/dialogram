import { Action as ProtocolAction } from '@eclipse-glsp/protocol';
import { ActionDispatcher, Command, ModelState, OperationHandler } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { URI } from 'vscode-uri';

export type DiscoveredClaudeAgentProfile = {
    name: string;
    description?: string;
    path: string;
    ignoredFields?: string[];
    warnings?: string[];
};

export namespace WorkflowRequestClaudeAgentsOperation {
    export const KIND = 'dialogram.requestClaudeAgents';

    export interface Operation extends ProtocolAction {
        kind: typeof KIND;
        elementId: string;
    }

    export function is(action: unknown): action is Operation {
        return !!action && typeof action === 'object' && (action as any).kind === KIND;
    }
}

export namespace WorkflowShowClaudeAgentsAction {
    export const KIND = 'dialogram.showClaudeAgents';

    export interface Action extends ProtocolAction {
        kind: typeof KIND;
        elementId: string;
        agents: DiscoveredClaudeAgentProfile[];
    }

    export function create(options: Omit<Action, 'kind'>): Action {
        return { kind: KIND, ...options };
    }
}

class WorkflowRequestClaudeAgentsCommand implements Command {
    constructor(
        protected readonly handler: WorkflowRequestClaudeAgentsOperationHandler,
        protected readonly operation: WorkflowRequestClaudeAgentsOperation.Operation
    ) {}

    async execute(): Promise<void> {
        await this.handler.executeLogic(this.operation);
    }

    undo(): void {}
    redo(): void {}
}

@injectable()
export class WorkflowRequestClaudeAgentsOperationHandler extends OperationHandler {
    readonly operationType = WorkflowRequestClaudeAgentsOperation.KIND;

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(ActionDispatcher)
    protected readonly actionDispatcher!: ActionDispatcher;

    createCommand(operation: ProtocolAction): Command | undefined {
        if (!WorkflowRequestClaudeAgentsOperation.is(operation)) {
            return undefined;
        }
        return new WorkflowRequestClaudeAgentsCommand(this, operation);
    }

    async executeLogic(operation: WorkflowRequestClaudeAgentsOperation.Operation): Promise<void> {
        const sourceUri = this.modelState.sourceUri;
        if (!sourceUri) {
            return;
        }
        const runtimeRoot = path.dirname(URI.parse(sourceUri).fsPath);
        const roots = this.agentRoots(runtimeRoot);
        const agents = await this.discoverClaudeAgents(roots);
        this.actionDispatcher.dispatch(
            WorkflowShowClaudeAgentsAction.create({
                elementId: operation.elementId,
                agents
            }) as any
        );
    }

    protected agentRoots(runtimeRoot: string): string[] {
        const explicit = String(process.env.WF_CLAUDE_AGENTS_ROOT ?? '').trim();
        const roots = [
            explicit,
            path.join(runtimeRoot, '.claude', 'agents'),
            path.join(process.cwd(), '.claude', 'agents'),
            path.join(os.homedir(), '.claude', 'agents'),
        ].filter(Boolean);
        const seen = new Set<string>();
        const unique: string[] = [];
        for (const root of roots) {
            const resolved = path.resolve(root);
            if (seen.has(resolved)) {
                continue;
            }
            seen.add(resolved);
            unique.push(resolved);
        }
        return unique;
    }

    protected async discoverClaudeAgents(roots: string[]): Promise<DiscoveredClaudeAgentProfile[]> {
        const out = new Map<string, DiscoveredClaudeAgentProfile>();
        for (const root of roots) {
            let entries: import('node:fs').Dirent[] = [];
            try {
                entries = await fs.readdir(root, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                if (!entry.isFile()) continue;
                if (!entry.name.endsWith('.md')) continue;
                const name = entry.name.replace(/\.md$/i, '').trim();
                if (!name) continue;
                if (out.has(name)) continue;
                const profilePath = path.join(root, entry.name);
                const raw = await fs.readFile(profilePath, 'utf-8');
                const meta = this.parseFrontmatter(raw);
                const desc = this.extractDescription(raw);
                const warnings = this.compatWarnings(meta);
                const ignoredFields = this.ignoredFields(meta);
                out.set(name, {
                    name,
                    description: desc,
                    path: profilePath,
                    ignoredFields,
                    warnings,
                });
            }
        }
        return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    protected parseFrontmatter(text: string): Record<string, unknown> {
        if (!text.startsWith('---\n')) return {};
        const end = text.indexOf('\n---\n', 4);
        if (end < 0) return {};
        const header = text.slice(4, end);
        const meta: Record<string, unknown> = {};
        for (const line of header.split(/\r?\n/)) {
            const s = line.trim();
            if (!s || s.startsWith('#') || !s.includes(':')) continue;
            const [k, v] = s.split(':', 2);
            meta[k.trim()] = v.trim().replace(/^['"]|['"]$/g, '');
        }
        return meta;
    }

    protected extractDescription(text: string): string | undefined {
        const lines = text.split(/\r?\n/);
        let i = 0;
        if (lines[0] === '---') {
            i = 1;
            while (i < lines.length && lines[i] !== '---') i += 1;
            if (i < lines.length) i += 1;
        }
        for (; i < lines.length; i += 1) {
            const s = lines[i].trim();
            if (!s || s.startsWith('#')) continue;
            return s.length > 180 ? `${s.slice(0, 177)}...` : s;
        }
        return undefined;
    }

    protected compatWarnings(meta: Record<string, unknown>): string[] {
        const warnings: string[] = [];
        const ignored = [
            'tools', 'disallowedTools', 'permissionMode', 'maxTurns',
            'mcpServers', 'hooks', 'memory', 'background', 'effort', 'isolation'
        ];
        for (const key of ignored) {
            if (key in meta) warnings.push(`field '${key}' is ignored in compatibility mode`);
        }
        if ('model' in meta) {
            warnings.push("field 'model' is ignored; the runtime keeps current model/provider selection");
        }
        return warnings;
    }

    protected ignoredFields(meta: Record<string, unknown>): string[] {
        const ignored = [
            'tools', 'disallowedTools', 'permissionMode', 'maxTurns',
            'mcpServers', 'hooks', 'memory', 'background', 'effort', 'isolation',
            'model'
        ];
        return ignored.filter((key) => key in meta);
    }
}

export const __testables = {
    parseFrontmatter: (handler: WorkflowRequestClaudeAgentsOperationHandler, text: string) =>
        handler['parseFrontmatter'](text),
    extractDescription: (handler: WorkflowRequestClaudeAgentsOperationHandler, text: string) =>
        handler['extractDescription'](text),
    compatWarnings: (handler: WorkflowRequestClaudeAgentsOperationHandler, meta: Record<string, unknown>) =>
        handler['compatWarnings'](meta),
    ignoredFields: (handler: WorkflowRequestClaudeAgentsOperationHandler, meta: Record<string, unknown>) =>
        handler['ignoredFields'](meta),
    agentRoots: (handler: WorkflowRequestClaudeAgentsOperationHandler, runtimeRoot: string) =>
        handler['agentRoots'](runtimeRoot),
};
