/**
 * What a double-click on a task with a `@viewer` annotation opens: the last
 * token on one of its inputs (open, open with a named editor, run a command
 * on it), the last tokens on two (diff), or a path the annotation declares.
 * A task without one is left to the platform, which opens its definition.
 *
 * The `@viewer` half of the former viewer listener, moved behind the
 * `NodeOpener` contribution point: the actions are the same
 * `NavigateToExternalTargetAction`s with the `wf:viewer*` arguments the host
 * turns into an editor, a diff or a command.
 */
import { Action, Args, GModelElement, NavigateToExternalTargetAction } from '@eclipse-glsp/sprotty';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import type { NodeOpener, NodeOpenerContext } from './node-opener';
import { settingsNamespace } from './profile';

const VIEWER_ACTION_ARG = 'wf:viewerAction';
const VIEWER_VIEW_TYPE_ARG = 'wf:viewerViewType';
const VIEWER_COMMAND_ARG = 'wf:viewerCommand';
const VIEWER_COMMAND_ARGS_ARG = 'wf:viewerCommandArgs';
const VIEWER_LEFT_URI_ARG = 'wf:viewerLeftUri';
const VIEWER_RIGHT_URI_ARG = 'wf:viewerRightUri';
const VIEWER_TITLE_ARG = 'wf:viewerTitle';
const VIEWER_MESSAGE_ARG = 'wf:viewerMessage';

type DefinitionAnnotation = {
    name: string;
    arguments?: Array<{ name: string; value: string }>;
};

const ABSOLUTE_URI = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

function parseStringLiteralish(text: string | undefined): string | undefined {
    if (typeof text !== 'string') {
        return undefined;
    }
    const trimmed = text.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

function parseStringListLiteralish(text: string | undefined): string[] | undefined {
    if (typeof text !== 'string') {
        return undefined;
    }

    const trimmed = text.trim();
    if (trimmed === '') {
        return undefined;
    }

    // Try JSON first (preferred: ["In", "Out"]).
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed) && parsed.every(x => typeof x === 'string')) {
                return parsed as string[];
            }
        } catch {
            // fall through
        }

        // Best-effort: extract quoted strings.
        const items: string[] = [];
        const re = /"([^"]+)"|'([^']+)'/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(trimmed))) {
            const s = m[1] ?? m[2];
            if (typeof s === 'string' && s.trim() !== '') {
                items.push(s);
            }
        }
        return items.length > 0 ? items : undefined;
    }

    return undefined;
}

function resolveViewerCommandArgs(args: string[] | undefined, targetUri: string, tokenPath: string): string[] | undefined {
    if (!args || args.length === 0) {
        return undefined;
    }
    return args.map(value => value
        .replace(/\{uri\}/g, targetUri)
        .replace(/\{path\}/g, tokenPath)
    );
}

/**
 * The target a declared path names, or undefined when it cannot be resolved.
 *
 * A relative path means "beside the file this was declared in", so with no such
 * file there is no answer — better said than guessed.
 */
function resolveDeclaredTarget(
    sourceUri: string | undefined,
    declaredPath: string
): string | undefined {
    if (ABSOLUTE_URI.test(declaredPath) || declaredPath.startsWith('/')) {
        return declaredPath;
    }
    return sourceUri ? resolveAgainstSource(sourceUri, declaredPath) : undefined;
}

/**
 * What to do with a target, given what it is.
 *
 * The kind is decided by whoever exported the graph, because that is where the
 * filesystem is visible — nothing here can tell a folder from a file by looking
 * at the string.
 */
function actionForDeclaredTarget(
    target: string,
    kind: string | undefined,
    viewType: string | undefined
): 'open' | 'openWith' | 'reveal' {
    // A directory has no editor to open in; revealing it is the operation that
    // exists for one.
    if (kind === 'folder') {
        return 'reveal';
    }
    // No editor is registered for a remote scheme, so openWith dead-ends there.
    // Plain open hands it to the host, which launches a browser.
    const isRemote = ABSOLUTE_URI.test(target) && !target.startsWith('file:');
    if (isRemote || !viewType) {
        return 'open';
    }
    return 'openWith';
}

/** A path declared in the diagram's own source file, resolved beside it. */
function resolveAgainstSource(sourceUri: string, relativePath: string): string {
    const lastSlash = sourceUri.lastIndexOf('/');
    const directory = lastSlash >= 0 ? sourceUri.slice(0, lastSlash) : sourceUri;
    return `${directory}/${relativePath}`;
}

function fileUriFromFsPath(fsPath: string): string {
    const p = fsPath.trim();
    if (p.startsWith('file:')) {
        return p;
    }
    // Assume absolute POSIX path (CLI produces absolute paths on Linux/macOS).
    const encoded = encodeURI(p);
    return encoded.startsWith('/') ? `file://${encoded}` : encoded;
}

function collectEdges(root: any): any[] {
    const out: any[] = [];
    const visit = (el: any): void => {
        if (!el) {
            return;
        }
        // Sprotty edges typically have type starting with 'edge:'
        if (typeof el.type === 'string' && el.type.startsWith('edge:')) {
            out.push(el);
        }
        const children = el.children as any[] | undefined;
        if (Array.isArray(children)) {
            for (const c of children) {
                visit(c);
            }
        }
    };
    visit(root);
    return out;
}

function incomingEdgesForTargetPort(edges: any[], targetPortId: string): any[] {
    return edges.filter(e => (e as any).targetId === targetPortId);
}

function bestIncomingEdgeForViewerInput(edges: any[], targetPortId: string): any | undefined {
    const candidates = incomingEdgesForTargetPort(edges, targetPortId);
    if (candidates.length === 0) {
        return undefined;
    }

    const withToken = candidates.filter(e => {
        const v = e?.args?.[WorkflowDiagramMetadata.VIEWER_LAST_TOKEN];
        return lastTokenAsPath(v) !== undefined;
    });

    const stableKey = (e: any): string => {
        const astPath = e?.args?.[WorkflowDiagramMetadata.AST_PATH];
        return typeof astPath === 'string' ? astPath : String(e?.id ?? '');
    };

    const pickFrom = (withToken.length > 0 ? withToken : candidates).slice();
    pickFrom.sort((a, b) => stableKey(a).localeCompare(stableKey(b)));
    return pickFrom[pickFrom.length - 1];
}

function lastTokenAsPath(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value;
    }
    if (Array.isArray(value) && value.length > 0) {
        const last = value[value.length - 1];
        return typeof last === 'string' ? last : undefined;
    }
    return undefined;
}

export class ViewerNodeOpener implements NodeOpener {
    readonly id = 'viewer';

    open(node: GModelElement, context: NodeOpenerContext): (Action | Promise<Action>)[] | undefined {
        if (node.type !== WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR) {
            return undefined;
        }
        const args = (node as unknown as { args?: Args }).args;
        if (!args) {
            return undefined;
        }
        const sourceUri = context.sourceUri;

        const defAnnotations = args[WorkflowDiagramMetadata.ENTITY_DEFINITION_ANNOTATIONS] as unknown;
        const annotations = Array.isArray(defAnnotations) ? (defAnnotations as DefinitionAnnotation[]) : [];
        const viewer = annotations.find(a => a && a.name === 'viewer');
        if (!viewer) {
            return undefined;
        }

        const argByName = new Map<string, string>();
        for (const a of viewer.arguments ?? []) {
            if (a && typeof a.name === 'string' && typeof a.value === 'string') {
                argByName.set(a.name, a.value);
            }
        }

        const action = (
            parseStringLiteralish(argByName.get('action'))
            ?? parseStringLiteralish(argByName.get('action_name'))
            ?? 'open'
        ).trim();
        const inputs = parseStringListLiteralish(argByName.get('inputs'));
        const viewType = parseStringLiteralish(argByName.get('viewType'))
            ?? parseStringLiteralish(argByName.get('view_type'));
        // Where the target comes from. Everything here has always resolved
        // through the last token on an input, which is right for a node whose
        // target is something it PRODUCED — it cannot exist before a run. A
        // node whose target is a path it declares is openable immediately, and
        // must not be told to go and run the workflow first.
        const source = parseStringLiteralish(argByName.get('source')) ?? 'token';
        const declaredPath = parseStringLiteralish(argByName.get('path'));
        // What the target IS — file, folder, http, url — settled by the
        // producer, which can see the filesystem. Nothing here can tell a
        // folder from a file by looking at the string.
        const resourceKind = parseStringLiteralish(argByName.get('kind'));
        const command = parseStringLiteralish(argByName.get('command'))
            ?? parseStringLiteralish(argByName.get('command_name'));
        const commandArgs = parseStringListLiteralish(argByName.get('args'))
            ?? parseStringListLiteralish(argByName.get('command_args'));
        const title = parseStringLiteralish(argByName.get('title'));

        const fail = (message: string): (Action | Promise<Action>)[] => [
            NavigateToExternalTargetAction.create({
                uri: context.sourceUri ?? 'file:///',
                args: {
                    [VIEWER_ACTION_ARG]: 'error',
                    [VIEWER_MESSAGE_ARG]: message
                }
            })
        ];

        if (source === 'declared') {
            if (!declaredPath) {
                return fail('@viewer(source="declared"): missing path="...".');
            }
            // Relative to the file the diagram was opened from, which is what a
            // declaration in that file means.
            const target = resolveDeclaredTarget(sourceUri, declaredPath);
            if (!target) {
                return fail(
                    `@viewer(source="declared"): cannot resolve the relative path `
                    + `"${declaredPath}" — the diagram has no source file to resolve it against.`
                );
            }
            const declaredAction = actionForDeclaredTarget(target, resourceKind, viewType);
            return [
                NavigateToExternalTargetAction.create({
                    uri: target,
                    args: {
                        [VIEWER_ACTION_ARG]: declaredAction,
                        ...(declaredAction === 'openWith'
                            ? { [VIEWER_VIEW_TYPE_ARG]: viewType as string }
                            : {})
                    }
                })
            ];
        }

        // Below here every route resolves its target from the last token on an
        // input, so an input is what it needs. This guard used to sit above the
        // declared branch, where it caught nodes that never wanted a token: a
        // node that declares its target has no inputs by nature, so it was told
        // to run the workflow first and could never be opened at all.
        if (!inputs || inputs.length === 0) {
            return fail('@viewer: missing inputs=[...] (run the workflow first, then double-click again).');
        }

        const root: any = (node as any).root;
        const edges = root ? collectEdges(root) : [];

        const overlayRunId = root?.args?.['wf:viewerOverlayRunId'];
        const overlayOutDir = root?.args?.['wf:viewerOverlayOutDir'];
        const hasOverlay = typeof overlayRunId === 'string' && overlayRunId.trim() !== '';

        const tokenByInputName = new Map<string, string>();
        for (const inputName of inputs) {
            const targetPortId = `${node.id}_port_${inputName}`;
            const incoming = bestIncomingEdgeForViewerInput(edges, targetPortId);
            const lastToken = incoming?.args?.[WorkflowDiagramMetadata.VIEWER_LAST_TOKEN];
            const tokenPath = lastTokenAsPath(lastToken);
            if (tokenPath) {
                tokenByInputName.set(inputName, tokenPath);
            }
        }

        const getTokenOrError = (name: string): string | undefined => {
            return tokenByInputName.get(name);
        };

        if (action === 'diff') {
            if (inputs.length !== 2) {
                return fail('@viewer(action="diff"): requires exactly 2 inputs in inputs=[...].');
            }
            const leftPath = getTokenOrError(inputs[0]);
            const rightPath = getTokenOrError(inputs[1]);
            if (!leftPath || !rightPath) {
                if (!hasOverlay) {
                    return fail(`Viewer diff: no run overlay found. Run the workflow successfully (CLI writes overlays under ${settingsNamespace()}.runOutputDir), then reopen/refresh the diagram.`);
                }
                return fail(`Viewer diff: missing last-token file(s) for inputs ${inputs.join(', ')} (overlay runId=${String(overlayRunId)}).`);
            }
            const leftUri = fileUriFromFsPath(leftPath);
            const rightUri = fileUriFromFsPath(rightPath);
            return [
                NavigateToExternalTargetAction.create({
                    uri: leftUri,
                    args: {
                        [VIEWER_ACTION_ARG]: 'diff',
                        [VIEWER_LEFT_URI_ARG]: leftUri,
                        [VIEWER_RIGHT_URI_ARG]: rightUri,
                        ...(title ? { [VIEWER_TITLE_ARG]: title } : {})
                    }
                })
            ];
        }

        // open/openWith: use first input.
        const firstInput = inputs[0];
        const tokenPath = getTokenOrError(firstInput);
        if (!tokenPath) {
            if (!hasOverlay) {
                return fail(`Viewer open: no run overlay found. Run the workflow successfully (CLI writes overlays under ${settingsNamespace()}.runOutputDir), then reopen/refresh the diagram.`);
            }
            const outDirInfo = typeof overlayOutDir === 'string' && overlayOutDir.trim() !== '' ? ` (outDir=${overlayOutDir})` : '';
            return fail(`Viewer open: missing last-token file for input '${firstInput}' (overlay runId=${String(overlayRunId)})${outDirInfo}.`);
        }

        const targetUri = fileUriFromFsPath(tokenPath);

        if (action === 'openWith') {
            if (!viewType) {
                return fail('@viewer(action="openWith"): missing viewType="...".');
            }
            return [
                NavigateToExternalTargetAction.create({
                    uri: targetUri,
                    args: {
                        [VIEWER_ACTION_ARG]: 'openWith',
                        [VIEWER_VIEW_TYPE_ARG]: viewType
                    }
                })
            ];
        }

        if (action === 'command') {
            if (!command) {
                return fail('@viewer(action="command"): missing command="...".');
            }
            const resolvedArgs = resolveViewerCommandArgs(commandArgs, targetUri, tokenPath);
            return [
                NavigateToExternalTargetAction.create({
                    uri: targetUri,
                    args: {
                        [VIEWER_ACTION_ARG]: 'command',
                        [VIEWER_COMMAND_ARG]: command,
                        ...(resolvedArgs
                            ? { [VIEWER_COMMAND_ARGS_ARG]: JSON.stringify(resolvedArgs) }
                            : {})
                    }
                })
            ];
        }

        // Default: open
        return [
            NavigateToExternalTargetAction.create({
                uri: targetUri,
                args: {
                    [VIEWER_ACTION_ARG]: 'open'
                }
            })
        ];
    }
}
