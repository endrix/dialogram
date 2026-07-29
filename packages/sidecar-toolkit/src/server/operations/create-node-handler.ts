import { CreateNodeOperation, TriggerNodeCreationAction } from '@eclipse-glsp/protocol';
import { OperationHandler, MaybePromise, ModelState, Command } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { readAuthoritativeSourceText } from './authoritative-source-text';
import { URI } from 'vscode-uri';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';

import { ReversibleWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-workspace-edit-command';
import { SidecarInvoker, SidecarInvocationResult } from './sidecar-invoker';
import {
    type PythonDefinition,
    extractTopLevelPythonDefinitions,
    hasDecorator
} from '../python-text';

type WorkflowTypeKind = 'workflow' | 'task' | 'tool' | 'agent' | 'viewer';

type ProjectTypeCacheEntry = {
    expiresAt: number;
    names: string[];
};

type TypeListCacheEntry = {
    expiresAt: number;
    names: string[];
};

const EXCLUDED_SCAN_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'wf-out', 'dist', 'out', 'build']);
const EXCLUDED_PYTHON_FIND_GLOB = '**/{.git,node_modules,.venv,venv,__pycache__,wf-out,dist,out,build}/**';
const PROJECT_TYPE_CACHE_TTL_MS = 15_000;
const TYPE_LIST_CACHE_TTL_MS = 10_000;
const MAX_DISCOVERED_PYTHON_FILES = 2_000;

function isTaskLikeDefinition(definition: PythonDefinition): boolean {
    if (definition.kind !== 'class') {
        return hasDecorator(definition.decorators, 'task');
    }

    return /(^|\n)\s+class\s+Ports\s*:/.test(definition.bodyText)
        || /\bPort\s*\[/.test(definition.bodyText)
        || /(^|\n)\s+def\s+(?:run|action|__call__)\s*\(/.test(definition.bodyText);
}

function discoverWorkflowTypeNamesInSource(sourceText: string, requestedKind: WorkflowTypeKind): string[] {
    const names: string[] = [];
    const seen = new Set<string>();

    for (const definition of extractTopLevelPythonDefinitions(sourceText)) {
        let discoveredKind: WorkflowTypeKind | undefined;
        if (definition.kind === 'function' && hasDecorator(definition.decorators, 'workflow')) {
            discoveredKind = 'workflow';
        } else if (hasDecorator(definition.decorators, 'agent')) {
            discoveredKind = 'agent';
        } else if (hasDecorator(definition.decorators, 'viewer')) {
            discoveredKind = 'viewer';
        } else if (hasDecorator(definition.decorators, 'tool')) {
            discoveredKind = 'tool';
        } else if (hasDecorator(definition.decorators, 'task') || isTaskLikeDefinition(definition)) {
            discoveredKind = 'task';
        }

        if (discoveredKind !== requestedKind || seen.has(definition.name)) {
            continue;
        }
        seen.add(definition.name);
        names.push(definition.name);
    }

    return names;
}

async function fileExists(pathValue: string): Promise<boolean> {
    try {
        await fs.access(pathValue);
        return true;
    } catch {
        return false;
    }
}

async function findPackageRootForFile(filePath: string): Promise<string | undefined> {
    let current = path.dirname(filePath);
    for (;;) {
        const marker = path.join(current, '__init__.py');
        if (!(await fileExists(marker))) {
            break;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return undefined;
        }
        current = parent;
    }
    return current;
}

async function collectPythonFilesUnderRoots(scanRoots: string[], currentFilePath: string): Promise<string[]> {
    const files: string[] = [];
    const seenFiles = new Set<string>();
    const seenDirs = new Set<string>();
    const normalizedCurrentPath = path.resolve(currentFilePath);

    const visit = async (dirPath: string): Promise<void> => {
        let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        try {
            entries = await fs.readdir(dirPath, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        } catch {
            return;
        }

        for (const entry of entries) {
            const entryPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                if (EXCLUDED_SCAN_DIRS.has(entry.name)) {
                    continue;
                }
                await visit(entryPath);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.py')) {
                continue;
            }
            const normalizedPath = path.resolve(entryPath);
            if (normalizedPath === normalizedCurrentPath || seenFiles.has(normalizedPath)) {
                continue;
            }
            seenFiles.add(normalizedPath);
            files.push(normalizedPath);
        }
    };

    for (const root of scanRoots) {
        const normalizedRoot = path.resolve(root);
        if (seenDirs.has(normalizedRoot)) {
            continue;
        }
        seenDirs.add(normalizedRoot);
        await visit(normalizedRoot);
    }

    files.sort((left, right) => left.localeCompare(right));
    return files;
}

@injectable()
export class CreateNodeOperationHandler extends OperationHandler {
    private static readonly projectTypeCache = new Map<string, ProjectTypeCacheEntry>();

    private static readonly pendingProjectTypeDiscovery = new Map<string, Promise<string[]>>();

    private static readonly typeListCache = new Map<string, TypeListCacheEntry>();

    readonly operationType = CreateNodeOperation.KIND;
    override readonly label = 'Create Node';
    readonly elementTypeIds = [
        WorkflowDiagramTypes.NODE_TASK,
        WorkflowDiagramTypes.NODE_EXTERNAL_TASK,
        WorkflowDiagramTypes.NODE_VIEWER_TASK,
        WorkflowDiagramTypes.NODE_WORKFLOW,
        WorkflowDiagramTypes.NODE_BOUNDARY_INPUT,
        WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT
    ];

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(SidecarInvoker)
    protected readonly sidecar!: SidecarInvoker;

    getTriggerActions(): TriggerNodeCreationAction[] {
        return this.elementTypeIds.map(elementTypeId => ({
            kind: TriggerNodeCreationAction.KIND,
            elementTypeId
        }));
    }

    createCommand(operation: CreateNodeOperation): MaybePromise<Command | undefined> {
        const sourceUri = this.modelState.root.args?.['sourceUri'] as string | undefined;
        if (!sourceUri || !sourceUri.endsWith('.py')) {
            return undefined;
        }
        return this.createPythonCommand(operation, sourceUri);
    }

    private createPythonCommand(operation: CreateNodeOperation, sourceUri: string): Command | undefined {
        const vscodeUri = vscode.Uri.parse(sourceUri);
        const root = this.modelState.root;
        const workflowName = (root.args?.['wf:workflowName'] as string | undefined)
            ?? (root.args?.[WorkflowDiagramMetadata.WORKFLOW_NAME] as string | undefined);

        const command = new ReversibleWorkspaceEditCommand({
            label: this.label + this.sidecar.undoLabelSuffix(),
            uri: vscodeUri,
            computeEdits: async () => {
                const beforeText = (await vscode.workspace.openTextDocument(vscodeUri)).getText();
                const elementTypeId = operation.elementTypeId;
                if (!elementTypeId) {
                    return undefined;
                }

                // Agent-dispatched (headless) creations MUST NOT trigger interactive UI. The MCP
                // tool layer stamps `args.headless` on the operation; the palette/webview flow never
                // does, so it keeps its dialogs. When headless every value the dialog would collect
                // (type, instance name, port name/type) must come from `operation.args` — otherwise
                // we FAIL with an actionable error instead of prompting a user who isn't there.
                const headless = operation.args?.['headless'] === true;

                if (!(await this.ensureCreateCapabilities(sourceUri, elementTypeId))) {
                    return undefined;
                }

                const isViewer = elementTypeId === WorkflowDiagramTypes.NODE_VIEWER_TASK
                    || operation.args?.['viewerTask'] === true || operation.args?.['viewerTask'] === 'true';
                const isAgent = elementTypeId === WorkflowDiagramTypes.NODE_EXTERNAL_TASK
                    && (operation.args?.['agentTask'] === true || operation.args?.['agentTask'] === 'true');
                const isExternal = elementTypeId === WorkflowDiagramTypes.NODE_EXTERNAL_TASK && !isAgent && !isViewer;
                const isTask = elementTypeId === WorkflowDiagramTypes.NODE_TASK;
                const isWorkflow = elementTypeId === WorkflowDiagramTypes.NODE_WORKFLOW;

                const isBoundaryInput = elementTypeId === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT;
                const isBoundaryOutput = elementTypeId === WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT;
                if (isBoundaryInput || isBoundaryOutput) {
                    const direction = isBoundaryInput ? 'input' : 'output';
                    const portName = headless
                        ? (operation.args?.['portName'] as string | undefined)?.trim()
                        : (await vscode.window.showInputBox({
                            prompt: `New ${direction} port name`,
                            placeHolder: direction === 'input' ? 'In' : 'Out'
                        }))?.trim();
                    if (!portName) {
                        if (headless) {
                            this.showAgentAmbiguity(`create ${direction} port`, 'pass args.portName and args.portType');
                        }
                        return undefined;
                    }
                    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(portName)) {
                        void vscode.window.showErrorMessage('Invalid port name (must be an identifier).');
                        return undefined;
                    }
                    const portType = headless
                        ? (operation.args?.['portType'] as string | undefined)?.trim()
                        : (await vscode.window.showInputBox({
                            prompt: `Type for ${direction} port '${portName}'`,
                            placeHolder: 'e.g. int(size=32)'
                        }))?.trim();
                    if (!portType) {
                        if (headless) {
                            this.showAgentAmbiguity(`create ${direction} port '${portName}'`, 'pass args.portType');
                        }
                        return undefined;
                    }
                    const result = await this.sendSidecarOpDetailed(sourceUri, {
                        op: this.sidecar.sidecarOp('createPort'),
                        args: {
                            workflow: workflowName,
                            direction,
                            portName,
                            portType
                        }
                    });
                    if (!result.ok) {
                        this.showSidecarFailure(`create ${direction} port '${portName}'`, result);
                        return undefined;
                    }
                    const afterText = await readAuthoritativeSourceText(vscodeUri);
                    (command as any)._sourceBeforeText = beforeText;
                    (command as any)._sourceAfterText = afterText;
                    return [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')];
                }

                let typeName = (operation.args?.['type'] as string | undefined)?.trim();
                if (!typeName && (isAgent || isViewer || isExternal || isTask || isWorkflow)) {
                    const requestedKind: WorkflowTypeKind = isWorkflow
                        ? 'workflow'
                        : isAgent
                            ? 'agent'
                            : isViewer
                                ? 'viewer'
                                : isExternal
                                    ? 'tool'
                                    : 'task';
                        const typeLabel = this.typeLabelForPicker(requestedKind);
                        if (headless) {
                            this.showAgentAmbiguity(`create ${typeLabel} node`, `pass args.type with an existing ${typeLabel} name`);
                            return undefined;
                        }
                        const listResult = await this.listTypeNamesDetailed(sourceUri, requestedKind);
                    const items = await this.resolveAvailableTypeNames(sourceUri, requestedKind, beforeText, listResult, `list available ${typeLabel} types`);
                    if (!items) {
                        return undefined;
                    }
                    type PickItem = vscode.QuickPickItem & (
                        | { itemKind: 'separator' }
                        | { itemKind: 'new' }
                        | { itemKind: 'existing'; name: string }
                    );
                    const pickItems: PickItem[] = [
                        { label: `$(add) Create new ${typeLabel}...`, itemKind: 'new' as const }
                    ];
                    if (items.length > 0) {
                        pickItems.push({
                            label: `Existing ${items.length === 1 ? typeLabel : `${typeLabel}s`}`,
                            kind: vscode.QuickPickItemKind.Separator,
                            itemKind: 'separator' as const
                        });
                    }
                    for (const item of items) {
                        pickItems.push({ label: item, description: isWorkflow ? '@workflow' : typeLabel, itemKind: 'existing' as const, name: item });
                    }
                    const picked = await vscode.window.showQuickPick<PickItem>(pickItems, {
                        placeHolder: `Select a ${typeLabel} to instantiate`
                    });
                    if (!picked) {
                        return undefined;
                    }
                    if (picked.itemKind === 'existing') {
                        typeName = picked.name;
                    } else {
                        const className = (await vscode.window.showInputBox({
                            prompt: this.sidecar.createNodeStrings().newTypeNamePrompt(requestedKind),
                            placeHolder: this.classNamePlaceholderForPicker(requestedKind)
                        }))?.trim();
                        if (!className) {
                            return undefined;
                        }
                        typeName = className;
                        const created = await this.sendSidecarOpDetailed(sourceUri, isWorkflow
                            ? { op: this.sidecar.sidecarOp('createWorkflowType'), args: { name: className } }
                            : { op: this.sidecar.sidecarOp('createTaskType'), args: { kind: isAgent ? 'agent' : isViewer ? 'viewer' : isExternal ? 'tool' : 'task', name: className } }
                        );
                        if (!created.ok) {
                            this.showSidecarFailure(`create ${typeLabel} type '${className}'`, created);
                            return undefined;
                        }
                        this.recordTypeListCacheHit(sourceUri, requestedKind, className);
                    }
                }
                if (!typeName) {
                    const label = elementTypeId === WorkflowDiagramTypes.NODE_WORKFLOW
                        ? this.typeLabelForPicker('workflow')
                        : this.typeLabelForPicker('task');
                    if (headless) {
                        this.showAgentAmbiguity(`create ${label} node`, `pass args.type with an existing ${label} name`);
                        return undefined;
                    }
                    const picked = (await vscode.window.showInputBox({
                        prompt: `Enter ${label} type name`,
                        placeHolder: label === this.typeLabelForPicker('workflow')
                            ? this.classNamePlaceholderForPicker('workflow')
                            : this.classNamePlaceholderForPicker('task')
                    }))?.trim();
                    if (!picked) {
                        return undefined;
                    }
                    typeName = picked;
                }

                const finalTypeName = typeName.trim();
                if (!finalTypeName) {
                    void vscode.window.showWarningMessage('Missing task/workflow type for node creation.');
                    return undefined;
                }

                const listResult = await this.sendSidecarListDetailed(sourceUri, {
                    op: this.sidecar.sidecarOp('listInstanceNames'),
                    args: { workflow: workflowName }
                });
                const names = this.extractDiagnosticStringArray(listResult, 'names', 'list existing instance names');
                if (!names) {
                    return undefined;
                }
                const taken = new Set(names);
                const defaultName = this.uniqueInstanceName(finalTypeName.toLowerCase(), taken);
                // Headless: use a caller-supplied `args.name`, else auto-generate the same unique
                // default the dialog pre-fills — never open the instance-name input box.
                const providedName = (operation.args?.['name'] as string | undefined)?.trim();
                const entityName = headless
                    ? (providedName || defaultName)
                    : ((await vscode.window.showInputBox({
                        prompt: 'Instance name',
                        value: defaultName
                    }))?.trim() || defaultName);
                if (taken.has(entityName)) {
                    void vscode.window.showErrorMessage(`Instance '${entityName}' already exists.`);
                    return undefined;
                }
                const paramsRaw = operation.args?.['params'];
                const params = (paramsRaw && typeof paramsRaw === 'object') ? (paramsRaw as Record<string, unknown>) : undefined;
                const result = await this.sendSidecarOpDetailed(sourceUri, {
                    op: this.sidecar.sidecarOp('createNode'),
                    args: {
                        workflow: workflowName,
                        type: finalTypeName,
                        name: entityName,
                        params
                    }
                });
                if (!result.ok) {
                    this.showSidecarFailure(`create node '${entityName}'`, result);
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

    private async sendSidecarOpDetailed(sourceUri: string, payload: { op: string; args: Record<string, unknown> }): Promise<SidecarInvocationResult> {
        return this.sidecar.sendSidecarOpDetailed(sourceUri, payload);
    }

    private async sendSidecarList(sourceUri: string, payload: { op: string; args: Record<string, unknown> }): Promise<any | undefined> {
        return this.sidecar.sendSidecarList(sourceUri, payload);
    }

    private async sendSidecarListDetailed(sourceUri: string, payload: { op: string; args: Record<string, unknown> }): Promise<SidecarInvocationResult> {
        return this.sidecar.sendSidecarListDetailed(sourceUri, payload);
    }

    private async sendSidecarCapabilitiesDetailed(sourceUri: string): Promise<SidecarInvocationResult> {
        return this.sidecar.sendSidecarCapabilitiesDetailed(sourceUri);
    }

    private async ensureCreateCapabilities(sourceUri: string, elementTypeId: string): Promise<boolean> {
        if (!this.sidecar.createNodeBehavior().capabilityProbeBeforeCreate) {
            return true;
        }

        const capabilitiesResult = await this.sendSidecarCapabilitiesDetailed(sourceUri);
        if (!capabilitiesResult.ok) {
            this.showSidecarFailure('query create-node capabilities', capabilitiesResult);
            return false;
        }

        const supportedOps = capabilitiesResult.response?.diagnostic?.capabilities?.supportedOps;
        if (!Array.isArray(supportedOps) || !supportedOps.every((value: unknown) => typeof value === 'string')) {
            void vscode.window.showErrorMessage(
                this.sidecar.createNodeStrings().invalidCapabilitiesResponse
            );
            return false;
        }

        const requiredOps = this.requiredOpsForElementType(elementTypeId);
        const missing = requiredOps.filter(op => !supportedOps.includes(op));
        if (missing.length === 0) {
            return true;
        }

        void vscode.window.showErrorMessage(
            this.sidecar.createNodeStrings().missingCapabilities(missing)
        );
        return false;
    }

    private requiredOpsForElementType(elementTypeId: string): string[] {
        if (elementTypeId === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT || elementTypeId === WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT) {
            return [this.sidecar.sidecarOp('createPort')];
        }

        if (elementTypeId === WorkflowDiagramTypes.NODE_WORKFLOW) {
            return [
                this.sidecar.sidecarOp('listWorkflowTypes'),
                this.sidecar.sidecarOp('listInstanceNames'),
                this.sidecar.sidecarOp('createNode')
            ];
        }

        return [
            this.sidecar.sidecarOp('listTaskTypes'),
            this.sidecar.sidecarOp('listInstanceNames'),
            this.sidecar.sidecarOp('createNode')
        ];
    }

    private async listTypeNamesDetailed(sourceUri: string, requestedKind: WorkflowTypeKind): Promise<SidecarInvocationResult> {
        const cacheKey = this.typeListCacheKey(sourceUri, requestedKind);
        const cached = CreateNodeOperationHandler.typeListCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            return {
                ok: true,
                response: {
                    status: 'ok',
                    diagnostic: {
                        types: cached.names
                    }
                }
            };
        }

        const payload = requestedKind === 'workflow'
            ? { op: this.sidecar.sidecarOp('listWorkflowTypes'), args: {} }
            : {
                op: this.sidecar.sidecarOp('listTaskTypes'),
                args: {
                    kind: requestedKind === 'agent' || requestedKind === 'viewer' || requestedKind === 'tool'
                        ? requestedKind
                        : 'task'
                }
            };
        const result = await this.sendSidecarListDetailed(sourceUri, payload);
        const values = result.response?.diagnostic?.['types'];
        if (result.ok && Array.isArray(values) && values.every(value => typeof value === 'string')) {
            CreateNodeOperationHandler.typeListCache.set(cacheKey, {
                expiresAt: Date.now() + TYPE_LIST_CACHE_TTL_MS,
                names: values
            });
        }
        return result;
    }

    private async resolveAvailableTypeNames(
        sourceUri: string,
        requestedKind: WorkflowTypeKind,
        currentSourceText: string,
        listResult: SidecarInvocationResult,
        action: string
    ): Promise<string[] | undefined> {
        const sidecarItems = this.extractDiagnosticStringArray(listResult, 'types', action);
        if (!sidecarItems) {
            return undefined;
        }
        if (!this.sidecar.createNodeBehavior().mergeProjectDiscoveredTypes) {
            return sidecarItems;
        }

        const discoveredItems = await this.discoverProjectTypeNames(sourceUri, requestedKind, currentSourceText);
        if (discoveredItems.length === 0) {
            return sidecarItems;
        }

        const merged = new Set<string>();
        for (const item of sidecarItems) {
            const trimmed = item.trim();
            if (trimmed !== '') {
                merged.add(trimmed);
            }
        }
        for (const item of discoveredItems) {
            const trimmed = item.trim();
            if (trimmed !== '') {
                merged.add(trimmed);
            }
        }
        return [...merged];
    }

    private async discoverProjectTypeNames(sourceUri: string, requestedKind: WorkflowTypeKind, currentSourceText: string): Promise<string[]> {
        let filePath: string;
        try {
            filePath = path.resolve(URI.parse(sourceUri).fsPath);
        } catch {
            return [];
        }
        if (filePath.trim() === '') {
            return [];
        }

        const scanRoots = await this.getProjectScanRoots(filePath);
        const cacheKey = this.projectTypeCacheKey(scanRoots, requestedKind);
        const cached = CreateNodeOperationHandler.projectTypeCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.names;
        }

        const pending = CreateNodeOperationHandler.pendingProjectTypeDiscovery.get(cacheKey);
        if (pending) {
            return pending;
        }

        const discovery = (async (): Promise<string[]> => {
            const candidateFiles = await this.collectProjectPythonFiles(scanRoots, filePath);
            const discovered = new Set<string>();

            for (const typeName of discoverWorkflowTypeNamesInSource(currentSourceText, requestedKind)) {
                discovered.add(typeName);
            }

            for (const candidateFile of candidateFiles) {
                let sourceText: string;
                try {
                    sourceText = await fs.readFile(candidateFile, 'utf-8');
                } catch {
                    continue;
                }
                for (const typeName of discoverWorkflowTypeNamesInSource(sourceText, requestedKind)) {
                    discovered.add(typeName);
                }
            }

            const names = [...discovered];
            CreateNodeOperationHandler.projectTypeCache.set(cacheKey, {
                expiresAt: Date.now() + PROJECT_TYPE_CACHE_TTL_MS,
                names
            });
            return names;
        })();

        CreateNodeOperationHandler.pendingProjectTypeDiscovery.set(cacheKey, discovery);
        try {
            return await discovery;
        } finally {
            CreateNodeOperationHandler.pendingProjectTypeDiscovery.delete(cacheKey);
        }
    }

    private async getProjectScanRoots(filePath: string): Promise<string[]> {
        const normalizedFilePath = path.resolve(filePath);
        const packageRoot = await findPackageRootForFile(filePath);
        const defaultRoot = packageRoot ? path.resolve(packageRoot) : path.dirname(normalizedFilePath);

        const workspaceAny = vscode.workspace as typeof vscode.workspace & {
            getWorkspaceFolder?: (uri: vscode.Uri) => { uri?: { fsPath?: string } } | undefined;
        };
        if (typeof workspaceAny.getWorkspaceFolder === 'function') {
            try {
                const workspaceFolder = workspaceAny.getWorkspaceFolder(vscode.Uri.parse(URI.file(filePath).toString()));
                const workspaceRoot = workspaceFolder?.uri?.fsPath;
                if (typeof workspaceRoot === 'string' && workspaceRoot.trim() !== '') {
                    return [defaultRoot, path.resolve(workspaceRoot)]
                        .filter((value, index, values) => values.indexOf(value) === index);
                }
            } catch {
                // Ignore workspace root lookup failures in tests and non-extension contexts.
            }
        }

        return [defaultRoot];
    }

    private projectTypeCacheKey(scanRoots: string[], requestedKind: WorkflowTypeKind): string {
        const normalizedRoots = scanRoots.map(root => path.resolve(root)).sort();
        return `${requestedKind}::${normalizedRoots.join('::')}`;
    }

    private typeListCacheKey(sourceUri: string, requestedKind: WorkflowTypeKind): string {
        return `${this.sidecar.settingsNamespace()}::${requestedKind}::${sourceUri}`;
    }

    private recordTypeListCacheHit(sourceUri: string, requestedKind: WorkflowTypeKind, typeName: string): void {
        const cacheKey = this.typeListCacheKey(sourceUri, requestedKind);
        const cached = CreateNodeOperationHandler.typeListCache.get(cacheKey);
        if (!cached || cached.expiresAt <= Date.now() || cached.names.includes(typeName)) {
            return;
        }
        CreateNodeOperationHandler.typeListCache.set(cacheKey, {
            expiresAt: cached.expiresAt,
            names: [...cached.names, typeName]
        });
    }

    private typeLabelForPicker(requestedKind: WorkflowTypeKind): string {
        return this.sidecar.createNodeStrings().typeLabel(requestedKind);
    }

    private classNamePlaceholderForPicker(requestedKind: WorkflowTypeKind): string {
        return this.sidecar.createNodeStrings().classNamePlaceholder(requestedKind);
    }

    private async collectProjectPythonFiles(scanRoots: string[], currentFilePath: string): Promise<string[]> {
        const workspaceAny = vscode.workspace as typeof vscode.workspace & {
            findFiles?: (
                include: unknown,
                exclude?: string | null,
                maxResults?: number,
                token?: vscode.CancellationToken
            ) => Thenable<vscode.Uri[]>;
        };
        const relativePatternCtor = (vscode as typeof vscode & {
            RelativePattern?: new (base: string, pattern: string) => unknown;
        }).RelativePattern;

        if (typeof workspaceAny.findFiles === 'function' && typeof relativePatternCtor === 'function') {
            const discovered = new Set<string>();
            for (const root of scanRoots) {
                let uris: vscode.Uri[];
                try {
                    uris = await workspaceAny.findFiles(
                        new relativePatternCtor(root, '**/*.py'),
                        EXCLUDED_PYTHON_FIND_GLOB,
                        MAX_DISCOVERED_PYTHON_FILES
                    );
                } catch {
                    uris = [];
                }
                for (const uri of uris) {
                    const normalizedPath = path.resolve(uri.fsPath);
                    if (normalizedPath === path.resolve(currentFilePath)) {
                        continue;
                    }
                    discovered.add(normalizedPath);
                }
            }
            if (discovered.size > 0) {
                return [...discovered].sort((left, right) => left.localeCompare(right));
            }
        }

        return collectPythonFilesUnderRoots(scanRoots, currentFilePath);
    }

    private extractDiagnosticStringArray(result: SidecarInvocationResult, field: 'types' | 'names', action: string): string[] | undefined {
        if (!result.ok) {
            if (this.sidecar.createNodeBehavior().surfaceSidecarListErrors) {
                this.showSidecarFailure(action, result);
                return undefined;
            }
            return [];
        }

        const values = result.response?.diagnostic?.[field];
        if (Array.isArray(values) && values.every(value => typeof value === 'string')) {
            return values;
        }

        if (this.sidecar.createNodeBehavior().surfaceSidecarListErrors) {
            void vscode.window.showErrorMessage(
                this.sidecar.createNodeStrings().invalidListResponse(action, field)
            );
            return undefined;
        }

        return [];
    }

    /**
     * Surface a non-interactive, actionable failure for an agent-dispatched creation that lacks a
     * value the palette dialog would otherwise collect. This is a passive error notification — it
     * never blocks on user input — so the agent-facing operation fails cleanly and the message tells
     * the caller exactly which `args.*` to supply (the MCP layer relays tool errors to the agent).
     */
    private showAgentAmbiguity(action: string, hint: string): void {
        const base = this.sidecar.createNodeStrings().sidecarDisplayName;
        void vscode.window.showErrorMessage(`${base}: cannot ${action} without a required value — ${hint}.`);
    }

    private showSidecarFailure(action: string, result: SidecarInvocationResult): void {
        const detail = result.code ? ` (${result.code})` : '';
        const base = this.sidecar.createNodeStrings().sidecarDisplayName;
        const message = result.message?.trim() || `Operation failed while trying to ${action}.`;
        void vscode.window.showErrorMessage(`${base} failed to ${action}${detail}: ${message}`);
    }

    private uniqueInstanceName(base: string, taken: Set<string>): string {
        if (!taken.has(base)) {
            return base;
        }
        let idx = 2;
        while (taken.has(`${base}${idx}`)) {
            idx += 1;
        }
        return `${base}${idx}`;
    }
}
