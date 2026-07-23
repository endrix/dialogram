import { injectable } from 'inversify';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { tryParseWorkflowClipboardPayload } from './clipboard-payload';

export type PendingSelection = {
    entityNames: string[];
    boundaryPortNames: string[];
};

function generateUnique(base: string, used: Set<string>): string {
    if (!used.has(base)) {
        used.add(base);
        return base;
    }
    let i = 1;
    while (used.has(`${base}${i}`)) {
        i++;
    }
    const name = `${base}${i}`;
    used.add(name);
    return name;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function walk(root: any, visit: (el: any) => void): void {
    if (!root) {
        return;
    }
    visit(root);
    const children: any[] = Array.isArray(root.children) ? root.children : [];
    for (const c of children) {
        walk(c, visit);
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectUsedNames(modelRoot: any): { entities: Set<string>; boundaryPorts: Set<string> } {
    const entities = new Set<string>();
    const boundaryPorts = new Set<string>();

    walk(modelRoot, el => {
        const type: string | undefined = el?.type;
        const args: any = el?.args ?? {};

        if (
            type === WorkflowDiagramTypes.NODE_ACTOR ||
            type === WorkflowDiagramTypes.NODE_NETWORK ||
            type === WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR
        ) {
            const name = args[WorkflowDiagramMetadata.ENTITY_NAME];
            if (typeof name === 'string' && name.trim()) {
                entities.add(name);
            }
        }

        if (type === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT || type === WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT) {
            const name = args[WorkflowDiagramMetadata.PORT_NAME];
            if (typeof name === 'string' && name.trim()) {
                boundaryPorts.add(name);
            }
        }
    });

    return { entities, boundaryPorts };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findIdsToSelect(modelRoot: any, pending: PendingSelection): string[] {
    const wantedEntities = new Set(pending.entityNames);
    const wantedPorts = new Set(pending.boundaryPortNames);

    const ids: string[] = [];
    walk(modelRoot, el => {
        const type: string | undefined = el?.type;
        const args: any = el?.args ?? {};

        if (
            type === WorkflowDiagramTypes.NODE_ACTOR ||
            type === WorkflowDiagramTypes.NODE_NETWORK ||
            type === WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR
        ) {
            const name = args[WorkflowDiagramMetadata.ENTITY_NAME];
            if (typeof name === 'string' && wantedEntities.has(name)) {
                ids.push(el.id);
            }
        }

        if (type === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT || type === WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT) {
            const name = args[WorkflowDiagramMetadata.PORT_NAME];
            if (typeof name === 'string' && wantedPorts.has(name)) {
                ids.push(el.id);
            }
        }
    });

    return ids;
}

@injectable()
export class PostEditSelectionService {
    private pending: PendingSelection | undefined;

    // Called before dispatching PasteOperation.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prepareForPaste(clipboardData: Record<string, string>, modelRoot: any): void {
        const payload = tryParseWorkflowClipboardPayload(clipboardData);
        if (!payload) {
            this.pending = undefined;
            return;
        }

        const { entities: usedEntities, boundaryPorts: usedPorts } = collectUsedNames(modelRoot);

        const entityNames: string[] = [];
        const boundaryPortNames: string[] = [];

        for (const item of payload.items ?? []) {
            if (item.kind === 'entity') {
                const newName = generateUnique(item.entityName, usedEntities);
                entityNames.push(newName);
            }
            if (item.kind === 'boundaryPort') {
                const newName = generateUnique(item.portName, usedPorts);
                boundaryPortNames.push(newName);
            }
        }

        this.pending = {
            entityNames,
            boundaryPortNames
        };
    }

    // Called before dispatching cal.duplicate.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prepareForDuplicate(elementIds: string[], modelRoot: any): void {
        const { entities: usedEntities, boundaryPorts: usedPorts } = collectUsedNames(modelRoot);

        const entityNames: string[] = [];
        const boundaryPortNames: string[] = [];

        const index = modelRoot?.index;

        for (const id of elementIds) {
            const el: any = index?.getById ? index.getById(id) : undefined;
            if (!el) {
                continue;
            }
            const type: string | undefined = el?.type;
            const args: any = el?.args ?? {};

            if (
                type === WorkflowDiagramTypes.NODE_ACTOR ||
                type === WorkflowDiagramTypes.NODE_NETWORK ||
                type === WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR
            ) {
                const name = args[WorkflowDiagramMetadata.ENTITY_NAME];
                if (typeof name === 'string' && name.trim()) {
                    entityNames.push(generateUnique(name, usedEntities));
                }
            }

            if (type === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT || type === WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT) {
                const name = args[WorkflowDiagramMetadata.PORT_NAME];
                if (typeof name === 'string' && name.trim()) {
                    boundaryPortNames.push(generateUnique(name, usedPorts));
                }
            }
        }

        this.pending = {
            entityNames,
            boundaryPortNames
        };
    }

    // Called after SetModelAction has produced a new root.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    consumeMatchingIds(modelRoot: any): string[] {
        if (!this.pending) {
            return [];
        }
        const pending = this.pending;
        this.pending = undefined;
        return findIdsToSelect(modelRoot, pending);
    }
}
