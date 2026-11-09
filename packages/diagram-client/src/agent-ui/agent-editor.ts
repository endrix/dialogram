/**
 * The `@agent` annotation's editor: prompt, agent preset and skill, MCP and LSP
 * servers, output validators, and the model and backend controls.
 */
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import type { PropertyElement } from '../property-model';
import { VscodeUi } from '../vscode-ui';
import { clientBehavior } from '../profile';
import type { AnnotationEditor, AnnotationEditorContext } from '../annotation-editor';
import {
    type WorkflowAgentSkill,
    type WorkflowClaudeAgentProfile,
    WorkflowShowAgentSkillsActionHandler,
    WorkflowShowClaudeAgentsActionHandler,
    WorkflowRequestAgentSkillsOperation,
    WorkflowRequestClaudeAgentsOperation
} from '../editing-action-handlers';
import { normalizeMultilineStringForEditor, serializeWfStringListExpr, stripQuotesIfStringLiteral, toWfStringLiteral, tryParseWfStringListExpr } from './literals';

export class AgentAnnotationEditor implements AnnotationEditor {
    readonly annotationName = 'agent';
    readonly reservedArgs = [
        // Identity / model
        'prompt', 'claudeAgent', 'skill', 'model', 'provider', 'endpoint',
        'timeoutMs', 'contextBudget', 'stateful',
        // Backend / runtime controls (dropdowns above)
        'truncationStrategy', 'fireableWithoutInput', 'transport', 'connector', 'mode', 'cliToolsMode', 'reasoningEffort',
        // Sub-block toggles
        'useClaudeAgent', 'useSkill', 'usePrompt', 'useSkillHooks',
        // MCP block
        'useMcp', 'mcpServers', 'mcpServerConfigs', 'mcpTransport',
        // LSP block (+ shorthand scalars)
        'useLsp', 'lspServers', 'lspServerConfigs', 'lspCommand', 'lspArgs',
        'lspLanguageId', 'lspExtraFlags', 'lspPort', 'lspSeverityThreshold', 'lspMaxRepairAttempts',
        // Output validators editor
        'outputValidators'
    ];
    /** GUI-only display keys that are NOT valid decorator parameters. */
    readonly guiOnlyArgs = ['useMcp', 'useLsp', 'mcpServerConfigs', 'lspServerConfigs'];
    readonly mergeArgUpdates = true;
    readonly quickAdd = {
        label: 'Add @agent',
        title: 'Add or update @agent annotation',
        annotationText: '@agent(\n    prompt="Transform inputs to outputs",\n    model="openai/gpt-5-mini"\n)'
    };

    private skillRootsMode: 'all' | 'project' = 'all';

    /** The editor's arguments first, in a fixed order, then the rest; GUI-only keys never. */
    formatAnnotation(argsMap: ReadonlyMap<string, string>, pairs: ReadonlyArray<readonly [string, string]>): string {
        const guiOnlyKeys = new Set(this.guiOnlyArgs);

        const prompt = argsMap.get('prompt')?.trim();
        const model = argsMap.get('model')?.trim();
        const provider = argsMap.get('provider')?.trim();
        const endpoint = argsMap.get('endpoint')?.trim();
        const timeoutMs = argsMap.get('timeoutMs')?.trim();
        const contextBudget = argsMap.get('contextBudget')?.trim();
        const stateful = argsMap.get('stateful')?.trim();
        const claudeAgent = argsMap.get('claudeAgent')?.trim();
        const useClaudeAgent = argsMap.get('useClaudeAgent')?.trim();
        const skill = argsMap.get('skill')?.trim();
        const useSkill = argsMap.get('useSkill')?.trim();
        const usePrompt = argsMap.get('usePrompt')?.trim();
        const useSkillHooks = argsMap.get('useSkillHooks')?.trim();
        const truncationStrategy = argsMap.get('truncationStrategy')?.trim();
        const transport = argsMap.get('transport')?.trim();
        const connector = argsMap.get('connector')?.trim();
        const mode = argsMap.get('mode')?.trim();
        const cliToolsMode = argsMap.get('cliToolsMode')?.trim();
        const reasoningEffort = argsMap.get('reasoningEffort')?.trim();
        const fireableWithoutInput = argsMap.get('fireableWithoutInput')?.trim();

        const ordered: Array<[string, string]> = [];
        if (prompt) ordered.push(['prompt', prompt]);
        if (claudeAgent) ordered.push(['claudeAgent', claudeAgent]);
        if (skill) ordered.push(['skill', skill]);
        if (model) ordered.push(['model', model]);
        if (provider) ordered.push(['provider', provider]);
        if (endpoint) ordered.push(['endpoint', endpoint]);
        if (timeoutMs) ordered.push(['timeoutMs', timeoutMs]);
        if (contextBudget) ordered.push(['contextBudget', contextBudget]);
        if (stateful) ordered.push(['stateful', stateful]);
        if (useClaudeAgent) ordered.push(['useClaudeAgent', useClaudeAgent]);
        if (useSkill) ordered.push(['useSkill', useSkill]);
        if (usePrompt) ordered.push(['usePrompt', usePrompt]);
        if (useSkillHooks) ordered.push(['useSkillHooks', useSkillHooks]);
        if (truncationStrategy) ordered.push(['truncationStrategy', truncationStrategy]);
        if (transport) ordered.push(['transport', transport]);
        if (connector) ordered.push(['connector', connector]);
        if (mode) ordered.push(['mode', mode]);
        if (cliToolsMode) ordered.push(['cliToolsMode', cliToolsMode]);
        if (reasoningEffort) ordered.push(['reasoningEffort', reasoningEffort]);
        if (fireableWithoutInput) ordered.push(['fireableWithoutInput', fireableWithoutInput]);

        for (const [k, v] of pairs) {
            if (['prompt', 'claudeAgent', 'skill', 'model', 'provider', 'endpoint', 'timeoutMs', 'contextBudget', 'stateful', 'useClaudeAgent', 'useSkill', 'usePrompt', 'useSkillHooks', 'truncationStrategy', 'transport', 'connector', 'mode', 'cliToolsMode', 'reasoningEffort', 'fireableWithoutInput'].includes(k) || guiOnlyKeys.has(k)) continue;
            ordered.push([k, v]);
        }

        return ordered.length === 0
            ? '@agent'
            : `@agent(\n${ordered.map(([k, v]) => `    ${k}=${v}`).join(',\n')}\n)`;
    }

    render(context: AnnotationEditorContext): void {
        const { elementId, args: argsMap, body, requestDiscovery: requestAgentDiscovery } = context;

        const knownSkills = WorkflowShowAgentSkillsActionHandler.getSkillsForElement(elementId);
        const knownClaudeAgents = WorkflowShowClaudeAgentsActionHandler.getAgentsForElement(elementId);
        if (requestAgentDiscovery) {
            void context.dispatcher.dispatch(
                WorkflowRequestAgentSkillsOperation.create({
                    elementId,
                    rootsMode: this.skillRootsMode
                })
            );
        }
        void context.dispatcher.dispatch(
            WorkflowRequestClaudeAgentsOperation.create({
                elementId,
            })
        );

        // Gather ports for IntelliSense
        const node: PropertyElement | undefined = context.root?.index?.getById(elementId);
        const children = node?.children || [];
        const ports = children.filter((c) => c.type?.startsWith('port'));
        const inputPorts = ports.filter((p) => p.args?.[WorkflowDiagramMetadata.IS_INPUT_PORT] === true).map((p) => (p.args?.[WorkflowDiagramMetadata.PORT_NAME] as string | undefined) || 'unnamed');
        const outputPorts = ports.filter((p) => p.args?.[WorkflowDiagramMetadata.IS_INPUT_PORT] === false).map((p) => (p.args?.[WorkflowDiagramMetadata.PORT_NAME] as string | undefined) || 'unnamed');

        // Discovery mode is fixed to all roots for now.
        this.skillRootsMode = 'all';

        const createEnabledToggle = (initialChecked: boolean): { wrap: HTMLLabelElement; input: HTMLInputElement } => {
            const wrap = document.createElement('label');
            wrap.className = 'agent-enabled-toggle';

            const text = document.createElement('span');
            text.className = 'agent-enabled-text';
            text.textContent = 'Enabled';

            const switchWrap = document.createElement('span');
            switchWrap.className = 'agent-enabled-switch';

            const input = document.createElement('input');
            input.type = 'checkbox';
            input.className = 'agent-enabled-input';
            input.checked = initialChecked;

            const slider = document.createElement('span');
            slider.className = 'agent-enabled-slider';

            const knob = document.createElement('span');
            knob.className = 'agent-enabled-knob';

            slider.appendChild(knob);
            switchWrap.appendChild(input);
            switchWrap.appendChild(slider);
            wrap.appendChild(text);
            wrap.appendChild(switchWrap);

            return { wrap, input };
        };

        // 0. Agent preset profile section
        const claudeRow = document.createElement('div');
        claudeRow.className = 'agent-skill-block';
        const claudeHead = document.createElement('div');
        claudeHead.className = 'agent-section-head';
        const claudeLabel = document.createElement('div');
        claudeLabel.textContent = 'Agent Preset';
        claudeLabel.className = 'agent-skill-label';
        const claudeRaw = (argsMap.get('useClaudeAgent') ?? '').trim().toLowerCase();
        let claudeActive = claudeRaw ? claudeRaw === 'true' : false;
        const claudeEnabledToggle = createEnabledToggle(claudeActive);
        claudeHead.appendChild(claudeLabel);
        claudeHead.appendChild(claudeEnabledToggle.wrap);

        const claudeContent = document.createElement('div');
        claudeContent.className = 'agent-section-content';

        const claudeInput = document.createElement('input');
        claudeInput.className = 'annotation-input';
        claudeInput.placeholder = 'e.g. code-reviewer';
        claudeInput.value = stripQuotesIfStringLiteral(argsMap.get('claudeAgent') ?? '');
        claudeInput.addEventListener('input', () => {
            const val = claudeInput.value.trim();
            if (val) argsMap.set('claudeAgent', toWfStringLiteral(val));
            else argsMap.delete('claudeAgent');
        });

        const claudeHint = document.createElement('div');
        claudeHint.className = 'agent-skill-hint';
        claudeHint.textContent = 'Resolved from .claude/agents/<name>.md';

        const claudeActions = document.createElement('div');
        claudeActions.className = 'agent-skill-actions';

        const pickClaudeBtn = document.createElement('button');
        pickClaudeBtn.type = 'button';
        pickClaudeBtn.className = 'mini-btn';
        pickClaudeBtn.textContent = 'Pick Preset';
        pickClaudeBtn.addEventListener('click', async () => {
            const latest = WorkflowShowClaudeAgentsActionHandler.getAgentsForElement(elementId);
            if (latest.length === 0) {
                VscodeUi.instance.infoMessage('No agent presets found in discovery roots.');
                return;
            }
            const items = latest.map((a) => ({
                id: a.name,
                label: a.name,
                description: a.description || 'No description',
                detail: a.path,
            }));
            const picked = await VscodeUi.instance.quickPick({
                items,
                placeHolder: 'Select an agent preset'
            });
            if (!picked) return;
            claudeInput.value = picked;
            argsMap.set('claudeAgent', toWfStringLiteral(picked));
            const latestMeta = latest.find((a) => a.name === picked);
            updateClaudeStatus(latestMeta);
        });

        const openClaudeBtn = document.createElement('button');
        openClaudeBtn.type = 'button';
        openClaudeBtn.className = 'mini-btn';
        openClaudeBtn.textContent = 'Open Preset';
        openClaudeBtn.addEventListener('click', async () => {
            const current = stripQuotesIfStringLiteral(argsMap.get('claudeAgent') ?? '').trim();
            if (!current) {
                VscodeUi.instance.infoMessage('Set an agent preset name first.');
                return;
            }
            const latest = WorkflowShowClaudeAgentsActionHandler.getAgentsForElement(elementId);
            const meta = latest.find((a) => a.name === current);
            if (!meta) {
                VscodeUi.instance.errorMessage(`Agent preset '${current}' was not found.`);
                return;
            }
            const openResult = await VscodeUi.instance.executeCommand<any>('vscode.open', [meta.path]);
            if (openResult && typeof openResult === 'object' && 'error' in openResult) {
                VscodeUi.instance.errorMessage(`Failed to open claude agent: ${String((openResult as any).error)}`);
            }
        });

        const claudeStatus = document.createElement('div');
        claudeStatus.className = 'agent-skill-status';
        const claudeIgnoredRow = document.createElement('div');
        claudeIgnoredRow.className = 'agent-skill-chips';
        const claudeWarnings = document.createElement('div');
        claudeWarnings.className = 'agent-skill-warning';
        claudeWarnings.style.display = 'none';

        const addClaudeChip = (label: string, tone: 'warn' | 'info'): void => {
            const chip = document.createElement('span');
            chip.className = `agent-chip ${tone}`;
            chip.textContent = tone === 'warn' ? `IGNORED ${label}` : `INFO ${label}`;
            claudeIgnoredRow.appendChild(chip);
        };

        const renderClaudeWarnings = (meta: WorkflowClaudeAgentProfile | undefined): void => {
            if (!meta || (meta.warnings?.length ?? 0) === 0) {
                claudeWarnings.style.display = 'none';
                claudeWarnings.textContent = '';
                return;
            }
            claudeWarnings.style.display = 'block';
            claudeWarnings.textContent = `Warning: ${(meta.warnings ?? []).join(' | ')}`;
        };

        const renderClaudeIgnoredFields = (meta: WorkflowClaudeAgentProfile | undefined): void => {
            claudeIgnoredRow.innerHTML = '';
            if (!meta) {
                claudeIgnoredRow.style.display = 'none';
                return;
            }
            const ignored = meta.ignoredFields ?? [];
            if (ignored.length === 0) {
                claudeIgnoredRow.style.display = 'none';
                return;
            }
            claudeIgnoredRow.style.display = 'flex';
            for (const field of ignored) {
                addClaudeChip(field, 'warn');
            }
        };

        const updateClaudeStatus = (meta: WorkflowClaudeAgentProfile | undefined): void => {
            const current = stripQuotesIfStringLiteral(argsMap.get('claudeAgent') ?? '').trim();
            if (!current) {
                claudeStatus.textContent = 'No agent preset selected.';
                renderClaudeIgnoredFields(undefined);
                renderClaudeWarnings(undefined);
                return;
            }
            if (!meta) {
                claudeStatus.textContent = `Agent preset '${current}' not discovered.`;
                renderClaudeIgnoredFields(undefined);
                renderClaudeWarnings(undefined);
                return;
            }
            claudeStatus.textContent = `${meta.description || 'No description.'}`;
            renderClaudeIgnoredFields(meta);
            renderClaudeWarnings(meta);
        };

        const syncClaudeActive = (): void => {
            argsMap.set('useClaudeAgent', claudeActive ? 'true' : 'false');
            claudeEnabledToggle.input.checked = claudeActive;
            claudeInput.disabled = !claudeActive;
            pickClaudeBtn.disabled = !claudeActive;
            openClaudeBtn.disabled = !claudeActive;
            claudeContent.style.display = claudeActive ? '' : 'none';
            claudeRow.classList.toggle('disabled', !claudeActive);
            if (!claudeActive) {
                claudeStatus.textContent = 'Agent preset is deactivated.';
                claudeIgnoredRow.style.display = 'none';
                claudeWarnings.style.display = 'none';
            } else {
                const selected = stripQuotesIfStringLiteral(argsMap.get('claudeAgent') ?? '').trim();
                const latest = WorkflowShowClaudeAgentsActionHandler.getAgentsForElement(elementId);
                updateClaudeStatus(latest.find((a) => a.name === selected));
            }
        };
        claudeEnabledToggle.input.addEventListener('change', () => {
            claudeActive = claudeEnabledToggle.input.checked;
            syncClaudeActive();
        });

        claudeActions.appendChild(pickClaudeBtn);
        claudeActions.appendChild(openClaudeBtn);
        claudeRow.appendChild(claudeHead);
        claudeContent.appendChild(claudeInput);
        claudeContent.appendChild(claudeHint);
        claudeContent.appendChild(claudeActions);
        claudeContent.appendChild(claudeStatus);
        claudeContent.appendChild(claudeIgnoredRow);
        claudeContent.appendChild(claudeWarnings);
        claudeRow.appendChild(claudeContent);

        const selectedClaudeName = stripQuotesIfStringLiteral(argsMap.get('claudeAgent') ?? '').trim();
        updateClaudeStatus(knownClaudeAgents.find((a) => a.name === selectedClaudeName));
        syncClaudeActive();

        // 1. Skill section
        const skillRow = document.createElement('div');
        skillRow.className = 'agent-skill-block';
        const skillHead = document.createElement('div');
        skillHead.className = 'agent-section-head';
        const skillLabel = document.createElement('div');
        skillLabel.textContent = 'Skill';
        skillLabel.className = 'agent-skill-label';
        const skillRaw = (argsMap.get('useSkill') ?? '').trim().toLowerCase();
        let skillActive = skillRaw ? skillRaw === 'true' : !!argsMap.get('skill');
        const skillEnabledToggle = createEnabledToggle(skillActive);
        skillHead.appendChild(skillLabel);
        skillHead.appendChild(skillEnabledToggle.wrap);

        const skillContent = document.createElement('div');
        skillContent.className = 'agent-section-content';
        const skillInput = document.createElement('input');
        skillInput.className = 'annotation-input';
        skillInput.placeholder = 'e.g. writer';
        skillInput.style.width = '100%';
        skillInput.style.boxSizing = 'border-box';
        skillInput.value = stripQuotesIfStringLiteral(argsMap.get('skill') ?? '');
        skillInput.addEventListener('input', () => {
            const val = skillInput.value.trim();
            if (val) argsMap.set('skill', toWfStringLiteral(val));
            else argsMap.delete('skill');
        });

        const skillHint = document.createElement('div');
        skillHint.className = 'agent-skill-hint';
        skillHint.textContent = 'Resolved at runtime from .wf/skills/<name>/SKILL.md';

        skillRow.appendChild(skillHead);
        skillRow.appendChild(skillInput);
        skillRow.appendChild(skillHint);

        const skillActions = document.createElement('div');
        skillActions.className = 'agent-skill-actions';

        const skillWarn = document.createElement('div');
        skillWarn.className = 'agent-skill-warning';
        skillWarn.style.display = 'none';

        const renderSkillWarning = (meta: WorkflowAgentSkill | undefined): void => {
            const warningText = meta ? skillWarningSummary(meta) : '';
            if (!warningText) {
                skillWarn.style.display = 'none';
                skillWarn.textContent = '';
                return;
            }
            skillWarn.style.display = 'block';
            skillWarn.textContent = `Warning: ${warningText}`;
        };

        const chipRow = document.createElement('div');
        chipRow.className = 'agent-skill-chips';

        const addChip = (label: string, tone: 'ok' | 'warn' | 'error' | 'info'): void => {
            const chip = document.createElement('span');
            chip.className = `agent-chip ${tone}`;
            if (tone === 'ok') {
                chip.textContent = `OK ${label}`;
            } else if (tone === 'warn') {
                chip.textContent = `WARN ${label}`;
            } else if (tone === 'error') {
                chip.textContent = `ERR ${label}`;
            } else {
                chip.textContent = `INFO ${label}`;
            }
            chipRow.appendChild(chip);
        };

        const renderSkillChips = (meta: WorkflowAgentSkill | undefined): void => {
            chipRow.innerHTML = '';
            const currentSkill = stripQuotesIfStringLiteral(argsMap.get('skill') ?? '').trim();
            if (!currentSkill) {
                chipRow.style.display = 'none';
                return;
            }
            chipRow.style.display = 'flex';
            if (!meta) {
                addChip('Skill not discovered', 'error');
                return;
            }
            if (!meta.hasSkillMd) {
                addChip('SKILL.md missing', 'error');
            }
            const missingCount = meta.missingDeclaredHooks?.length ?? 0;
            if (missingCount > 0) {
                addChip(`${missingCount} missing script${missingCount > 1 ? 's' : ''}`, 'warn');
            }
            const warningCount = meta.warnings?.length ?? 0;
            if (warningCount > 0) {
                addChip(`${warningCount} parser warning${warningCount > 1 ? 's' : ''}`, 'warn');
            }
            addChip(`${meta.hooks.length} script hook${meta.hooks.length !== 1 ? 's' : ''}`, 'info');
            if (meta.hasSkillMd && missingCount === 0 && warningCount === 0) {
                addChip('Skill ready', 'ok');
            }
        };

        const updateSkillStatus = (meta: WorkflowAgentSkill | undefined): void => {
            const currentSkill = stripQuotesIfStringLiteral(argsMap.get('skill') ?? '').trim();
            if (meta) {
                skillStatus.textContent = describeSkillStatus(meta);
            } else {
                skillStatus.textContent = currentSkill
                    ? `Skill '${currentSkill}' not discovered yet.`
                    : 'No skill selected.';
            }
        };

        const pickSkillBtn = document.createElement('button');
        pickSkillBtn.type = 'button';
        pickSkillBtn.className = 'mini-btn';
        pickSkillBtn.textContent = 'Pick Skill';
        pickSkillBtn.addEventListener('click', async () => {
            const latest = WorkflowShowAgentSkillsActionHandler.getSkillsForElement(elementId);
            if (latest.length === 0) {
                VscodeUi.instance.infoMessage('No discovered skills found in .wf/.claude roots.');
                return;
            }
            const items = latest.map((s) => ({
                id: s.name,
                label: s.name,
                description: (s.description && s.description.trim() !== '')
                    ? s.description
                    : (s.hasSkillMd ? 'No description in SKILL.md' : 'missing SKILL.md'),
                detail: `${s.root}${(s.warnings?.length ?? 0) > 0 ? ` | ${s.warnings?.join(' | ')}` : ''}`
            }));
            const picked = await VscodeUi.instance.quickPick({
                items,
                placeHolder: 'Select a skill'
            });
            if (!picked) return;
            skillInput.value = picked;
            argsMap.set('skill', toWfStringLiteral(picked));
            const meta = latest.find((s) => s.name === picked);
            updateSkillStatus(meta);
            renderSkillChips(meta);
            renderSkillWarning(meta);
        });

        const refreshSkillsBtn = document.createElement('button');
        refreshSkillsBtn.type = 'button';
        refreshSkillsBtn.className = 'mini-btn';
        refreshSkillsBtn.textContent = 'Refresh';
        refreshSkillsBtn.addEventListener('click', () => {
            void context.dispatcher.dispatch(
                WorkflowRequestAgentSkillsOperation.create({
                    elementId,
                    rootsMode: this.skillRootsMode
                })
            );
            const currentSkill = stripQuotesIfStringLiteral(argsMap.get('skill') ?? '').trim();
            const latest = WorkflowShowAgentSkillsActionHandler.getSkillsForElement(elementId);
            const meta = latest.find((s) => s.name === currentSkill);
            updateSkillStatus(meta);
            renderSkillChips(meta);
            renderSkillWarning(meta);
        });

        const openSkillBtn = document.createElement('button');
        openSkillBtn.type = 'button';
        openSkillBtn.className = 'mini-btn';
        openSkillBtn.textContent = 'Open Skill';
        openSkillBtn.addEventListener('click', async () => {
            const currentSkill = stripQuotesIfStringLiteral(argsMap.get('skill') ?? '').trim();
            if (!currentSkill) {
                VscodeUi.instance.infoMessage('Set a skill name first.');
                return;
            }
            const latest = WorkflowShowAgentSkillsActionHandler.getSkillsForElement(elementId);
            let meta = latest.find((s) => s.name === currentSkill);
            if (!meta) {
                void context.dispatcher.dispatch(
                    WorkflowRequestAgentSkillsOperation.create({
                        elementId,
                        rootsMode: this.skillRootsMode
                    })
                );
                const refreshed = WorkflowShowAgentSkillsActionHandler.getSkillsForElement(elementId);
                meta = refreshed.find((s) => s.name === currentSkill);
            }
            if (!meta || !meta.skillMdPath) {
                VscodeUi.instance.errorMessage(`Skill '${currentSkill}' was not found.`);
                return;
            }
            // Open the rendered Markdown preview rather than the raw text editor.
            const openResult = await VscodeUi.instance.executeCommand<any>('markdown.showPreview', [meta.skillMdPath]);
            if (openResult && typeof openResult === 'object' && 'error' in openResult) {
                VscodeUi.instance.errorMessage(`Failed to open skill preview: ${String((openResult as any).error)}`);
            }
        });

        skillActions.appendChild(pickSkillBtn);
        skillActions.appendChild(refreshSkillsBtn);
        skillActions.appendChild(openSkillBtn);

        const skillStatus = document.createElement('div');
        skillStatus.className = 'agent-skill-status';
        const selectedSkill = stripQuotesIfStringLiteral(argsMap.get('skill') ?? '').trim();
        const selectedMeta = knownSkills.find((s) => s.name === selectedSkill);
        updateSkillStatus(selectedMeta);
        renderSkillChips(selectedMeta);
        renderSkillWarning(selectedMeta);

        const hooksWrap = document.createElement('label');
        hooksWrap.className = 'agent-toggle';
        const hooksInput = document.createElement('input');
        hooksInput.type = 'checkbox';
        const hooksRaw = (argsMap.get('useSkillHooks') ?? '').trim().toLowerCase();
        hooksInput.checked = hooksRaw ? hooksRaw === 'true' : true;
        argsMap.set('useSkillHooks', hooksInput.checked ? 'true' : 'false');
        hooksInput.addEventListener('change', () => {
            argsMap.set('useSkillHooks', hooksInput.checked ? 'true' : 'false');
        });
        const hooksText = document.createElement('span');
        hooksText.textContent = 'Enable Skill Hooks';
        hooksWrap.appendChild(hooksInput);
        hooksWrap.appendChild(hooksText);

        const syncSkillActive = (): void => {
            argsMap.set('useSkill', skillActive ? 'true' : 'false');
            skillEnabledToggle.input.checked = skillActive;
            skillInput.disabled = !skillActive;
            pickSkillBtn.disabled = !skillActive;
            refreshSkillsBtn.disabled = !skillActive;
            openSkillBtn.disabled = !skillActive;
            hooksInput.disabled = !skillActive;
            skillContent.style.display = skillActive ? '' : 'none';
            skillRow.classList.toggle('disabled', !skillActive);
            if (!skillActive) {
                chipRow.style.display = 'none';
                skillWarn.style.display = 'none';
                skillStatus.textContent = 'Skill is deactivated.';
            } else {
                const currentSkill = stripQuotesIfStringLiteral(argsMap.get('skill') ?? '').trim();
                const latest = WorkflowShowAgentSkillsActionHandler.getSkillsForElement(elementId);
                const meta = latest.find((s) => s.name === currentSkill);
                updateSkillStatus(meta);
                renderSkillChips(meta);
                renderSkillWarning(meta);
            }
        };
        skillEnabledToggle.input.addEventListener('change', () => {
            skillActive = skillEnabledToggle.input.checked;
            syncSkillActive();
        });
        syncSkillActive();

        skillContent.appendChild(skillInput);
        skillContent.appendChild(skillHint);
        skillContent.appendChild(skillActions);
        skillContent.appendChild(hooksWrap);
        skillContent.appendChild(skillStatus);
        skillContent.appendChild(chipRow);
        skillContent.appendChild(skillWarn);
        skillRow.appendChild(skillContent);

        // 2. Prompt Section (Full Width)
        const promptRow = document.createElement('div');
        promptRow.className = 'agent-skill-block agent-prompt-block';

        const promptHeader = document.createElement('div');
        promptHeader.className = 'agent-prompt-header';

        const promptLabel = document.createElement('div');
        promptLabel.innerHTML = 'Prompt <span class="codicon codicon-info" style="cursor:help;opacity:0.6;font-size:12px" title="Use {in.portName} or {out.portName} to reference port data"></span>';
        promptLabel.className = 'agent-prompt-label';

        const promptRaw = (argsMap.get('usePrompt') ?? '').trim().toLowerCase();
        let promptActive = promptRaw ? promptRaw === 'true' : true;
        const promptEnabledToggle = createEnabledToggle(promptActive);

        const popupBtn = document.createElement('button');
        popupBtn.className = 'mini-btn';
        popupBtn.innerHTML = '<span class="codicon codicon-screen-full"></span> Expand Editor';
        popupBtn.style.display = 'flex';
        popupBtn.style.gap = '4px';
        popupBtn.style.alignItems = 'center';

        const promptHeaderRight = document.createElement('div');
        promptHeaderRight.style.display = 'flex';
        promptHeaderRight.style.gap = '8px';
        promptHeaderRight.appendChild(promptEnabledToggle.wrap);

        promptHeader.appendChild(promptLabel);
        promptHeader.appendChild(promptHeaderRight);
        promptRow.appendChild(promptHeader);

        const promptContent = document.createElement('div');
        promptContent.className = 'agent-section-content';

        const promptActions = document.createElement('div');
        promptActions.className = 'agent-skill-actions';
        promptActions.appendChild(popupBtn);
        promptContent.appendChild(promptActions);

        const promptInput = document.createElement('textarea');
        promptInput.className = 'annotation-input annotation-textarea';
        promptInput.rows = 6;
        promptInput.placeholder = 'Transform inputs into outputs...\nWait for { to trigger autocomplete!';
        promptInput.classList.add('agent-prompt-input');

        const updatePromptVal = (val: string) => {
            promptInput.value = val;
            argsMap.set('prompt', toWfStringLiteral(val));
        };

        promptInput.value = normalizeMultilineStringForEditor(
            stripQuotesIfStringLiteral(argsMap.get('prompt') ?? '')
        );
        promptInput.addEventListener('input', () => {
            argsMap.set('prompt', toWfStringLiteral(promptInput.value));
        });

        const syncPromptActive = (): void => {
            argsMap.set('usePrompt', promptActive ? 'true' : 'false');
            promptEnabledToggle.input.checked = promptActive;
            promptInput.disabled = !promptActive;
            popupBtn.disabled = !promptActive;
            promptRow.classList.toggle('disabled', !promptActive);
            promptContent.style.display = promptActive ? '' : 'none';
        };
        promptEnabledToggle.input.addEventListener('change', () => {
            promptActive = promptEnabledToggle.input.checked;
            syncPromptActive();
        });
        syncPromptActive();

        const createAutocomplete = (inputEl: HTMLTextAreaElement, parent: HTMLElement, extraZIndex = 0) => {
            const autocompleteBox = document.createElement('div');
            autocompleteBox.style.position = 'absolute';
            autocompleteBox.style.display = 'none';
            autocompleteBox.style.backgroundColor = 'var(--vscode-editorSuggestWidget-background, #252526)';
            autocompleteBox.style.border = '1px solid var(--vscode-editorSuggestWidget-border, #454545)';
            autocompleteBox.style.borderRadius = '4px';
            autocompleteBox.style.boxShadow = '0 4px 8px rgba(0,0,0,0.4)';
            autocompleteBox.style.zIndex = String(999999 + extraZIndex);
            autocompleteBox.style.maxHeight = '150px';
            autocompleteBox.style.overflowY = 'auto';
            autocompleteBox.style.minWidth = '150px';
            autocompleteBox.style.fontSize = '12px';

            parent.style.position = 'relative';
            parent.appendChild(autocompleteBox);

            inputEl.addEventListener('input', (e) => {
                const val = inputEl.value;
                const cursorPos = inputEl.selectionStart as number;
                const textBefore = val.slice(0, cursorPos);

                const match = textBefore.match(/\{([a-zA-Z0-9_.]*)$/);
                if (match) {
                    const searchStr = match[1].toLowerCase();

                    const suggestions = [
                        ...inputPorts.map((p) => ({ display: `in.${p}`, val: `in.${p}`, kind: 'input' })),
                        ...outputPorts.map((p) => ({ display: `out.${p}`, val: `out.${p}`, kind: 'output' }))
                    ].filter(s => s.display.toLowerCase().includes(searchStr));

                    if (suggestions.length > 0) {
                        autocompleteBox.innerHTML = '';
                        suggestions.forEach((s, idx) => {
                            const item = document.createElement('div');
                            item.style.padding = '4px 8px';
                            item.style.cursor = 'pointer';
                            item.style.display = 'flex';
                            item.style.justifyContent = 'space-between';
                            item.style.borderBottom = idx < suggestions.length - 1 ? '1px solid var(--vscode-editorGroup-border)' : 'none';

                            const nameSpan = document.createElement('span');
                            nameSpan.style.color = 'var(--vscode-symbolIcon-variableForeground)';
                            nameSpan.style.fontWeight = 'bold';
                            nameSpan.textContent = s.display;

                            const kindSpan = document.createElement('span');
                            kindSpan.style.opacity = '0.6';
                            kindSpan.style.fontSize = '10px';
                            kindSpan.textContent = s.kind;

                            item.appendChild(nameSpan);
                            item.appendChild(kindSpan);

                            item.onmouseover = () => item.style.backgroundColor = 'var(--vscode-editorSuggestWidget-selectedBackground, #062f4a)';
                            item.onmouseout = () => item.style.backgroundColor = 'transparent';

                            item.onclick = () => {
                                const replaceStart = cursorPos - match[0].length;
                                const newVal = val.slice(0, replaceStart) + '{' + s.val + '}' + val.slice(cursorPos);
                                updatePromptVal(newVal);
                                autocompleteBox.style.display = 'none';
                                inputEl.focus();
                                argsMap.set('prompt', toWfStringLiteral(newVal));
                            };
                            autocompleteBox.appendChild(item);
                        });

                        autocompleteBox.style.display = 'block';
                        autocompleteBox.style.marginTop = '4px';

                    } else {
                        autocompleteBox.style.display = 'none';
                    }
                } else {
                    autocompleteBox.style.display = 'none';
                }
            });

            document.addEventListener('click', (e) => {
                if (e.target !== inputEl && !autocompleteBox.contains(e.target as Node)) {
                    autocompleteBox.style.display = 'none';
                }
            });
        };

        createAutocomplete(promptInput, promptContent);

        // Attach floating editor logic
        popupBtn.addEventListener('click', () => {
            const overlay = document.createElement('div');
            overlay.style.position = 'fixed';
            overlay.style.top = '0';
            overlay.style.left = '0';
            overlay.style.width = '100vw';
            overlay.style.height = '100vh';
            overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
            overlay.style.backdropFilter = 'blur(4px)';
            overlay.style.zIndex = '9999999';
            overlay.style.display = 'flex';
            overlay.style.alignItems = 'center';
            overlay.style.justifyContent = 'center';
            overlay.style.transition = 'opacity 0.2s';

            const modal = document.createElement('div');
            modal.style.width = '60vw';
            modal.style.minWidth = '500px';
            modal.style.height = '60vh';
            modal.style.backgroundColor = 'var(--vscode-editor-background, #1e1e1e)';
            modal.style.borderRadius = '8px';
            modal.style.boxShadow = '0 12px 32px rgba(0,0,0,0.5)';
            modal.style.border = '1px solid var(--vscode-widget-border, #454545)';
            modal.style.display = 'flex';
            modal.style.flexDirection = 'column';
            modal.style.overflow = 'hidden';

            const header = document.createElement('div');
            header.style.padding = '12px 16px';
            header.style.backgroundColor = 'var(--vscode-editorGroupHeader-tabsBackground, #2d2d2d)';
            header.style.borderBottom = '1px solid var(--vscode-editorGroup-border, #454545)';
            header.style.display = 'flex';
            header.style.justifyContent = 'space-between';
            header.style.alignItems = 'center';

            const title = document.createElement('div');
            title.innerHTML = '<span class="codicon codicon-sparkle"></span> Prompt <span style="opacity: 0.5; font-size: 11px; margin-left: 10px;">Type { to use IntelliSense parameters</span>';
            title.style.fontWeight = 'bold';
            title.style.color = 'var(--vscode-editor-foreground, #ccc)';

            const closeBtn = document.createElement('button');
            closeBtn.innerHTML = '<span class="codicon codicon-close"></span>';
            closeBtn.className = 'mini-btn danger';
            closeBtn.style.border = 'none';
            closeBtn.style.cursor = 'pointer';
            closeBtn.onclick = () => document.body.removeChild(overlay);

            header.appendChild(title);
            header.appendChild(closeBtn);

            const editorWrap = document.createElement('div');
            editorWrap.style.flex = '1';
            editorWrap.style.position = 'relative';
            editorWrap.style.padding = '16px';
            editorWrap.style.display = 'flex';
            editorWrap.style.flexDirection = 'column';

            const largeInput = document.createElement('textarea');
            largeInput.style.flex = '1';
            largeInput.style.backgroundColor = 'transparent';
            largeInput.style.color = 'var(--vscode-editor-foreground, #ccc)';
            largeInput.style.border = 'none';
            largeInput.style.outline = 'none';
            largeInput.style.resize = 'none';
            largeInput.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
            largeInput.style.fontSize = '14px';
            largeInput.style.lineHeight = '1.5';
            largeInput.value = promptInput.value;

            largeInput.addEventListener('input', () => {
                updatePromptVal(largeInput.value);
            });

            createAutocomplete(largeInput, editorWrap, 10000000);

            editorWrap.appendChild(largeInput);

            const footer = document.createElement('div');
            footer.style.padding = '12px 16px';
            footer.style.borderTop = '1px solid var(--vscode-editorGroup-border, #454545)';
            footer.style.display = 'flex';
            footer.style.justifyContent = 'space-between';
            footer.style.alignItems = 'center';

            const footerHint = document.createElement('div');
            footerHint.textContent = 'Changes auto-saved. Click Apply & Save to confirm.';
            footerHint.style.fontSize = '11px';
            footerHint.style.opacity = '0.6';

            const saveModalBtn = document.createElement('button');
            saveModalBtn.textContent = 'Apply & Close';
            saveModalBtn.className = 'mini-btn';
            saveModalBtn.style.padding = '4px 12px';
            saveModalBtn.style.fontSize = '12px';
            saveModalBtn.style.backgroundColor = 'var(--vscode-button-background, #0e639c)';
            saveModalBtn.style.color = 'var(--vscode-button-foreground, #fff)';
            saveModalBtn.onclick = () => {
                context.save();
                document.body.removeChild(overlay);
            };

            footer.appendChild(footerHint);
            footer.appendChild(saveModalBtn);

            modal.appendChild(header);
            modal.appendChild(editorWrap);
            modal.appendChild(footer);
            overlay.appendChild(modal);

            document.body.appendChild(overlay);
            largeInput.focus();
        });

        promptContent.appendChild(promptInput);
        promptRow.appendChild(promptContent);
        body.appendChild(promptRow);
        body.appendChild(claudeRow);
        body.appendChild(skillRow);

        // 1b. MCP Servers section
        const mcpRow = document.createElement('details');
        mcpRow.className = 'agent-skill-block agent-collapsible';
        const mcpHead = document.createElement('summary');
        mcpHead.className = 'agent-section-head';
        const mcpTitleWrap = document.createElement('span');
        mcpTitleWrap.className = 'agent-collapsible-title';
        const mcpChevron = document.createElement('span');
        mcpChevron.className = 'codicon codicon-chevron-right agent-collapse-chevron';
        const mcpLabel = document.createElement('div');
        mcpLabel.textContent = 'MCP';
        mcpLabel.className = 'agent-skill-label';
        mcpTitleWrap.appendChild(mcpChevron);
        mcpTitleWrap.appendChild(mcpLabel);
        const mcpRaw = (argsMap.get('useMcp') ?? '').trim().toLowerCase();
        let mcpActive = mcpRaw ? mcpRaw === 'true' : false;
        const mcpEnabledToggle = createEnabledToggle(mcpActive);
        // The Enabled toggle lives inside the <summary>; a click on it must flip the
        // switch, not collapse the section. Swallow the summary toggle and flip manually.
        mcpEnabledToggle.wrap.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            mcpEnabledToggle.input.checked = !mcpEnabledToggle.input.checked;
            mcpEnabledToggle.input.dispatchEvent(new Event('change'));
        });
        mcpRow.open = false; // collapsed by default to cut noise; enabling expands it
        mcpHead.appendChild(mcpTitleWrap);
        mcpHead.appendChild(mcpEnabledToggle.wrap);

        const mcpContent = document.createElement('div');
        mcpContent.className = 'agent-section-content';

        const mcpServersLabel = document.createElement('div');
        mcpServersLabel.textContent = 'Servers';
        mcpServersLabel.style.fontSize = '10px';
        mcpServersLabel.style.opacity = '0.8';
        mcpServersLabel.style.fontWeight = '500';
        mcpServersLabel.style.marginBottom = '4px';

        const mcpServersInput = document.createElement('input');
        mcpServersInput.className = 'annotation-input';
        mcpServersInput.placeholder = 'e.g. filesystem, github';
        mcpServersInput.style.width = '100%';
        mcpServersInput.style.boxSizing = 'border-box';
        const mcpServersRaw = argsMap.get('mcpServers') ?? '';
        const mcpServersParsed = tryParseWfStringListExpr(mcpServersRaw);
        mcpServersInput.value = mcpServersParsed ? mcpServersParsed.join(', ') : '';
        mcpServersInput.addEventListener('input', () => {
            const val = mcpServersInput.value.trim();
            if (val) {
                const items = val.split(',').map(s => s.trim()).filter(s => s.length > 0);
                argsMap.set('mcpServers', serializeWfStringListExpr(items));
            } else {
                argsMap.delete('mcpServers');
            }
        });

        const mcpHint = document.createElement('div');
        mcpHint.className = 'agent-skill-hint';
        mcpHint.textContent = 'Comma-separated MCP server names from agent-tools.json registry';

        // Rich MCP server config (editable, from mcpServerConfigs JSON)
        const mcpConfigsContainer = document.createElement('div');
        mcpConfigsContainer.style.marginTop = '8px';
        const mcpConfigsRaw = argsMap.get('mcpServerConfigs') ?? '';
        let mcpConfigsParsed: Array<{name: string; transport: string; url: string; command: string; args: string[]}> = [];
        try { mcpConfigsParsed = mcpConfigsRaw ? JSON.parse(mcpConfigsRaw) : []; } catch { /* ignore parse errors */ }

        const syncMcpConfigs = (): void => {
            if (mcpConfigsParsed.length > 0) {
                argsMap.set('mcpServerConfigs', JSON.stringify(mcpConfigsParsed));
            } else {
                argsMap.delete('mcpServerConfigs');
            }
        };

        const createMcpField = (labelText: string, value: string, onChange: (v: string) => void, placeholder = ''): HTMLElement => {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 4px;';
            const lbl = document.createElement('span');
            lbl.style.cssText = 'opacity: 0.7; min-width: 70px; font-size: 10px; font-weight: 500;';
            lbl.textContent = labelText;
            const inp = document.createElement('input');
            inp.className = 'annotation-input';
            inp.style.cssText = 'flex: 1; box-sizing: border-box;';
            inp.value = value;
            inp.placeholder = placeholder;
            inp.addEventListener('input', () => onChange(inp.value));
            row.appendChild(lbl);
            row.appendChild(inp);
            return row;
        };

        let lastRemovedMcp: { cfg: {name: string; transport: string; url: string; command: string; args: string[]}; idx: number } | null = null;
        const renderMcpCards = (): void => {
            mcpConfigsContainer.innerHTML = '';
            if (lastRemovedMcp) {
                const snap = lastRemovedMcp;
                mcpConfigsContainer.appendChild(buildCardUndoBar(
                    'MCP server', snap.cfg.name || '',
                    () => { mcpConfigsParsed.splice(Math.min(snap.idx, mcpConfigsParsed.length), 0, snap.cfg); lastRemovedMcp = null; syncMcpConfigs(); renderMcpCards(); },
                    () => { lastRemovedMcp = null; renderMcpCards(); }
                ));
            }
            mcpConfigsParsed.forEach((cfg, idx) => {
                const card = document.createElement('div');
                card.style.cssText = 'background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border, #333); border-radius: 4px; padding: 8px; margin-bottom: 6px; font-size: 11px;';
                const header = buildRemovableCardHeader('MCP server', cfg.name || 'Unnamed server', () => { lastRemovedMcp = { cfg, idx }; mcpConfigsParsed.splice(idx, 1); syncMcpConfigs(); renderMcpCards(); });
                card.appendChild(header);

                card.appendChild(createMcpField('Name', cfg.name || '', v => { cfg.name = v; const t = header.querySelector('.pp-card-title'); if (t) t.textContent = v.trim() || 'Unnamed server'; syncMcpConfigs(); }, 'e.g. my-mcp'));
                // Transport select
                const tRow = document.createElement('div');
                tRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 4px;';
                const tLbl = document.createElement('span');
                tLbl.style.cssText = 'opacity: 0.7; min-width: 70px; font-size: 10px; font-weight: 500;';
                tLbl.textContent = 'Transport';
                const tSel = document.createElement('select');
                tSel.className = 'annotation-input';
                tSel.style.cssText = 'flex: 1; box-sizing: border-box;';
                for (const opt of ['bridge', 'stdio', 'http', 'streamable-http']) {
                    const o = document.createElement('option');
                    o.value = opt; o.textContent = opt;
                    tSel.appendChild(o);
                }
                tSel.value = cfg.transport || 'bridge';
                tSel.addEventListener('change', () => { cfg.transport = tSel.value; syncMcpConfigs(); });
                tRow.appendChild(tLbl);
                tRow.appendChild(tSel);
                card.appendChild(tRow);

                card.appendChild(createMcpField('URL', cfg.url || '', v => { cfg.url = v; syncMcpConfigs(); }, 'e.g. http://localhost:8080/mcp'));
                card.appendChild(createMcpField('Command', cfg.command || '', v => { cfg.command = v; syncMcpConfigs(); }, 'e.g. npx'));
                card.appendChild(createMcpField('Args', (cfg.args || []).join(' '), v => { cfg.args = v.trim() ? v.split(/\s+/) : []; syncMcpConfigs(); }, 'space-separated args'));
                mcpConfigsContainer.appendChild(card);
            });

            // Add button
            const addBtn = document.createElement('button');
            addBtn.textContent = '+ Add MCP Server';
            addBtn.style.cssText = 'background: none; border: 1px dashed var(--vscode-panel-border, #555); color: var(--vscode-foreground); padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; width: 100%;';
            addBtn.addEventListener('click', () => {
                mcpConfigsParsed.push({name: '', transport: 'bridge', url: '', command: '', args: []});
                syncMcpConfigs();
                renderMcpCards();
            });
            mcpConfigsContainer.appendChild(addBtn);
        };
        renderMcpCards();

        const mcpTransportLabel = document.createElement('div');
        mcpTransportLabel.textContent = 'Transport';
        mcpTransportLabel.style.fontSize = '10px';
        mcpTransportLabel.style.opacity = '0.8';
        mcpTransportLabel.style.fontWeight = '500';
        mcpTransportLabel.style.marginTop = '8px';
        mcpTransportLabel.style.marginBottom = '4px';

        const mcpTransportSelect = document.createElement('select');
        mcpTransportSelect.className = 'annotation-input';
        mcpTransportSelect.style.width = '100%';
        mcpTransportSelect.style.boxSizing = 'border-box';
        for (const opt of ['bridge', 'stdio', 'http', 'streamable-http']) {
            const o = document.createElement('option');
            o.value = opt;
            o.textContent = opt;
            mcpTransportSelect.appendChild(o);
        }
        const mcpTransportRaw = stripQuotesIfStringLiteral(argsMap.get('mcpTransport') ?? '').trim();
        if (mcpTransportRaw && ['bridge', 'stdio', 'http', 'streamable-http'].includes(mcpTransportRaw)) {
            mcpTransportSelect.value = mcpTransportRaw;
        }
        mcpTransportSelect.addEventListener('change', () => {
            const val = mcpTransportSelect.value;
            if (val && val !== 'bridge') {
                argsMap.set('mcpTransport', toWfStringLiteral(val));
            } else {
                argsMap.delete('mcpTransport');
            }
        });

        // Always show rich config container (has add button); hide basic transport when configs exist
        const hasRichMcpConfigs = mcpConfigsParsed.length > 0;

        const syncMcpActive = (): void => {
            argsMap.set('useMcp', mcpActive ? 'true' : 'false');
            mcpEnabledToggle.input.checked = mcpActive;
            mcpServersInput.disabled = !mcpActive;
            mcpTransportSelect.disabled = !mcpActive;
            mcpRow.classList.toggle('disabled', !mcpActive);
        };
        mcpEnabledToggle.input.addEventListener('change', () => {
            mcpActive = mcpEnabledToggle.input.checked;
            syncMcpActive();
            if (mcpActive) mcpRow.open = true; // reveal the config you just enabled
        });
        syncMcpActive();

        mcpContent.appendChild(mcpServersLabel);
        mcpContent.appendChild(mcpServersInput);
        mcpContent.appendChild(mcpHint);
        mcpContent.appendChild(mcpConfigsContainer);
        if (!hasRichMcpConfigs) {
            mcpContent.appendChild(mcpTransportLabel);
            mcpContent.appendChild(mcpTransportSelect);
        }
        mcpRow.appendChild(mcpHead);
        mcpRow.appendChild(mcpContent);
        body.appendChild(mcpRow);

        // 1c. LSP section
        const lspRow = document.createElement('details');
        lspRow.className = 'agent-skill-block agent-collapsible';
        const lspHead = document.createElement('summary');
        lspHead.className = 'agent-section-head';
        const lspTitleWrap = document.createElement('span');
        lspTitleWrap.className = 'agent-collapsible-title';
        const lspChevron = document.createElement('span');
        lspChevron.className = 'codicon codicon-chevron-right agent-collapse-chevron';
        const lspLabel = document.createElement('div');
        lspLabel.textContent = 'LSP';
        lspLabel.className = 'agent-skill-label';
        lspTitleWrap.appendChild(lspChevron);
        lspTitleWrap.appendChild(lspLabel);
        const lspRaw = (argsMap.get('useLsp') ?? '').trim().toLowerCase();
        let lspActive = lspRaw ? lspRaw === 'true' : false;
        const lspEnabledToggle = createEnabledToggle(lspActive);
        // The Enabled toggle lives inside the <summary>; a click on it must flip the
        // switch, not collapse the section. Swallow the summary toggle and flip manually.
        lspEnabledToggle.wrap.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            lspEnabledToggle.input.checked = !lspEnabledToggle.input.checked;
            lspEnabledToggle.input.dispatchEvent(new Event('change'));
        });
        lspRow.open = false; // collapsed by default to cut noise; enabling expands it
        lspHead.appendChild(lspTitleWrap);
        lspHead.appendChild(lspEnabledToggle.wrap);

        const lspContent = document.createElement('div');
        lspContent.className = 'agent-section-content';

        const lspServersLabel = document.createElement('div');
        lspServersLabel.textContent = 'Servers';
        lspServersLabel.style.fontSize = '10px';
        lspServersLabel.style.opacity = '0.8';
        lspServersLabel.style.fontWeight = '500';
        lspServersLabel.style.marginBottom = '4px';

        const lspServersInput = document.createElement('input');
        lspServersInput.className = 'annotation-input';
        lspServersInput.placeholder = 'e.g. pylance, typescript';
        lspServersInput.style.width = '100%';
        lspServersInput.style.boxSizing = 'border-box';
        const lspServersRaw = argsMap.get('lspServers') ?? '';
        const lspServersParsed = tryParseWfStringListExpr(lspServersRaw);
        lspServersInput.value = lspServersParsed ? lspServersParsed.join(', ') : '';
        lspServersInput.addEventListener('input', () => {
            const val = lspServersInput.value.trim();
            if (val) {
                const items = val.split(',').map(s => s.trim()).filter(s => s.length > 0);
                argsMap.set('lspServers', serializeWfStringListExpr(items));
            } else {
                argsMap.delete('lspServers');
            }
        });

        const lspHint = document.createElement('div');
        lspHint.className = 'agent-skill-hint';
        lspHint.textContent = 'Comma-separated LSP server names available to this agent';

        // Rich LSP server config (editable, from lspServerConfigs JSON)
        const lspConfigsContainer = document.createElement('div');
        lspConfigsContainer.style.marginTop = '8px';
        const lspConfigsRaw = argsMap.get('lspServerConfigs') ?? '';
        let lspConfigsParsed: Array<{
            name: string; command: string; args: string[];
            languageId: string; extraFlags: string[];
            ports: string[]; maxRepairAttempts: number;
            severityThreshold: string;
        }> = [];
        try { lspConfigsParsed = lspConfigsRaw ? JSON.parse(lspConfigsRaw) : []; } catch { /* ignore */ }

        const syncLspConfigs = (): void => {
            if (lspConfigsParsed.length > 0) {
                argsMap.set('lspServerConfigs', JSON.stringify(lspConfigsParsed));
            } else {
                argsMap.delete('lspServerConfigs');
            }
        };

        const createLspField = (labelText: string, value: string, onChange: (v: string) => void, placeholder = ''): HTMLElement => {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 4px;';
            const lbl = document.createElement('span');
            lbl.style.cssText = 'opacity: 0.7; min-width: 90px; font-size: 10px; font-weight: 500;';
            lbl.textContent = labelText;
            const inp = document.createElement('input');
            inp.className = 'annotation-input';
            inp.style.cssText = 'flex: 1; box-sizing: border-box;';
            inp.value = value;
            inp.placeholder = placeholder;
            inp.addEventListener('input', () => onChange(inp.value));
            row.appendChild(lbl);
            row.appendChild(inp);
            return row;
        };

        let lastRemovedLsp: { cfg: typeof lspConfigsParsed[number]; idx: number } | null = null;
        const renderLspCards = (): void => {
            lspConfigsContainer.innerHTML = '';
            if (lastRemovedLsp) {
                const snap = lastRemovedLsp;
                lspConfigsContainer.appendChild(buildCardUndoBar(
                    'LSP server', snap.cfg.command || snap.cfg.name || '',
                    () => { lspConfigsParsed.splice(Math.min(snap.idx, lspConfigsParsed.length), 0, snap.cfg); lastRemovedLsp = null; syncLspConfigs(); renderLspCards(); },
                    () => { lastRemovedLsp = null; renderLspCards(); }
                ));
            }
            lspConfigsParsed.forEach((cfg, idx) => {
                const card = document.createElement('div');
                card.style.cssText = 'background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border, #333); border-radius: 4px; padding: 8px; margin-bottom: 6px; font-size: 11px;';
                const header = buildRemovableCardHeader('LSP server', cfg.command || 'Unnamed server', () => { lastRemovedLsp = { cfg, idx }; lspConfigsParsed.splice(idx, 1); syncLspConfigs(); renderLspCards(); });
                card.appendChild(header);

                card.appendChild(createLspField('Command', cfg.command || '', v => { cfg.command = v; cfg.name = v; const t = header.querySelector('.pp-card-title'); if (t) t.textContent = v.trim() || 'Unnamed server'; syncLspConfigs(); }, 'e.g. clangd'));
                card.appendChild(createLspField('Args', (cfg.args || []).join(' '), v => { cfg.args = v.trim() ? v.split(/\s+/) : []; syncLspConfigs(); }, 'space-separated'));
                card.appendChild(createLspField('Language', cfg.languageId || '', v => { cfg.languageId = v; syncLspConfigs(); }, 'e.g. cpp'));
                card.appendChild(createLspField('Extra Flags', (cfg.extraFlags || []).join(' '), v => { cfg.extraFlags = v.trim() ? v.split(/\s+/) : []; syncLspConfigs(); }, 'space-separated'));
                card.appendChild(createLspField('Ports', (cfg.ports || []).join(', '), v => { cfg.ports = v.trim() ? v.split(',').map(s => s.trim()).filter(Boolean) : []; syncLspConfigs(); }, 'comma-separated'));
                card.appendChild(createLspField('Max Repairs', String(cfg.maxRepairAttempts ?? 2), v => { cfg.maxRepairAttempts = parseInt(v, 10) || 2; syncLspConfigs(); }, '2'));
                // Severity select
                const sevRow = document.createElement('div');
                sevRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 4px;';
                const sevLbl = document.createElement('span');
                sevLbl.style.cssText = 'opacity: 0.7; min-width: 90px; font-size: 10px; font-weight: 500;';
                sevLbl.textContent = 'Severity';
                const sevSel = document.createElement('select');
                sevSel.className = 'annotation-input';
                sevSel.style.cssText = 'flex: 1; box-sizing: border-box;';
                for (const opt of ['error', 'warning', 'info', 'hint']) {
                    const o = document.createElement('option');
                    o.value = opt; o.textContent = opt;
                    sevSel.appendChild(o);
                }
                sevSel.value = cfg.severityThreshold || 'error';
                sevSel.addEventListener('change', () => { cfg.severityThreshold = sevSel.value; syncLspConfigs(); });
                sevRow.appendChild(sevLbl);
                sevRow.appendChild(sevSel);
                card.appendChild(sevRow);

                lspConfigsContainer.appendChild(card);
            });

            // Add button
            const addBtn = document.createElement('button');
            addBtn.textContent = '+ Add LSP Server';
            addBtn.style.cssText = 'background: none; border: 1px dashed var(--vscode-panel-border, #555); color: var(--vscode-foreground); padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; width: 100%;';
            addBtn.addEventListener('click', () => {
                lspConfigsParsed.push({name: '', command: '', args: [], languageId: '', extraFlags: [], ports: [], maxRepairAttempts: 2, severityThreshold: 'error'});
                syncLspConfigs();
                renderLspCards();
            });
            lspConfigsContainer.appendChild(addBtn);
        };
        renderLspCards();

        const hasRichLspConfigs = lspConfigsParsed.length > 0;

        const lspCommandLabel = document.createElement('div');
        lspCommandLabel.textContent = 'Command';
        lspCommandLabel.style.fontSize = '10px';
        lspCommandLabel.style.opacity = '0.8';
        lspCommandLabel.style.fontWeight = '500';
        lspCommandLabel.style.marginTop = '8px';
        lspCommandLabel.style.marginBottom = '4px';

        const lspCommandInput = document.createElement('input');
        lspCommandInput.className = 'annotation-input';
        lspCommandInput.placeholder = 'e.g. pylsp';
        lspCommandInput.style.width = '100%';
        lspCommandInput.style.boxSizing = 'border-box';
        lspCommandInput.value = stripQuotesIfStringLiteral(argsMap.get('lspCommand') ?? '');
        lspCommandInput.addEventListener('input', () => {
            const val = lspCommandInput.value.trim();
            if (val) argsMap.set('lspCommand', toWfStringLiteral(val));
            else argsMap.delete('lspCommand');
        });

        const lspPortLabel = document.createElement('div');
        lspPortLabel.textContent = 'Port';
        lspPortLabel.style.fontSize = '10px';
        lspPortLabel.style.opacity = '0.8';
        lspPortLabel.style.fontWeight = '500';
        lspPortLabel.style.marginTop = '8px';
        lspPortLabel.style.marginBottom = '4px';

        const lspPortInput = document.createElement('input');
        lspPortInput.type = 'number';
        lspPortInput.className = 'annotation-input';
        lspPortInput.placeholder = 'e.g. 2087';
        lspPortInput.style.width = '100%';
        lspPortInput.style.boxSizing = 'border-box';
        lspPortInput.value = argsMap.get('lspPort') ?? '';
        lspPortInput.addEventListener('input', () => {
            const val = lspPortInput.value.trim();
            if (val) argsMap.set('lspPort', val);
            else argsMap.delete('lspPort');
        });

        // Shorthand scalars accompanying the single lsp_command form. (The rich
        // lspServerConfigs editor covers these per-server; these apply when you use
        // the one-command shorthand instead.)
        const lspShortTextField = (labelText: string, key: string, placeholder: string, isList: boolean): HTMLElement => {
            const wrap = document.createElement('div');
            const lbl = document.createElement('div');
            lbl.textContent = labelText;
            lbl.style.cssText = 'font-size:10px;opacity:0.8;font-weight:500;margin-top:8px;margin-bottom:4px;';
            const inp = document.createElement('input');
            inp.className = 'annotation-input';
            inp.placeholder = placeholder;
            inp.style.cssText = 'width:100%;box-sizing:border-box;';
            if (isList) {
                const parsed = tryParseWfStringListExpr(argsMap.get(key) ?? '');
                inp.value = parsed ? parsed.join(' ') : '';
                inp.addEventListener('input', () => {
                    const v = inp.value.trim();
                    if (v) argsMap.set(key, serializeWfStringListExpr(v.split(/\s+/)));
                    else argsMap.delete(key);
                });
            } else {
                inp.value = stripQuotesIfStringLiteral(argsMap.get(key) ?? '');
                inp.addEventListener('input', () => {
                    const v = inp.value.trim();
                    if (v) argsMap.set(key, toWfStringLiteral(v));
                    else argsMap.delete(key);
                });
            }
            wrap.appendChild(lbl);
            wrap.appendChild(inp);
            return wrap;
        };
        const lspArgsField = lspShortTextField('Args', 'lspArgs', 'space-separated', true);
        const lspLanguageField = lspShortTextField('Language', 'lspLanguageId', 'e.g. cpp', false);
        const lspExtraFlagsField = lspShortTextField('Extra Flags', 'lspExtraFlags', 'space-separated', true);

        const lspSevWrap = document.createElement('div');
        const lspSevLabel = document.createElement('div');
        lspSevLabel.textContent = 'Severity';
        lspSevLabel.style.cssText = 'font-size:10px;opacity:0.8;font-weight:500;margin-top:8px;margin-bottom:4px;';
        const lspSevSelect = document.createElement('select');
        lspSevSelect.className = 'annotation-input';
        lspSevSelect.style.cssText = 'width:100%;box-sizing:border-box;';
        for (const opt of ['error', 'warning', 'information', 'hint']) {
            const o = document.createElement('option'); o.value = opt; o.textContent = opt; lspSevSelect.appendChild(o);
        }
        const lspSevCurrent = stripQuotesIfStringLiteral(argsMap.get('lspSeverityThreshold') ?? '').trim();
        lspSevSelect.value = ['error', 'warning', 'information', 'hint'].includes(lspSevCurrent) ? lspSevCurrent : 'error';
        lspSevSelect.addEventListener('change', () => {
            if (lspSevSelect.value && lspSevSelect.value !== 'error') argsMap.set('lspSeverityThreshold', toWfStringLiteral(lspSevSelect.value));
            else argsMap.delete('lspSeverityThreshold');
        });
        lspSevWrap.appendChild(lspSevLabel);
        lspSevWrap.appendChild(lspSevSelect);

        const lspMaxWrap = document.createElement('div');
        const lspMaxLabel = document.createElement('div');
        lspMaxLabel.textContent = 'Max Repairs';
        lspMaxLabel.style.cssText = 'font-size:10px;opacity:0.8;font-weight:500;margin-top:8px;margin-bottom:4px;';
        const lspMaxInput = document.createElement('input');
        lspMaxInput.type = 'number';
        lspMaxInput.min = '0';
        lspMaxInput.className = 'annotation-input';
        lspMaxInput.placeholder = '2';
        lspMaxInput.style.cssText = 'width:100%;box-sizing:border-box;';
        lspMaxInput.value = argsMap.get('lspMaxRepairAttempts') ?? '';
        lspMaxInput.addEventListener('input', () => {
            const v = lspMaxInput.value.trim();
            if (v && v !== '2') argsMap.set('lspMaxRepairAttempts', v);
            else argsMap.delete('lspMaxRepairAttempts');
        });
        lspMaxWrap.appendChild(lspMaxLabel);
        lspMaxWrap.appendChild(lspMaxInput);

        const syncLspActive = (): void => {
            argsMap.set('useLsp', lspActive ? 'true' : 'false');
            lspEnabledToggle.input.checked = lspActive;
            lspServersInput.disabled = !lspActive;
            lspCommandInput.disabled = !lspActive;
            lspPortInput.disabled = !lspActive;
            lspRow.classList.toggle('disabled', !lspActive);
        };
        lspEnabledToggle.input.addEventListener('change', () => {
            lspActive = lspEnabledToggle.input.checked;
            syncLspActive();
            if (lspActive) lspRow.open = true; // reveal the config you just enabled
        });
        syncLspActive();

        lspContent.appendChild(lspServersLabel);
        lspContent.appendChild(lspServersInput);
        lspContent.appendChild(lspHint);
        lspContent.appendChild(lspConfigsContainer);
        if (!hasRichLspConfigs) {
            lspContent.appendChild(lspCommandLabel);
            lspContent.appendChild(lspCommandInput);
            lspContent.appendChild(lspArgsField);
            lspContent.appendChild(lspLanguageField);
            lspContent.appendChild(lspExtraFlagsField);
            lspContent.appendChild(lspSevWrap);
            lspContent.appendChild(lspMaxWrap);
            lspContent.appendChild(lspPortLabel);
            lspContent.appendChild(lspPortInput);
        }
        lspRow.appendChild(lspHead);
        lspRow.appendChild(lspContent);
        body.appendChild(lspRow);

        // 1d. Output Validators — per-agent output checks (cmd: run any tool
        // against the output file; lsp: structured diagnostics). Unlike MCP/LSP
        // configs these fully round-trip to source (managed arg, not GUI-only).
        // Collapsed by default (native <details>) — validators are an advanced,
        // usually-empty section, so keep it out of the way until needed. The summary
        // carries a count badge so the collapsed state still shows how many exist.
        const ovRow = document.createElement('details');
        ovRow.className = 'agent-skill-block agent-collapsible';
        const ovHead = document.createElement('summary');
        ovHead.className = 'agent-section-head';
        const ovLabelWrap = document.createElement('span');
        ovLabelWrap.className = 'agent-collapsible-title';
        const ovChevron = document.createElement('span');
        ovChevron.className = 'codicon codicon-chevron-right agent-collapse-chevron';
        const ovLabel = document.createElement('span');
        ovLabel.textContent = 'Output Validators';
        ovLabel.className = 'agent-skill-label';
        ovLabelWrap.appendChild(ovChevron);
        ovLabelWrap.appendChild(ovLabel);
        const ovCount = document.createElement('span');
        ovCount.className = 'agent-collapsible-count';
        ovHead.appendChild(ovLabelWrap);
        ovHead.appendChild(ovCount);

        const ovContent = document.createElement('div');
        ovContent.className = 'agent-section-content';
        const ovHint = document.createElement('div');
        ovHint.className = 'agent-skill-hint';
        ovHint.textContent = 'Validate agent output by running a command or an LSP server; failures re-prompt the agent.';
        ovContent.appendChild(ovHint);

        type OvConfig = {
            kind: string; cmd: string; args: string[]; ports: string[];
            maxRepairAttempts: number; severityThreshold: string;
            languageId: string; extraFlags: string[];
        };
        let ovParsed: OvConfig[] = [];
        try {
            const raw = argsMap.get('outputValidators') ?? '';
            ovParsed = raw ? JSON.parse(raw) : [];
        } catch { /* ignore malformed */ }

        const syncOvConfigs = (): void => {
            if (ovParsed.length === 0) {
                argsMap.delete('outputValidators');
                return;
            }
            // Emit only non-empty fields, and only string/int/array values, so the
            // JSON is a valid literal the decorator can re-parse.
            const clean = ovParsed.map((v) => {
                const c: Record<string, unknown> = {
                    kind: v.kind || 'cmd',
                    cmd: v.cmd || '',
                    args: v.args || [],
                    maxRepairAttempts: v.maxRepairAttempts ?? 2,
                    severityThreshold: v.severityThreshold || 'error'
                };
                if (v.ports && v.ports.length) c.ports = v.ports;
                if (v.kind === 'lsp') {
                    if (v.languageId) c.languageId = v.languageId;
                    if (v.extraFlags && v.extraFlags.length) c.extraFlags = v.extraFlags;
                }
                return c;
            });
            argsMap.set('outputValidators', JSON.stringify(clean));
        };

        const ovCardsContainer = document.createElement('div');
        ovCardsContainer.style.marginTop = '4px';

        let lastRemovedOv: { cfg: OvConfig; idx: number } | null = null;
        const ovTitle = (cfg: OvConfig): string => (cfg.cmd && cfg.cmd.trim()) || `${cfg.kind || 'cmd'} validator`;
        const renderOvCards = (): void => {
            ovCount.textContent = ovParsed.length ? String(ovParsed.length) : '';
            ovCardsContainer.innerHTML = '';
            if (lastRemovedOv) {
                const snap = lastRemovedOv;
                ovCardsContainer.appendChild(buildCardUndoBar(
                    'validator', ovTitle(snap.cfg),
                    () => { ovParsed.splice(Math.min(snap.idx, ovParsed.length), 0, snap.cfg); lastRemovedOv = null; syncOvConfigs(); renderOvCards(); },
                    () => { lastRemovedOv = null; renderOvCards(); }
                ));
            }
            ovParsed.forEach((cfg, idx) => {
                const card = document.createElement('div');
                card.style.cssText = 'background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border, #333); border-radius: 4px; padding: 8px; margin-bottom: 6px; font-size: 11px;';
                card.appendChild(buildRemovableCardHeader('validator', ovTitle(cfg), () => { lastRemovedOv = { cfg, idx }; ovParsed.splice(idx, 1); syncOvConfigs(); renderOvCards(); }));

                // Kind select (cmd | lsp)
                const kindRow = document.createElement('div');
                kindRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 4px;';
                const kindLbl = document.createElement('span');
                kindLbl.style.cssText = 'opacity: 0.7; min-width: 90px; font-size: 10px; font-weight: 500;';
                kindLbl.textContent = 'Kind';
                const kindSel = document.createElement('select');
                kindSel.className = 'annotation-input';
                kindSel.style.cssText = 'flex: 1; box-sizing: border-box;';
                for (const opt of ['cmd', 'lsp']) {
                    const o = document.createElement('option');
                    o.value = opt; o.textContent = opt;
                    kindSel.appendChild(o);
                }
                kindSel.value = cfg.kind || 'cmd';
                kindSel.addEventListener('change', () => { cfg.kind = kindSel.value; syncOvConfigs(); renderOvCards(); });
                kindRow.appendChild(kindLbl);
                kindRow.appendChild(kindSel);
                card.appendChild(kindRow);

                const ovField = (labelText: string, value: string, onChange: (v: string) => void, placeholder = ''): HTMLElement => {
                    const row = document.createElement('div');
                    row.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 4px;';
                    const lbl = document.createElement('span');
                    lbl.style.cssText = 'opacity: 0.7; min-width: 90px; font-size: 10px; font-weight: 500;';
                    lbl.textContent = labelText;
                    const inp = document.createElement('input');
                    inp.className = 'annotation-input';
                    inp.style.cssText = 'flex: 1; box-sizing: border-box;';
                    inp.value = value;
                    inp.placeholder = placeholder;
                    inp.addEventListener('input', () => onChange(inp.value));
                    row.appendChild(lbl);
                    row.appendChild(inp);
                    return row;
                };

                card.appendChild(ovField('Command', cfg.cmd || '', v => { cfg.cmd = v; syncOvConfigs(); }, cfg.kind === 'lsp' ? 'e.g. clangd' : 'e.g. bisheng'));
                card.appendChild(ovField('Args', (cfg.args || []).join(' '), v => { cfg.args = v.trim() ? v.split(/\s+/) : []; syncOvConfigs(); }, '{file} placeholder allowed'));
                card.appendChild(ovField('Ports', (cfg.ports || []).join(', '), v => { cfg.ports = v.trim() ? v.split(',').map(s => s.trim()).filter(Boolean) : []; syncOvConfigs(); }, 'comma-separated (empty = all File ports)'));
                card.appendChild(ovField('Max Repairs', String(cfg.maxRepairAttempts ?? 2), v => { cfg.maxRepairAttempts = parseInt(v, 10) || 2; syncOvConfigs(); }, '2'));

                // Severity select
                const sevRow = document.createElement('div');
                sevRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 4px;';
                const sevLbl = document.createElement('span');
                sevLbl.style.cssText = 'opacity: 0.7; min-width: 90px; font-size: 10px; font-weight: 500;';
                sevLbl.textContent = 'Severity';
                const sevSel = document.createElement('select');
                sevSel.className = 'annotation-input';
                sevSel.style.cssText = 'flex: 1; box-sizing: border-box;';
                for (const opt of ['error', 'warning', 'information', 'hint']) {
                    const o = document.createElement('option');
                    o.value = opt; o.textContent = opt;
                    sevSel.appendChild(o);
                }
                sevSel.value = cfg.severityThreshold || 'error';
                sevSel.addEventListener('change', () => { cfg.severityThreshold = sevSel.value; syncOvConfigs(); });
                sevRow.appendChild(sevLbl);
                sevRow.appendChild(sevSel);
                card.appendChild(sevRow);

                // LSP-only fields
                if (cfg.kind === 'lsp') {
                    card.appendChild(ovField('Language', cfg.languageId || '', v => { cfg.languageId = v; syncOvConfigs(); }, 'e.g. cpp'));
                    card.appendChild(ovField('Extra Flags', (cfg.extraFlags || []).join(' '), v => { cfg.extraFlags = v.trim() ? v.split(/\s+/) : []; syncOvConfigs(); }, 'space-separated'));
                }

                ovCardsContainer.appendChild(card);
            });

            const addBtn = document.createElement('button');
            addBtn.textContent = '+ Add Output Validator';
            addBtn.style.cssText = 'background: none; border: 1px dashed var(--vscode-panel-border, #555); color: var(--vscode-foreground); padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; width: 100%;';
            addBtn.addEventListener('click', () => {
                ovParsed.push({ kind: 'cmd', cmd: '', args: [], ports: [], maxRepairAttempts: 2, severityThreshold: 'error', languageId: '', extraFlags: [] });
                syncOvConfigs();
                renderOvCards();
            });
            ovCardsContainer.appendChild(addBtn);
        };
        renderOvCards();

        ovContent.appendChild(ovCardsContainer);
        ovRow.appendChild(ovHead);
        ovRow.appendChild(ovContent);
        body.appendChild(ovRow);

        // 3. Model Configuration (2-column layout)
        const modelGrid = document.createElement('div');
        modelGrid.style.display = 'grid';
        modelGrid.style.gridTemplateColumns = '1fr 1fr';
        modelGrid.style.gap = '8px';
        modelGrid.style.marginBottom = '8px';

        const createField = (key: string, label: string, placeholder: string) => {
            const wrapper = document.createElement('div');
            wrapper.style.display = 'flex';
            wrapper.style.flexDirection = 'column';
            wrapper.style.gap = '4px';

            const l = document.createElement('div');
            l.textContent = label;
            l.style.fontSize = '10px';
            l.style.opacity = '0.8';
            l.style.fontWeight = '500';

            const inp = document.createElement('input');
            inp.className = 'annotation-input';
            inp.placeholder = placeholder;
            inp.style.width = '100%';
            inp.style.boxSizing = 'border-box';
            inp.value = stripQuotesIfStringLiteral(argsMap.get(key) ?? '');
            inp.addEventListener('input', () => {
                const val = inp.value.trim();
                if (val) argsMap.set(key, toWfStringLiteral(val));
                else argsMap.delete(key);
            });

            wrapper.appendChild(l);
            wrapper.appendChild(inp);
            return wrapper;
        };

        // Dropdown for enum-valued @agent args. `defaultValue` is the value
        // that means "unset" (omitted from source); selecting it deletes the arg.
        const createSelect = (
            key: string,
            label: string,
            options: Array<{ value: string; label: string; group?: string }>,
            defaultValue: string,
            onChange?: (value: string) => void
        ) => {
            const wrapper = document.createElement('div');
            wrapper.style.display = 'flex';
            wrapper.style.flexDirection = 'column';
            wrapper.style.gap = '4px';

            const l = document.createElement('div');
            l.textContent = label;
            l.style.fontSize = '10px';
            l.style.opacity = '0.8';
            l.style.fontWeight = '500';

            const sel = document.createElement('select');
            sel.className = 'annotation-input';
            sel.style.width = '100%';
            sel.style.boxSizing = 'border-box';
            // Render <optgroup>s when options declare a group, so distinct
            // categories (e.g. API vs CLI vs ACP transport) read as distinct.
            const optGroups = new Map<string, HTMLOptGroupElement>();
            for (const opt of options) {
                const o = document.createElement('option');
                o.value = opt.value;
                o.textContent = opt.label;
                if (opt.group) {
                    let og = optGroups.get(opt.group);
                    if (!og) {
                        og = document.createElement('optgroup');
                        og.label = opt.group;
                        optGroups.set(opt.group, og);
                        sel.appendChild(og);
                    }
                    og.appendChild(o);
                } else {
                    sel.appendChild(o);
                }
            }
            const current = stripQuotesIfStringLiteral(argsMap.get(key) ?? '').trim();
            sel.value = options.some((o) => o.value === current) ? current : defaultValue;
            sel.addEventListener('change', () => {
                const val = sel.value;
                if (val && val !== defaultValue) {
                    argsMap.set(key, toWfStringLiteral(val));
                } else {
                    argsMap.delete(key);
                }
                onChange?.(val);
            });

            wrapper.appendChild(l);
            wrapper.appendChild(sel);
            return wrapper;
        };

        modelGrid.appendChild(createField('model', 'Model', 'e.g. gpt-4'));
        modelGrid.appendChild(createField('provider', 'Provider', 'e.g. openai'));
        body.appendChild(modelGrid);

        // 4. Endpoint (Full Width)
        const epRow = document.createElement('div');
        epRow.style.marginBottom = '12px';

        const epLabel = document.createElement('div');
        epLabel.textContent = 'Endpoint';
        epLabel.style.fontSize = '10px';
        epLabel.style.opacity = '0.8';
        epLabel.style.fontWeight = '500';
        epLabel.style.marginBottom = '4px';

        const epInput = document.createElement('input');
        epInput.className = 'annotation-input';
        epInput.placeholder = 'https://api.openai.com/v1';
        epInput.style.width = '100%';
        epInput.style.boxSizing = 'border-box';
        epInput.value = stripQuotesIfStringLiteral(argsMap.get('endpoint') ?? '');
        epInput.addEventListener('input', () => {
             const val = epInput.value.trim();
             if (val) argsMap.set('endpoint', toWfStringLiteral(val));
             else argsMap.delete('endpoint');
        });

        epRow.appendChild(epLabel);
        epRow.appendChild(epInput);
        body.appendChild(epRow);

        // 5. Execution Settings (Grid: Timeout, Budget, Stateful)
        const execGrid = document.createElement('div');
        execGrid.style.display = 'grid';
        execGrid.style.gridTemplateColumns = '1fr 1fr auto';
        execGrid.style.gap = '8px';
        execGrid.style.alignItems = 'end'; // Align checkbox with inputs
        execGrid.style.paddingTop = '4px';
        execGrid.style.borderTop = '1px solid var(--vscode-editorWidget-border)';

        // Timeout
        const timeoutWrapper = document.createElement('div');
        timeoutWrapper.style.display = 'flex';
        timeoutWrapper.style.flexDirection = 'column';
        timeoutWrapper.style.gap = '4px';
        const timeoutLabel = document.createElement('div');
        timeoutLabel.textContent = 'Timeout (ms)';
        timeoutLabel.style.fontSize = '10px';
        timeoutLabel.style.opacity = '0.8';
        const timeoutInput = document.createElement('input');
        timeoutInput.type = 'number';
        timeoutInput.className = 'annotation-input';
        timeoutInput.placeholder = '30000';
        timeoutInput.style.width = '100%';
        timeoutInput.style.boxSizing = 'border-box';
        timeoutInput.value = argsMap.get('timeoutMs') ?? '';
        timeoutInput.addEventListener('input', () => {
            const val = timeoutInput.value.trim();
            if (val) argsMap.set('timeoutMs', val);
            else argsMap.delete('timeoutMs');
        });
        timeoutWrapper.appendChild(timeoutLabel);
        timeoutWrapper.appendChild(timeoutInput);
        execGrid.appendChild(timeoutWrapper);

        // Budget
        const budgetWrapper = document.createElement('div');
        budgetWrapper.style.display = 'flex';
        budgetWrapper.style.flexDirection = 'column';
        budgetWrapper.style.gap = '4px';
        const budgetLabel = document.createElement('div');
        budgetLabel.textContent = 'Context Budget';
        budgetLabel.style.fontSize = '10px';
        budgetLabel.style.opacity = '0.8';
        const budgetInput = document.createElement('input');
        budgetInput.type = 'number';
        budgetInput.className = 'annotation-input';
        budgetInput.placeholder = '20';
        budgetInput.style.width = '100%';
        budgetInput.style.boxSizing = 'border-box';
        budgetInput.value = argsMap.get('contextBudget') ?? '';
        budgetInput.addEventListener('input', () => {
            const val = budgetInput.value.trim();
            if (val) argsMap.set('contextBudget', val);
            else argsMap.delete('contextBudget');
        });
        budgetWrapper.appendChild(budgetLabel);
        budgetWrapper.appendChild(budgetInput);
        execGrid.appendChild(budgetWrapper);

        // Stateful Toggle
        const statefulWrapper = document.createElement('div');
        statefulWrapper.style.display = 'flex';
        statefulWrapper.style.flexDirection = 'column';
        statefulWrapper.style.gap = '4px';
        statefulWrapper.style.alignItems = 'center';

        const statefulLabel = document.createElement('div');
        statefulLabel.textContent = 'Stateful';
        statefulLabel.style.fontSize = '10px';
        statefulLabel.style.opacity = '0.8';

        const toggleLabel = document.createElement('label');
        toggleLabel.style.display = 'inline-block';
        toggleLabel.style.position = 'relative';
        toggleLabel.style.width = '32px';
        toggleLabel.style.height = '18px';
        toggleLabel.style.marginBottom = '3px'; // align with input height

        const toggleInput = document.createElement('input');
        toggleInput.type = 'checkbox';
        toggleInput.style.opacity = '0';
        toggleInput.style.width = '0';
        toggleInput.style.height = '0';
        toggleInput.checked = (argsMap.get('stateful') ?? '').trim() === 'true';

        const toggleSlider = document.createElement('span');
        toggleSlider.style.position = 'absolute';
        toggleSlider.style.cursor = 'pointer';
        toggleSlider.style.top = '0';
        toggleSlider.style.left = '0';
        toggleSlider.style.right = '0';
        toggleSlider.style.bottom = '0';
        toggleSlider.style.backgroundColor = 'var(--vscode-input-background)';
        toggleSlider.style.border = '1px solid var(--vscode-input-border)';
        toggleSlider.style.transition = '.2s';
        toggleSlider.style.borderRadius = '18px';

        const toggleKnob = document.createElement('span');
        toggleKnob.style.position = 'absolute';
        toggleKnob.style.content = '""';
        toggleKnob.style.height = '12px';
        toggleKnob.style.width = '12px';
        toggleKnob.style.left = '3px';
        toggleKnob.style.bottom = '2px';
        toggleKnob.style.backgroundColor = 'var(--vscode-foreground)';
        toggleKnob.style.transition = '.2s';
        toggleKnob.style.borderRadius = '50%';
        toggleKnob.style.opacity = '0.6';

        // Toggle Logic
        const updateToggle = () => {
            if (toggleInput.checked) {
                toggleSlider.style.backgroundColor = 'var(--vscode-button-background)';
                toggleKnob.style.transform = 'translateX(14px)';
                toggleKnob.style.backgroundColor = 'var(--vscode-button-foreground)';
                toggleKnob.style.opacity = '1';
            } else {
                toggleSlider.style.backgroundColor = 'var(--vscode-input-background)';
                toggleKnob.style.transform = 'translateX(0)';
                toggleKnob.style.backgroundColor = 'var(--vscode-foreground)';
                toggleKnob.style.opacity = '0.6';
            }
            argsMap.set('stateful', toggleInput.checked ? 'true' : 'false');
        };

        toggleInput.addEventListener('change', updateToggle);
        // Initial state
        if (toggleInput.checked) {
            toggleSlider.style.backgroundColor = 'var(--vscode-button-background)';
            toggleKnob.style.transform = 'translateX(14px)';
            toggleKnob.style.backgroundColor = 'var(--vscode-button-foreground)';
             toggleKnob.style.opacity = '1';
        }

        toggleSlider.appendChild(toggleKnob);
        toggleLabel.appendChild(toggleInput);
        toggleLabel.appendChild(toggleSlider);

        statefulWrapper.appendChild(statefulLabel);
        statefulWrapper.appendChild(toggleLabel);
        execGrid.appendChild(statefulWrapper);

        body.appendChild(execGrid);

        // 6. Context truncation + background execution
        const advGrid = document.createElement('div');
        advGrid.style.display = 'grid';
        advGrid.style.gridTemplateColumns = '1fr 1fr';
        advGrid.style.gap = '8px';
        advGrid.style.marginTop = '8px';
        advGrid.appendChild(createSelect('truncationStrategy', 'Truncation', [
            { value: 'sliding', label: 'sliding' },
            { value: 'summarize', label: 'summarize' }
        ], 'sliding'));

        const fireableWrapper = document.createElement('div');
        fireableWrapper.style.display = 'flex';
        fireableWrapper.style.flexDirection = 'column';
        fireableWrapper.style.gap = '4px';
        const fireableLabel = document.createElement('div');
        fireableLabel.textContent = 'Fireable w/o input';
        fireableLabel.style.fontSize = '10px';
        fireableLabel.style.opacity = '0.8';
        fireableLabel.style.fontWeight = '500';
        const fireableInput = document.createElement('input');
        fireableInput.type = 'number';
        fireableInput.min = '0';
        fireableInput.className = 'annotation-input';
        fireableInput.placeholder = '0';
        fireableInput.style.width = '100%';
        fireableInput.style.boxSizing = 'border-box';
        fireableInput.value = argsMap.get('fireableWithoutInput') ?? '';
        fireableInput.addEventListener('input', () => {
            const val = fireableInput.value.trim();
            if (val && val !== '0') argsMap.set('fireableWithoutInput', val);
            else argsMap.delete('fireableWithoutInput');
        });
        fireableWrapper.appendChild(fireableLabel);
        fireableWrapper.appendChild(fireableInput);
        advGrid.appendChild(fireableWrapper);
        body.appendChild(advGrid);

        // 7. Backend transport. Three distinct categories — a REST API call
        // (http), a one-shot CLI subprocess (*-cli), or a persistent ACP protocol
        // session (acp, with a connector naming the agent; opencode-acp is the
        // OpenCode-only spelling) — so they're grouped, and the CLI-only tooling
        // below dims when the HTTP API is selected (it doesn't apply there).
        const backendGrid = document.createElement('div');
        backendGrid.style.display = 'grid';
        backendGrid.style.gridTemplateColumns = '1fr 1fr';
        backendGrid.style.gap = '8px';
        backendGrid.style.marginTop = '8px';

        const noneSentinel = clientBehavior().noneSentinel;
        const cliToolsOptions = [
            ...(noneSentinel ? [{ value: noneSentinel, label: noneSentinel }] : []),
            { value: 'native', label: 'native' }
        ];
        const cliToolsWrap = createSelect('cliToolsMode', 'CLI Tools', cliToolsOptions, noneSentinel ?? 'native');
        const reasoningWrap = createSelect('reasoningEffort', 'Reasoning', [
            { value: '', label: 'default' },
            { value: 'minimal', label: 'minimal' },
            { value: 'high', label: 'high' },
            { value: 'max', label: 'max' }
        ], '');

        // The ACP connector: the agent the session speaks to. The list is what
        // the runtime discovered on this machine plus what the user declared
        // (clientBehavior.acpConnectors, resolved per document); a value the
        // list lacks is kept as its own option so a file written elsewhere
        // round-trips. Empty means the run's default (--acp-connector).
        const currentConnector = stripQuotesIfStringLiteral(argsMap.get('connector') ?? '').trim();
        const connectorOptions: Array<{ value: string; label: string; group?: string }> = [
            { value: '', label: "(run's default)" }
        ];
        for (const c of clientBehavior().acpConnectors ?? []) {
            const detail = c.available ? '' : ' (not on PATH)';
            connectorOptions.push({ value: c.name, label: `${c.name}${detail}`, group: c.source === 'discovered' ? 'Discovered' : `Declared (${c.source})` });
        }
        if (currentConnector && !connectorOptions.some((o) => o.value === currentConnector)) {
            connectorOptions.push({ value: currentConnector, label: `${currentConnector} (unknown)` });
        }
        const connectorWrap = createSelect('connector', 'Connector', connectorOptions, '');
        if (!clientBehavior().acpConnectors?.length) {
            connectorWrap.title = 'No ACP connectors reported by the runtime; the run\'s --acp-connector applies';
        }

        // The ACP session mode (e.g. Claude: default / acceptEdits / plan /
        // dontAsk / bypassPermissions): free text, since each agent has its own.
        const modeWrapper = document.createElement('div');
        modeWrapper.style.display = 'flex';
        modeWrapper.style.flexDirection = 'column';
        modeWrapper.style.gap = '4px';
        const modeLabel = document.createElement('div');
        modeLabel.textContent = 'Session mode';
        modeLabel.style.fontSize = '10px';
        modeLabel.style.opacity = '0.8';
        modeLabel.style.fontWeight = '500';
        const modeInput = document.createElement('input');
        modeInput.className = 'annotation-input';
        modeInput.placeholder = "agent's default";
        modeInput.style.width = '100%';
        modeInput.style.boxSizing = 'border-box';
        modeInput.value = stripQuotesIfStringLiteral(argsMap.get('mode') ?? '').trim();
        modeInput.addEventListener('input', () => {
            const val = modeInput.value.trim();
            if (val) argsMap.set('mode', toWfStringLiteral(val));
            else argsMap.delete('mode');
        });
        modeWrapper.appendChild(modeLabel);
        modeWrapper.appendChild(modeInput);

        // CLI Tools / Reasoning apply to the CLI + ACP transports, not the HTTP API;
        // Connector / Session mode apply to the ACP transports only.
        const updateBackendRelevance = (transportVal: string): void => {
            const isHttp = (transportVal || 'http') === 'http';
            for (const w of [cliToolsWrap, reasoningWrap]) {
                w.style.opacity = isHttp ? '0.45' : '1';
                w.title = isHttp ? 'Applies to CLI / ACP transports, not the HTTP API' : '';
                const s = w.querySelector('select') as HTMLSelectElement | null;
                if (s) s.disabled = isHttp;
            }
            const isAcp = transportVal === 'acp' || transportVal === 'opencode-acp';
            for (const w of [connectorWrap, modeWrapper]) {
                w.style.opacity = isAcp ? '1' : '0.45';
                const s = w.querySelector('select, input') as HTMLSelectElement | HTMLInputElement | null;
                if (s) s.disabled = !isAcp;
            }
            if (!isAcp) connectorWrap.title = 'Applies to the ACP transports';
        };

        const transportWrap = createSelect('transport', 'Transport', [
            { value: 'http', label: 'http', group: 'REST API' },
            { value: 'acp', label: 'acp (connector)', group: 'ACP (protocol session)' },
            { value: 'opencode-acp', label: 'opencode-acp', group: 'ACP (protocol session)' },
            { value: 'opencode-cli', label: 'opencode-cli', group: 'CLI (subprocess)' },
            { value: 'claude-cli', label: 'claude-cli', group: 'CLI (subprocess)' },
            { value: 'codex-cli', label: 'codex-cli', group: 'CLI (subprocess)' }
        ], 'http', updateBackendRelevance);
        updateBackendRelevance(stripQuotesIfStringLiteral(argsMap.get('transport') ?? '').trim() || 'http');

        backendGrid.appendChild(transportWrap);
        backendGrid.appendChild(connectorWrap);
        backendGrid.appendChild(modeWrapper);
        backendGrid.appendChild(cliToolsWrap);
        backendGrid.appendChild(reasoningWrap);
        body.appendChild(backendGrid);
    }
}

export function describeSkillStatus(skill: WorkflowAgentSkill): string {
    const desc = (skill.description ?? '').trim();
    if (desc) {
        return desc;
    }
    return skill.hasSkillMd
        ? `Skill '${skill.name}' has no description in SKILL.md.`
        : `Skill '${skill.name}' is missing SKILL.md.`;
}

function skillWarningSummary(skill: WorkflowAgentSkill): string {
    const warnings: string[] = [];
    if (!skill.hasSkillMd) {
        warnings.push('SKILL.md missing');
    }
    if ((skill.missingDeclaredHooks?.length ?? 0) > 0) {
        warnings.push(`Missing scripts: ${skill.missingDeclaredHooks?.join(', ')}`);
    }
    if ((skill.warnings?.length ?? 0) > 0) {
        warnings.push(...(skill.warnings ?? []));
    }
    return warnings.join(' | ');
}

/**
 * Header row for an item card in a list editor (MCP / LSP / Output Validators):
 * the item's title on the left, a remove button on the right, in normal flow.
 * Replaces the old absolutely-positioned X that floated over the first field and
 * clipped (tooltip and all) at the panel's right edge.
 */
export function buildRemovableCardHeader(noun: string, title: string, onRemove: () => void): HTMLElement {
    const header = document.createElement('div');
    header.className = 'pp-card-head';
    const titleEl = document.createElement('span');
    titleEl.className = 'pp-card-title';
    titleEl.textContent = title;
    const rm = document.createElement('button');
    rm.className = 'mini-btn icon-only danger';
    rm.innerHTML = '<span class="codicon codicon-close"></span>';
    rm.title = `Remove this ${noun}`;
    rm.setAttribute('aria-label', `Remove this ${noun}`);
    rm.addEventListener('click', onRemove);
    header.appendChild(titleEl);
    header.appendChild(rm);
    return header;
}

/**
 * Inline "Removed … · Undo" bar for the list editors, so an accidental card
 * removal is recoverable. Returns the bar element; the caller owns the snapshot
 * state plus the restore (`onUndo`) and dismiss (`onDismiss`) behaviour.
 */
export function buildCardUndoBar(noun: string, removedTitle: string, onUndo: () => void, onDismiss: () => void): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'pp-undo-bar';
    const msg = document.createElement('span');
    msg.className = 'pp-undo-msg';
    const named = (removedTitle ?? '').trim();
    msg.textContent = named ? `Removed “${named}”.` : `Removed ${noun}.`;
    const actions = document.createElement('div');
    actions.className = 'pp-undo-actions';
    const undoBtn = document.createElement('button');
    undoBtn.className = 'mini-btn';
    undoBtn.textContent = 'Undo';
    undoBtn.title = `Restore this ${noun}`;
    undoBtn.addEventListener('click', onUndo);
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'mini-btn icon-only';
    dismissBtn.innerHTML = '<span class="codicon codicon-close"></span>';
    dismissBtn.title = 'Dismiss';
    dismissBtn.setAttribute('aria-label', 'Dismiss');
    dismissBtn.addEventListener('click', onDismiss);
    actions.appendChild(undoBtn);
    actions.appendChild(dismissBtn);
    bar.appendChild(msg);
    bar.appendChild(actions);
    return bar;
}
