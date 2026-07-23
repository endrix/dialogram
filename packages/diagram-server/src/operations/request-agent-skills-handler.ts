import { Action as ProtocolAction } from '@eclipse-glsp/protocol';
import { ActionDispatcher, Command, ModelState, OperationHandler } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';
import { URI } from 'vscode-uri';

export type DiscoveredAgentSkill = {
    name: string;
    description?: string;
    root: string;
    skillDir: string;
    skillMdPath: string;
    hasSkillMd: boolean;
    hooks: string[];
    declaredHooks?: {
        pre?: string;
        post?: string;
    };
    missingDeclaredHooks?: string[];
    warnings?: string[];
};

export namespace WorkflowRequestAgentSkillsOperation {
    export const KIND = 'dialogram.requestAgentSkills';

    export type RootsMode = 'all' | 'project';

    export interface Operation extends ProtocolAction {
        kind: typeof KIND;
        elementId: string;
        rootsMode?: RootsMode;
    }

    export function is(action: unknown): action is Operation {
        return !!action && typeof action === 'object' && (action as any).kind === KIND;
    }
}

export namespace WorkflowShowAgentSkillsAction {
    export const KIND = 'dialogram.showAgentSkills';

    export interface Action extends ProtocolAction {
        kind: typeof KIND;
        elementId: string;
        skills: DiscoveredAgentSkill[];
    }

    export function create(options: Omit<Action, 'kind'>): Action {
        return { kind: KIND, ...options };
    }
}

function collectAncestorSkillRoots(runtimeRoot: string): string[] {
    const roots: string[] = [];
    let current = path.resolve(runtimeRoot);
    while (true) {
        roots.push(path.join(current, '.wf', 'skills'));
        roots.push(path.join(current, '.claude', 'skills'));
        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }
    return roots;
}

class WorkflowRequestAgentSkillsCommand implements Command {
    constructor(
        protected readonly handler: WorkflowRequestAgentSkillsOperationHandler,
        protected readonly operation: WorkflowRequestAgentSkillsOperation.Operation
    ) {}

    async execute(): Promise<void> {
        await this.handler.executeLogic(this.operation);
    }

    undo(): void {}
    redo(): void {}
}

@injectable()
export class WorkflowRequestAgentSkillsOperationHandler extends OperationHandler {
    readonly operationType = WorkflowRequestAgentSkillsOperation.KIND;

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(ActionDispatcher)
    protected readonly actionDispatcher!: ActionDispatcher;

    createCommand(operation: ProtocolAction): Command | undefined {
        if (!WorkflowRequestAgentSkillsOperation.is(operation)) {
            return undefined;
        }
        return new WorkflowRequestAgentSkillsCommand(this, operation);
    }

    async executeLogic(operation: WorkflowRequestAgentSkillsOperation.Operation): Promise<void> {
        const sourceUri = this.modelState.sourceUri;
        if (!sourceUri) {
            return;
        }
        const runtimeRoot = path.dirname(URI.parse(sourceUri).fsPath);
        const roots = this.skillRoots(runtimeRoot, operation.rootsMode ?? 'all');
        const skills = await this.discoverSkills(roots);
        this.actionDispatcher.dispatch(
            WorkflowShowAgentSkillsAction.create({
                elementId: operation.elementId,
                skills
            }) as any
        );
    }

    protected skillRoots(runtimeRoot: string, mode: WorkflowRequestAgentSkillsOperation.RootsMode): string[] {
        const cwd = process.cwd();
        const home = os.homedir();
        const explicit = String(process.env.WF_SKILLS_ROOT ?? '').trim();
        const projectRoots = [
            explicit,
            ...collectAncestorSkillRoots(runtimeRoot)
        ].filter(Boolean);
        const extraRoots = mode === 'all'
            ? [
                path.join(cwd, '.wf', 'skills'),
                path.join(cwd, '.claude', 'skills'),
                path.join(home, '.claude', 'skills')
            ]
            : [];
        const roots = [...projectRoots, ...extraRoots];
        const seen = new Set<string>();
        const unique: string[] = [];
        for (const root of roots) {
            const normalized = path.resolve(root);
            if (seen.has(normalized)) continue;
            seen.add(normalized);
            unique.push(normalized);
        }
        return unique;
    }

    protected async discoverSkills(roots: string[]): Promise<DiscoveredAgentSkill[]> {
        const found = new Map<string, DiscoveredAgentSkill>();
        for (const root of roots) {
            let entries: Dirent[] = [];
            try {
                entries = await fs.readdir(root, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const name = entry.name;
                if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) continue;
                if (found.has(name)) continue;
                const skillDir = path.join(root, name);
                const skillMdPath = path.join(skillDir, 'SKILL.md');
                const hasSkillMd = await this.fileExists(skillMdPath);
                const hooks = await this.discoverHooks(path.join(skillDir, 'scripts'));
                let declaredHooks: { pre?: string; post?: string } | undefined;
                let description: string | undefined;
                const warnings: string[] = [];
                if (hasSkillMd) {
                    try {
                        const raw = await fs.readFile(skillMdPath, 'utf-8');
                        declaredHooks = this.parseDeclaredHooks(raw);
                        description = this.extractSkillDescription(raw);
                    } catch (err) {
                        warnings.push(`Failed to parse SKILL.md: ${String(err)}`);
                    }
                }
                const missingDeclaredHooks: string[] = [];
                if (declaredHooks?.pre && !hooks.includes(declaredHooks.pre)) {
                    missingDeclaredHooks.push(declaredHooks.pre);
                }
                if (declaredHooks?.post && !hooks.includes(declaredHooks.post)) {
                    missingDeclaredHooks.push(declaredHooks.post);
                }
                found.set(name, {
                    name,
                    root,
                    skillDir,
                    skillMdPath,
                    hasSkillMd,
                    description,
                    hooks,
                    declaredHooks,
                    missingDeclaredHooks,
                    warnings,
                });
            }
        }
        return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    protected parseDeclaredHooks(skillMdText: string): { pre?: string; post?: string } | undefined {
        if (!skillMdText.startsWith('---\n')) {
            return undefined;
        }
        const end = skillMdText.indexOf('\n---\n', 4);
        if (end < 0) {
            return undefined;
        }
        const header = skillMdText.slice(4, end);
        const lines = header.split(/\r?\n/);
        let inHooks = false;
        const result: { pre?: string; post?: string } = {};
        for (const raw of lines) {
            const line = raw.replace(/\t/g, '    ');
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) {
                continue;
            }
            if (trimmed === 'hooks:' || trimmed === 'hooks') {
                inHooks = true;
                continue;
            }
            if (!inHooks) {
                continue;
            }
            if (!line.startsWith(' ')) {
                inHooks = false;
                continue;
            }
            const match = trimmed.match(/^(pre|post)\s*:\s*(.+)$/i);
            if (!match) {
                continue;
            }
            const key = match[1].toLowerCase() as 'pre' | 'post';
            const value = String(match[2]).trim().replace(/^['"]|['"]$/g, '');
            if (value) {
                result[key] = value;
            }
        }
        return Object.keys(result).length > 0 ? result : undefined;
    }

    protected extractSkillDescription(skillMdText: string): string | undefined {
        const lines = skillMdText.split(/\r?\n/);
        let i = 0;
        if (lines[0] === '---') {
            i = 1;
            while (i < lines.length && lines[i] !== '---') {
                i += 1;
            }
            if (i < lines.length && lines[i] === '---') {
                i += 1;
            }
        }

        for (; i < lines.length; i += 1) {
            const line = lines[i].trim();
            if (!line) continue;
            if (line.startsWith('#')) continue;
            return line.length > 180 ? `${line.slice(0, 177)}...` : line;
        }
        return undefined;
    }

    protected async fileExists(filePath: string): Promise<boolean> {
        try {
            const st = await fs.stat(filePath);
            return st.isFile();
        } catch {
            return false;
        }
    }

    protected async discoverHooks(scriptsDir: string): Promise<string[]> {
        let entries: Dirent[] = [];
        try {
            entries = await fs.readdir(scriptsDir, { withFileTypes: true });
        } catch {
            return [];
        }
        const hooks = new Set<string>();
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            if (!(entry.name.endsWith('.py') || entry.name.endsWith('.sh'))) continue;
            const hook = entry.name.replace(/\.(py|sh)$/i, '').trim();
            if (!hook) continue;
            hooks.add(hook);
        }
        return [...hooks].sort((a, b) => a.localeCompare(b));
    }
}

export const __testables = {
    collectAncestorSkillRoots,
    skillRoots: (
        handler: WorkflowRequestAgentSkillsOperationHandler,
        runtimeRoot: string,
        mode: WorkflowRequestAgentSkillsOperation.RootsMode
    ) => handler['skillRoots'](runtimeRoot, mode),
    parseDeclaredHooks: (handler: WorkflowRequestAgentSkillsOperationHandler, text: string) =>
        handler['parseDeclaredHooks'](text),
    extractSkillDescription: (handler: WorkflowRequestAgentSkillsOperationHandler, text: string) =>
        handler['extractSkillDescription'](text)
};
