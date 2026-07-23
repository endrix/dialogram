/**
 * GModel conversion free functions
 *
 * Converts the language-mode diagram-model JSON shape (nodes/edges/labels/ports plain objects)
 * into GLSP GModel element instances, and cleans up legacy persisted edge fanout points.
 * Extracted verbatim from diagram-glsp-module.ts.
 */

import {
    GGraph,
    GModelRoot,
    GNode,
    GPort,
    GLabel,
    GEdge,
    GCompartment
} from '@eclipse-glsp/server';
import { WorkflowDiagramTypes, type WorkflowDiagramModel } from '@dialogram/shared';

type RoutePoint = { x: number; y: number };

export function cleanLegacyFanoutPoints(points: RoutePoint[]): RoutePoint[] {
    if (points.length < 3) {
        return points;
    }

    const cleaned: RoutePoint[] = [];
    for (const p of points) {
        const prev = cleaned[cleaned.length - 1];
        if (prev && prev.x === p.x && prev.y === p.y) {
            continue;
        }
        cleaned.push({ x: p.x, y: p.y });
    }

    const MAX_TINY_STEP = 8;
    const result: RoutePoint[] = [cleaned[0]];
    for (let i = 1; i < cleaned.length - 1; i++) {
        const prev = result[result.length - 1];
        const cur = cleaned[i];
        const next = cleaned[i + 1];

        const isVerticalLine = prev.x === cur.x && cur.x === next.x;
        const tinyVertical = isVerticalLine && Math.abs(cur.y - prev.y) <= MAX_TINY_STEP;

        if (tinyVertical) {
            continue;
        }

        result.push(cur);
    }

    result.push(cleaned[cleaned.length - 1]);
    return result;
}

export function convertToGModelRoot(diagramModel: WorkflowDiagramModel): GModelRoot {
    const graph = diagramModel.graph;

    const root = GGraph.builder()
        .id(graph.id)
        .type(WorkflowDiagramTypes.GRAPH)
        .addCssClass('cal-diagram')
        .addLayoutOptions((graph.layoutOptions || {}) as any)
        .addChildren(...convertChildren(graph.children || []))
        .build();

    if (graph.args) {
        for (const [key, value] of Object.entries(graph.args)) {
            root.args = root.args || {};
            root.args[key] = value as any;
        }
    }

    if (diagramModel.documentUri) {
        root.args = root.args || {};
        root.args.sourceUri = diagramModel.documentUri;
    }

    return root;
}

export function convertChildren(children: any[]): GModelRoot[] {
    return children.map(child => convertElement(child)).filter(Boolean) as GModelRoot[];
}

export function convertElement(element: any): GModelRoot | undefined {
    if (!element || !element.type) {
        return undefined;
    }

    const type = element.type;
    const id = element.id;
    const args = element.args || {};
    const cssClasses = element.cssClasses || [];

    if (type === WorkflowDiagramTypes.GRAPH) {
        return GGraph.builder()
            .id(id)
            .addCssClasses(...cssClasses)
            .addLayoutOptions((element.layoutOptions || {}) as any)
            .addChildren(...convertChildren(element.children || []))
            .build();
    }

    if (type.startsWith('node:') || type.includes('NODE')) {
        const builder = GNode.builder()
            .id(id)
            .type(type)
            .addCssClasses(...cssClasses)
            .addLayoutOptions((element.layoutOptions || {}) as any);

        if (element.layout) {
            builder.layout(element.layout);
        }
        if (element.position) {
            builder.position(element.position.x, element.position.y);
        }
        if (element.size) {
            builder.size(element.size.width, element.size.height);
        }
        if (element.children) {
            builder.addChildren(...convertChildren(element.children));
        }

        const node = builder.build();
        node.args = args;
        return node;
    }

    if (type.startsWith('port:') || type.includes('PORT')) {
        const layoutOptions = element.layoutOptions || args.layoutOptions || {};
        const builder = GPort.builder()
            .id(id)
            .type(type)
            .addCssClasses(...cssClasses)
            .addLayoutOptions(layoutOptions as any);

        if (element.position) {
            builder.position(element.position.x, element.position.y);
        }
        if (element.size) {
            builder.size(element.size.width, element.size.height);
        }
        if (element.children) {
            builder.addChildren(...convertChildren(element.children));
        }

        const port = builder.build();
        port.args = args;
        return port;
    }

    if (type.startsWith('edge:') || type.includes('EDGE')) {
        const builder = GEdge.builder()
            .id(id)
            .type(type)
            .sourceId(element.sourceId)
            .targetId(element.targetId)
            .addCssClasses(...cssClasses);

        if (element.children) {
            builder.addChildren(...convertChildren(element.children));
        }

        const edge = builder.build();
        edge.args = args;
        if (element.routingPoints && Array.isArray(element.routingPoints)) {
            edge.routingPoints = element.routingPoints;
        }
        return edge;
    }

    if (type.startsWith('label:') || type.includes('LABEL')) {
        const builder = GLabel.builder()
            .id(id)
            .type(type)
            .text(element.text || '')
            .addCssClasses(...cssClasses)
            .addLayoutOptions((element.layoutOptions || {}) as any);

        if (element.position) {
            builder.position(element.position.x, element.position.y);
        }
        if (element.size) {
            builder.size(element.size.width, element.size.height);
        }

        const label = builder.build();
        label.args = args;
        return label;
    }

    if (type.startsWith('compartment:') || type.startsWith('comp:') || type.includes('COMPARTMENT')) {
        const builder = GCompartment.builder()
            .id(id)
            .type(type)
            .addCssClasses(...cssClasses)
            .addLayoutOptions((element.layoutOptions || {}) as any);

        if (element.layout) {
            builder.layout(element.layout);
        }
        if (element.children) {
            builder.addChildren(...convertChildren(element.children));
        }

        const compartment = builder.build();
        compartment.args = args;
        return compartment;
    }

    const builder = GNode.builder()
        .id(id)
        .type(type)
        .addCssClasses(...cssClasses);

    if (element.children) {
        builder.addChildren(...convertChildren(element.children));
    }

    const fallback = builder.build();
    fallback.args = args;
    return fallback;
}
