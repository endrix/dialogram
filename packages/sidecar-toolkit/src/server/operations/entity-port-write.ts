/**
 * Where an edit of an entity's port is written.
 *
 * An instance's ports are its class's (its entity's): they are declared where
 * the class is, which is often not the diagram's file (a network that imports
 * its actors). So a port is added, retyped, renamed or deleted in the
 * entity's own file, the file the instance's definition is in
 * (`REFERENCED_URI`, marked `REFERENCED_IS_DEFINITION`), or the one the
 * property panel names (`entityDocumentUri`); in the diagram's file when
 * neither says.
 *
 * A port renamed or deleted in the entity's file is still named in this
 * diagram's connections. A sidecar that follows a port to where it is used
 * (`features.portUsesAcrossFiles`) is told where: this network, its file and
 * the instances of the entity in it (`usedIn`); a rename then writes the
 * diagram's file too. A sidecar that does not is not sent such an edit of an
 * entity in another file: the connections here would be left naming a port
 * the entity no longer has.
 */
import type { ModelState } from '@eclipse-glsp/server';
import * as vscode from 'vscode';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import type { ProducerWrite } from './producer-write';
import type { SidecarInvoker } from './sidecar-invoker';

/** The sidecar feature: it follows `usedIn` when a port is renamed or deleted. */
export const PORT_USES_ACROSS_FILES = 'portUsesAcrossFiles';

/** What an edit of an entity's port names it by. */
export interface EntityPortEdit {
    entityType: string;
    /** The entity's file, as the property panel read it off the instance. */
    entityDocumentUri?: string;
    /** The instance, or a port of it, the edit was made on. */
    elementId?: string;
}

interface ElementLike {
    id?: string;
    type?: string;
    args?: Record<string, unknown>;
    parent?: ElementLike;
    children?: ElementLike[];
}

function sameFile(a: string, b: string): boolean {
    try {
        return vscode.Uri.parse(a).fsPath === vscode.Uri.parse(b).fsPath;
    } catch {
        return a === b;
    }
}

function definitionFileOf(element: ElementLike | undefined): string | undefined {
    for (let at = element; at; at = at.parent) {
        const args = at.args;
        if (typeof args?.[WorkflowDiagramMetadata.ENTITY_NAME] === 'string' && !(at.type ?? '').startsWith('port')) {
            const uri = args[WorkflowDiagramMetadata.REFERENCED_URI];
            return args[WorkflowDiagramMetadata.REFERENCED_IS_DEFINITION] === true && typeof uri === 'string' && uri.trim() !== ''
                ? uri
                : undefined;
        }
    }
    return undefined;
}

/** The instances of `entityType` in the diagram: the names its nodes are drawn by. */
export function instancesOf(root: ElementLike | undefined, entityType: string): string[] {
    const names: string[] = [];
    const visit = (element: ElementLike | undefined): void => {
        if (!element) {
            return;
        }
        const args = element.args;
        if (!(element.type ?? '').startsWith('port') && args?.[WorkflowDiagramMetadata.ENTITY_TYPE] === entityType) {
            const name = args[WorkflowDiagramMetadata.ENTITY_NAME];
            if (typeof name === 'string' && name.trim() !== '' && !names.includes(name)) {
                names.push(name);
            }
        }
        for (const child of element.children ?? []) {
            visit(child);
        }
    };
    visit(root);
    return names;
}

/** The file the entity's ports are declared in: its own, when the diagram says; the diagram's otherwise. */
export function entityFileOf(modelState: Pick<ModelState, 'index' | 'root'>, diagramUri: string, edit: EntityPortEdit): string {
    const given = typeof edit.entityDocumentUri === 'string' ? edit.entityDocumentUri.trim() : '';
    if (given !== '') {
        return given;
    }
    const element = edit.elementId ? modelState.index.find(edit.elementId) as ElementLike | undefined : undefined;
    return definitionFileOf(element) ?? diagramUri;
}

/**
 * What to ask the producer for an edit of an entity's port (`op`, its
 * `args`): sent for the entity's own file, told where the port is used when
 * the edit renames or deletes it (`followsUses`); or why it is not asked.
 */
export async function entityPortWrite(
    sidecar: Pick<SidecarInvoker, 'hasFeature'>,
    modelState: Pick<ModelState, 'index' | 'root'>,
    diagramUri: string,
    edit: EntityPortEdit,
    payload: { op: string; args: Record<string, unknown> },
    followsUses: boolean
): Promise<ProducerWrite | { refused: string }> {
    const fileUri = entityFileOf(modelState, diagramUri, edit);
    if (!followsUses) {
        return { fileUri, payload };
    }
    const elsewhere = !sameFile(fileUri, diagramUri);
    if (!(await sidecar.hasFeature(diagramUri, PORT_USES_ACROSS_FILES))) {
        if (elsewhere) {
            const portName = String(payload.args['portName'] ?? '');
            const file = vscode.Uri.parse(fileUri).fsPath.split(/[\\/]/).pop() ?? fileUri;
            return {
                refused: `Port '${portName}' of '${edit.entityType}' is declared in ${file}, and its connections here would not follow it: edit it there.`
            };
        }
        return { fileUri, payload };
    }
    const root = modelState.root as unknown as ElementLike | undefined;
    const workflow = root?.args?.[WorkflowDiagramMetadata.WORKFLOW_NAME];
    const instances = instancesOf(root, edit.entityType);
    const usedIn = typeof workflow === 'string' && workflow.trim() !== '' && instances.length > 0
        ? [{ file: vscode.Uri.parse(diagramUri).fsPath, workflow, instances }]
        : [];
    return {
        fileUri,
        ...(elsewhere ? { alsoWrites: [diagramUri] } : {}),
        payload: { ...payload, args: { ...payload.args, usedIn } }
    };
}
