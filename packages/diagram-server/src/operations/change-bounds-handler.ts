/**
 * Change Bounds Operation Handler
 *
 * Persists node positions to the layout file when users move nodes.
 */

import 'reflect-metadata';

import { GEdge, GNode, GPort } from '@eclipse-glsp/graph';
import { ChangeBoundsOperation } from '@eclipse-glsp/protocol';
import { GModelChangeBoundsOperationHandler, GModelSerializer, GModelRecordingCommand, type Command, type MaybePromise } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import { URI } from 'vscode-uri';

import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { LayoutPersistenceService } from '../services/layout-persistence-service';
import { WORKFLOW_NETWORK_MODEL_KEY } from '@dialogram/shared';
import type { WorkflowDiagramModel } from '@dialogram/shared';
import {
    WORKFLOW_REROUTE_EDGES_AVOID_OVERLAPS_OPERATION_KIND,
    WorkflowRerouteEdgesAvoidOverlapsOperationHandler
} from './reroute-edges-avoid-overlaps-handler';

@injectable()
export class WorkflowChangeBoundsOperationHandler extends GModelChangeBoundsOperationHandler {
    @inject(LayoutPersistenceService)
    protected layoutPersistence!: LayoutPersistenceService;

    @inject(GModelSerializer)
    protected override serializer!: GModelSerializer;

    @inject(WorkflowRerouteEdgesAvoidOverlapsOperationHandler)
    protected rerouteHandler!: WorkflowRerouteEdgesAvoidOverlapsOperationHandler;

    override createCommand(operation: ChangeBoundsOperation): MaybePromise<Command | undefined> {
        return new GModelRecordingCommand(this.modelState, this.serializer, async () => {
            this.executeChangeBounds(operation);

            // Keyboard moves typically only send ChangeBounds; without an explicit reroute op,
            // edges keep stale routing points (visual glitches). Trigger a canonical incident-edge
            // reroute here, but debounce if a reroute just ran (e.g. after a mouse drag end).
            const lastClientRerouteAtMs = Number(this.modelState.get('workflow.lastClientRerouteAtMs') ?? 0);
            if (Number.isFinite(lastClientRerouteAtMs) && Date.now() - lastClientRerouteAtMs < 400) {
                return;
            }

            const incidentEdgeIds = this.collectIncidentEdgeIds(operation);
            if (incidentEdgeIds.length === 0) {
                return;
            }
            await this.rerouteHandler.runReroute({
                isOperation: true,
                kind: WORKFLOW_REROUTE_EDGES_AVOID_OVERLAPS_OPERATION_KIND,
                elementIds: incidentEdgeIds,
                preview: false,
                source: 'changeBounds'
            });
        });
    }

    protected override executeChangeBounds(operation: ChangeBoundsOperation): void {
        super.executeChangeBounds(operation);

        const diagramModel = this.modelState.get(WORKFLOW_NETWORK_MODEL_KEY) as WorkflowDiagramModel | undefined;
        if (!diagramModel) {
            return;
        }

        const workflowFilePath = URI.parse(diagramModel.documentUri).fsPath;
        const networkId = this.getNetworkId(diagramModel);

        void (async () => {
            const positions = (await this.layoutPersistence.loadLayout(workflowFilePath, networkId)) ?? new Map();

            for (const element of operation.newBounds) {
                const node = this.modelState.index.findByClass(element.elementId, GNode);
                if (!node || !node.position) {
                    continue;
                }
                const nodeName = this.getNodeName(node);
                if (!nodeName) {
                    continue;
                }
                const abs = this.getAbsolutePosition(node);
                positions.set(nodeName, { x: abs.x, y: abs.y });
            }

            // Only persist positions. Edge routing is handled by the canonical
            // server-side reroute operation (and is skipped for drag previews).
            this.layoutPersistence.saveLayout(workflowFilePath, networkId, positions);
        })();
    }

    private collectIncidentEdgeIds(operation: ChangeBoundsOperation): string[] {
        const movedNodeIds = new Set<string>();
        for (const b of operation.newBounds) {
            if (b?.elementId) {
                movedNodeIds.add(b.elementId);
            }
        }
        if (movedNodeIds.size === 0) {
            return [];
        }

        // Collect all ports belonging to moved nodes.
        const movedPortIds = new Set<string>();
        for (const nodeId of movedNodeIds) {
            const node = this.modelState.index.findByClass(nodeId, GNode);
            if (!node) {
                continue;
            }
            const visit = (el: any): void => {
                if (!el) {
                    return;
                }
                if (el instanceof GPort) {
                    movedPortIds.add(String(el.id));
                }
                const children = (el as any).children as any[] | undefined;
                if (Array.isArray(children)) {
                    for (const c of children) {
                        visit(c);
                    }
                }
            };
            visit(node);
        }
        if (movedPortIds.size === 0) {
            return [];
        }

        // Find all edges attached to any moved port.
        const result: string[] = [];
        const root: any = this.modelState.root;
        const walk = (el: any): void => {
            if (!el) {
                return;
            }
            if (el instanceof GEdge) {
                const sid = (el as any).sourceId as string | undefined;
                const tid = (el as any).targetId as string | undefined;
                if ((typeof sid === 'string' && movedPortIds.has(sid)) || (typeof tid === 'string' && movedPortIds.has(tid))) {
                    result.push(String(el.id));
                }
            }
            const children = (el as any).children as any[] | undefined;
            if (Array.isArray(children)) {
                for (const c of children) {
                    walk(c);
                }
            }
        };
        walk(root);
        return result;
    }

    private getAbsolutePosition(node: GNode): { x: number; y: number } {
        let x = node.position?.x ?? 0;
        let y = node.position?.y ?? 0;

        // GLSP/Sprotty node positions are relative to their parent.
        // Persist absolute positions so nesting (e.g. structure-if containment) doesn't break layout files.
        let parent: any = (node as any).parent;
        while (parent) {
            if (parent instanceof GNode && (parent as any).position) {
                const p = (parent as any).position as { x: number; y: number };
                x += p.x;
                y += p.y;
            }
            parent = parent.parent;
        }

        return { x, y };
    }

    private getNodeName(node: GNode): string | undefined {
        const args = (node as any).args as Record<string, unknown> | undefined;
        if (!args) {
            return undefined;
        }

        // Prefer stable identifiers for persistence.
        const astPath = args[WorkflowDiagramMetadata.AST_PATH];
        if (typeof astPath === 'string' && astPath.trim() !== '') {
            return astPath;
        }

        // Regular entity nodes have ENTITY_NAME
        const entityName = args[WorkflowDiagramMetadata.ENTITY_NAME];
        if (typeof entityName === 'string' && entityName.trim() !== '') {
            return entityName;
        }
        // Boundary ports have PORT_NAME
        const portName = args[WorkflowDiagramMetadata.PORT_NAME];
        if (typeof portName === 'string' && portName.trim() !== '') {
            return portName;
        }
        return undefined;
    }

    private getNetworkId(diagramModel: WorkflowDiagramModel): string {
        const explicit = (diagramModel as any)?.workflowName as string | undefined;
        if (typeof explicit === 'string' && explicit.trim() !== '') {
            return explicit.trim();
        }
        return 'unknown';
    }
}
