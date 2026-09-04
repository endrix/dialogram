/**
 * Workflow Diagram Client Views
 * 
 * Sprotty view implementations for rendering Workflow diagram elements.
 * Uses snabbdom VNode for virtual DOM rendering.
 * 
 * Note: GLSP 2.5.x uses G-prefixed aliases (GShapeElement, GLabel, etc.)
 */

/** @jsx svg */
import type { NodeFamilySpec } from '@dialogram/shared';
import { injectable } from 'inversify';
import { VNode } from 'snabbdom';
import { html } from 'sprotty/lib/lib/jsx';
import {
    svg,
    IView,
    IViewArgs,
    RenderingContext,
    ShapeView,
    PolylineEdgeView,
    GShapeElement,
    SEdgeImpl,
    GLabel,
    setAttr,
    GCompartment
} from '@eclipse-glsp/client';
import {
    ActorNode,
    ExternalActorNode,
    NetworkNode,
    CollapsedConditionalNode,
    CollapsedArrayNode,
    ProxyNode,
    BoundaryInputNode,
    BoundaryOutputNode,
    WorkflowInputPort,
    WorkflowOutputPort,
    WorkflowEdge,
    WorkflowLabel,
    WorkflowNode,
    StructureIfNode
} from './model';
import { EDGE_OPEN_ANCHOR_X_ARG, EDGE_OPEN_ANCHOR_Y_ARG } from './edge-open-mouse-listener';
import { clientBehavior } from './profile';
import { isIncidentEdgeInActiveDrag } from './elk-live-drag-router';
import { BoundaryPortGeometry, WorkflowDiagramCss, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { WorkflowDiagramConstants } from '@dialogram/shared';

/** Walk to the model root; the drag-active window is tracked per root. */
function rootOfEdge(element: any): any {
    let current = element;
    while (current?.parent) {
        current = current.parent;
    }
    return current;
}

function absPos(element: any): { x: number; y: number } {
    let x = 0;
    let y = 0;
    let current = element;
    // Walk up parent chain; positions are relative in Sprotty.
    while (current) {
        if (current.position) {
            x += current.position.x || 0;
            y += current.position.y || 0;
        }
        current = current.parent;
    }
    return { x, y };
}

function centerOfRect(element: any): { x: number; y: number } {
    const p = absPos(element);
    const w = element.size?.width ?? element.bounds?.width ?? 0;
    const h = element.size?.height ?? element.bounds?.height ?? 0;
    return { x: p.x + w / 2, y: p.y + h / 2 };
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}

// Node dimensions (defaults)
const NODE_WIDTH = 140;
const NODE_HEIGHT = 80;
const HEADER_HEIGHT = WorkflowDiagramConstants.HEADER_HEIGHT_PX;
const PORT_RADIUS = 5;
const BOUNDARY_NODE_WIDTH = 80;
const BOUNDARY_NODE_HEIGHT = BoundaryPortGeometry.ROW_PITCH_PX;

// Icon size for center node icons
const NODE_ICON_SIZE = 36;

/**
 * The family a node belongs to, and what it looks like.
 *
 * Both come from the product: `task` and `network` are the platform's own
 * concepts, but a node that is an agent, a tool or a source belongs to one
 * product's taxonomy. Holding those here would mean the platform learning one
 * vocabulary and drawing every other product's graph plain.
 *
 * Declaration order decides, so a node in two families lands in the one listed
 * first — a node can carry the annotation that makes it openable AND the one
 * that says what it is, and only the second describes the node.
 */
function resolveNodeFamily(
    annotations: Array<{ name?: string; arguments?: Array<{ name?: string; value?: string }> }> | undefined,
    families: readonly NodeFamilySpec[]
): NodeFamilySpec | undefined {
    const byName = new Map((annotations ?? []).map(a => [a?.name ?? '', a]));
    return families.find(family => {
        const annotation = byName.get(family.annotation);
        if (!annotation) {
            return false;
        }
        if (!family.match) {
            return true;
        }
        const argument = annotation.arguments?.find(arg => arg?.name === family.match!.argument);
        // Values arrive serialized, so a string is quoted.
        const value = (argument?.value ?? '').replace(/^["']|["']$/g, '').toLowerCase();
        return family.match.oneOf.some(candidate => candidate.toLowerCase() === value);
    });
}

/** Internals reached by the family tests; not part of the module's surface. */

/**
 * Room left around the node for the ring's glow.
 *
 * A `foreignObject` clips what it holds, so the blur has to have somewhere to
 * go — without this the glow is cut off square at the node's edge.
 */
const RUN_RING_BLEED_PX = 6;

/**
 * The colour ring that turns around a node while it is running.
 *
 * A conic gradient, which is what this effect is everywhere else — and which
 * SVG cannot paint: `stroke` takes a colour or an SVG paint server, and there
 * is no conic one. So the ring is an HTML element inside a `foreignObject`,
 * where CSS can paint it directly. One element and a real gradient, rather
 * than the perimeter chopped into slices to fake the colour sweep.
 *
 * The ring is the padding of a box whose middle is masked away — the fill
 * covers the whole box, and excluding the content box leaves only the band.
 * Its thickness is that padding, and nothing else needs to know the node's
 * size.
 */
function renderRunRing(width: number, height: number): VNode {
    const bleed = RUN_RING_BLEED_PX;
    return svg('foreignObject', {
        class: { 'node-run-ring': true },
        attrs: {
            x: -bleed,
            y: -bleed,
            width: width + 2 * bleed,
            height: height + 2 * bleed
        }
    },
        // `html`, not `svg`: children of a foreignObject belong to the HTML
        // namespace, and an SVG-namespaced div renders nothing at all.
        html('div', { class: { 'node-run-ring-glow': true } }),
        html('div', { class: { 'node-run-ring-band': true } })
    );
}

/** Internals reached by the family and ring tests; not part of the module's surface. */
export const __testables = { resolveNodeFamily, renderRunRing, RUN_RING_BLEED_PX };

/**
 * Render a semi-transparent SVG icon centered in the node body (below the header).
 * Scales the icon from its native viewBox to NODE_ICON_SIZE.
 */
function renderNodeCenterIcon(
    family: NodeFamilySpec,
    nodeWidth: number,
    nodeHeight: number
): VNode {
    const iconSize = NODE_ICON_SIZE;
    // Center horizontally, center vertically in the body area below the header
    const bodyTop = HEADER_HEIGHT;
    const bodyHeight = nodeHeight - bodyTop;
    const cx = nodeWidth / 2;
    const cy = bodyTop + bodyHeight / 2;
    const def = family.icon!;
    const scale = iconSize / def.viewBox;

    return svg('g', {
        class: {
            'node-center-icon': true,
            [`node-icon-${family.id ?? family.annotation}`]: true
        },
        attrs: {
            transform: `translate(${cx - iconSize / 2}, ${cy - iconSize / 2}) scale(${scale})`
        }
    },
        ...def.paths.map(d =>
            svg('path', { attrs: { d } })
        )
    );
}

/**
 * Structure if node view - renders a read-only grouping box.
 * This is intentionally minimal; it does not change layout semantics.
 */
@injectable()
export class StructureIfNodeView extends ShapeView {
    override render(node: Readonly<StructureIfNode>, context: RenderingContext, args?: IViewArgs): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }

        const { width, height } = getNodeSize(node, 260, 170);
        const conditionText = (node as any).args?.[WorkflowDiagramMetadata.CONDITION_TEXT] as string | undefined;
        const headerText = conditionText ? `if ${conditionText.trim()}` : 'if …';

        return svg('g', {
            class: {
                'workflow-node': true,
                [WorkflowDiagramCss.NODE_STRUCTURE]: true,
                [WorkflowDiagramCss.NODE_STRUCTURE_IF]: true,
                selected: (node as any).selected,
                hover: (node as any).hoverFeedback,
                'read-only': true
            },
            attrs: {
                transform: `translate(${node.position.x}, ${node.position.y})`
            }
        },
            svg('rect', {
                class: { 'node-body': true, 'structure-if-body': true },
                attrs: {
                    x: 0, y: 0,
                    width, height,
                    rx: 6, ry: 6,
                    'stroke-dasharray': '4,2'
                }
            }),
            // Header
            svg('text', {
                class: { 'structure-if-header': true },
                attrs: {
                    x: 10,
                    y: 15,
                    'text-anchor': 'start',
                    'dominant-baseline': 'middle'
                }
            }, headerText),
            // Render children (ports/labels) if the server provides them
            ...context.renderChildren(node)
        );
    }
}

/**
 * Foreach structure node view - renders a read-only grouping box.
 */
@injectable()
export class StructureForeachNodeView extends ShapeView {
    override render(node: Readonly<any>, context: RenderingContext, args?: IViewArgs): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }

        const { width, height } = getNodeSize(node as any, 260, 140);
        const foreachText = (node as any).args?.[WorkflowDiagramMetadata.STRUCTURE_FOREACH] as string | undefined;
        const headerText = foreachText ? `foreach ${foreachText.trim()}` : 'foreach …';

        return svg('g', {
            class: {
                'workflow-node': true,
                [WorkflowDiagramCss.NODE_STRUCTURE]: true,
                [WorkflowDiagramCss.NODE_STRUCTURE_FOREACH]: true,
                selected: (node as any).selected,
                hover: (node as any).hoverFeedback,
                'read-only': true
            },
            attrs: {
                transform: `translate(${node.position.x}, ${node.position.y})`
            }
        },
            svg('rect', {
                class: { 'node-body': true, 'structure-foreach-body': true },
                attrs: {
                    x: 0, y: 0,
                    width, height,
                    rx: 6, ry: 6,
                    'stroke-dasharray': '3,2'
                }
            }),
            svg('text', {
                class: { 'structure-foreach-header': true },
                attrs: {
                    x: 10,
                    y: 15,
                    'text-anchor': 'start',
                    'dominant-baseline': 'middle'
                }
            }, headerText),
            ...context.renderChildren(node)
        );
    }
}

@injectable()
export class StructureIfBranchNodeView extends ShapeView {
    override render(node: Readonly<any>, context: RenderingContext, args?: IViewArgs): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }

        const { width, height } = getNodeSize(node as any, 200, 60);
        const branch = (node as any).args?.[WorkflowDiagramMetadata.STRUCTURE_BRANCH] as string | undefined;
        const label = branch && branch.trim() !== '' ? branch : 'branch';

        return svg('g', {
            class: {
                'workflow-node': true,
                [WorkflowDiagramCss.NODE_STRUCTURE]: true,
                [WorkflowDiagramCss.NODE_STRUCTURE_IF_BRANCH]: true,
                selected: (node as any).selected,
                hover: (node as any).hoverFeedback,
                'read-only': true
            },
            attrs: {
                transform: `translate(${node.position.x}, ${node.position.y})`
            }
        },
            svg('rect', {
                class: { 'structure-if-section': true, [label]: true },
                attrs: {
                    x: 0, y: 0,
                    width, height,
                    rx: 4, ry: 4,
                    'stroke-dasharray': '2,2'
                }
            }),
            svg('text', {
                class: { 'structure-if-section-label': true, [label]: true },
                attrs: {
                    x: 6,
                    y: 12,
                    'text-anchor': 'start',
                    'dominant-baseline': 'middle'
                }
            }, label),
            ...context.renderChildren(node)
        );
    }
}

@injectable()
export class StructureIfJoinNodeView extends ShapeView {
    override render(node: Readonly<any>, context: RenderingContext, args?: IViewArgs): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }

        const { width, height } = getNodeSize(node as any, 70, 34);
        const label = 'join';

        return svg('g', {
            class: {
                'workflow-node': true,
                [WorkflowDiagramCss.NODE_STRUCTURE]: true,
                [WorkflowDiagramCss.NODE_STRUCTURE_IF_JOIN]: true,
                selected: (node as any).selected,
                hover: (node as any).hoverFeedback,
                'read-only': true
            },
            attrs: {
                transform: `translate(${node.position.x}, ${node.position.y})`
            }
        },
            svg('rect', {
                class: { 'structure-if-join-body': true },
                attrs: {
                    x: 0, y: 0,
                    width, height,
                    rx: 4, ry: 4
                }
            }),
            svg('text', {
                class: { 'structure-if-join-label': true },
                attrs: {
                    x: width / 2,
                    y: height / 2,
                    'text-anchor': 'middle',
                    'dominant-baseline': 'middle'
                }
            }, label),
            ...context.renderChildren(node)
        );
    }
}

/**
 * Foreach join node view - merge point for derived outputs from foreach loop.
 * Renders as a small labeled box similar to if-join.
 */
@injectable()
export class StructureForeachJoinNodeView extends ShapeView {
    override render(node: Readonly<any>, context: RenderingContext, args?: IViewArgs): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }

        const { width, height } = getNodeSize(node as any, 70, 34);
        const label = 'join';

        return svg('g', {
            class: {
                'workflow-node': true,
                [WorkflowDiagramCss.NODE_STRUCTURE]: true,
                [WorkflowDiagramCss.NODE_STRUCTURE_FOREACH_JOIN]: true,
                selected: (node as any).selected,
                hover: (node as any).hoverFeedback,
                'read-only': true
            },
            attrs: {
                transform: `translate(${node.position.x}, ${node.position.y})`
            }
        },
            svg('rect', {
                class: { 'structure-foreach-join-body': true },
                attrs: {
                    x: 0, y: 0,
                    width, height,
                    rx: 4, ry: 4
                }
            }),
            svg('text', {
                class: { 'structure-foreach-join-label': true },
                attrs: {
                    x: width / 2,
                    y: height / 2,
                    'text-anchor': 'middle',
                    'dominant-baseline': 'middle'
                }
            }, label),
            ...context.renderChildren(node)
        );
    }
}

/**
 * Inline if node view - used inside foreach containers to explicitly represent per-iteration if statements.
 */
@injectable()
export class InlineIfNodeView extends ShapeView {
    override render(node: Readonly<any>, context: RenderingContext, args?: IViewArgs): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }

        const { width, height } = getNodeSize(node as any, 220, 56);
        const conditionText = (node as any).args?.[WorkflowDiagramMetadata.CONDITION_TEXT] as string | undefined;
        const label = conditionText ? `if ${conditionText.trim()}` : 'if …';

        return svg('g', {
            class: {
                'workflow-node': true,
                [WorkflowDiagramCss.NODE_STRUCTURE]: true,
                [WorkflowDiagramCss.NODE_STRUCTURE_IF_INLINE]: true,
                selected: (node as any).selected,
                hover: (node as any).hoverFeedback,
                'read-only': true
            },
            attrs: {
                transform: `translate(${node.position.x}, ${node.position.y})`
            }
        },
            svg('rect', {
                class: { 'inline-if-body': true },
                attrs: {
                    x: 0, y: 0,
                    width, height,
                    rx: 4, ry: 4,
                    'stroke-dasharray': '2,2'
                }
            }),
            svg('text', {
                class: { 'inline-if-label': true },
                attrs: {
                    x: 8,
                    y: 14,
                    'text-anchor': 'start',
                    'dominant-baseline': 'middle'
                }
            }, label),
            ...context.renderChildren(node)
        );
    }
}

/**
 * Get node size from the server-provided size property, falling back to bounds then defaults.
 * Server calculates exact dimensions based on ports and label width.
 * The 'size' property comes from the server, 'bounds' may be computed by Sprotty.
 */
/**
 * The node's visible body height, and the type label under it.
 *
 * The model's height RESERVES a band for the italic type label so that ELK and
 * the edge routers account for the space it occupies (see
 * NODE_FOOTER_LABEL_HEIGHT_PX). The label itself is drawn below the body, so
 * the body must be shortened by that same band — otherwise adding the reserve
 * would visibly grow every node that has a type label.
 */
function getNodeBody(
    node: { args?: Record<string, unknown> },
    size: { width: number; height: number }
): { width: number; height: number; footerLabel?: string } {
    const footerLabel = (node as any).args?.['wf:footerTypeLabel'] as string | undefined;
    const reserve = footerLabel ? WorkflowDiagramConstants.NODE_FOOTER_LABEL_HEIGHT_PX : 0;
    return { width: size.width, height: Math.max(1, size.height - reserve), footerLabel };
}

function getNodeSize(
    node: { id?: string; size?: { width: number; height: number }; bounds?: { width: number; height: number } },
    defaultWidth: number,
    defaultHeight: number
): { width: number; height: number } {
    // Prefer server-provided size over Sprotty-computed bounds
    if (node.size && node.size.width > 0 && node.size.height > 0) {
        return { width: node.size.width, height: node.size.height };
    }
    // Fall back to bounds if valid
    if (node.bounds && node.bounds.width > 0 && node.bounds.height > 0) {
        return { width: node.bounds.width, height: node.bounds.height };
    }
    // Default
    return { width: defaultWidth, height: defaultHeight };
}

/**
 * Get valid dimension, treating <= 0 as undefined (use default).
 * GLSP uses -1 as placeholder before layout computation.
 */
function validDimension(value: number | undefined, defaultValue: number): number {
    return (value !== undefined && value > 0) ? value : defaultValue;
}

// Port labels are now model-driven (server computes positions) and rendered as normal labels.

/**
 * View for Header Compartment.
 * Renders a colored background rectangle behind the labels.
 * Labels are centered horizontally within the header.
 * The header width is taken from the parent node to ensure it fills the full node width.
 */
@injectable()
export class HeaderCompartmentView extends ShapeView {
    override render(node: Readonly<GCompartment>, context: RenderingContext, args?: IViewArgs): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }
        
        // Use parent node's size (server-calculated) to ensure header fills the full node width
        // Prefer size over bounds since bounds may be computed larger by Sprotty
        const parent = node.parent;
        const parentSize = parent && 'size' in parent ? (parent as any).size : undefined;
        const parentBounds = parent && 'bounds' in parent ? (parent as any).bounds : undefined;
        const parentWidth = parentSize?.width > 0 ? parentSize.width : (parentBounds?.width ?? 0);
        const width = Math.max(0, parentWidth > 0 ? parentWidth : node.bounds.width);
        // Use header height from bounds, or default to 24 (standard header height)
        const height = node.bounds.height > 0 ? node.bounds.height : 24;
        
        // Render labels centered horizontally within the header
        // Use text-anchor: middle and position at center X
        const centerX = width / 2;
        const labelChildren: VNode[] = [];
        let labelY = height / 2; // Center vertically in header
        const labelSpacing = 14; // Vertical spacing between labels
        
        // Count labels first for proper vertical distribution
        const labels = node.children.filter(child => child instanceof GLabel);
        if (labels.length > 0) {
            const totalLabelHeight = labels.length * labelSpacing;
            labelY = (height - totalLabelHeight) / 2 + labelSpacing / 2 + 4; // Start position
        }
        
        for (const child of node.children) {
            if (child instanceof GLabel) {
                labelChildren.push(
                    svg('text', {
                        class: { 
                            'sprotty-label': true,
                            'header-label': true,
                            'label-name': child.type.includes('name'),
                            'label-type': child.type.includes('type'),
                            'label-badge': child.type.includes('badge')
                        },
                        attrs: {
                            x: centerX,
                            y: labelY,
                            'text-anchor': 'middle',
                            'dominant-baseline': 'middle'
                        }
                    }, child.text || '')
                );
                labelY += labelSpacing;
            }
        }
        
        // Build CSS classes - include header-compartment and any additional classes from node
        const cssClasses: Record<string, boolean> = { 'header-compartment': true };
        if (node.cssClasses && Array.isArray(node.cssClasses)) {
            for (const cls of node.cssClasses) {
                cssClasses[cls] = true;
            }
        }

        return svg('g', {
            class: cssClasses,
            attrs: {
                transform: `translate(${node.position.x}, ${node.position.y})`
            }
        },
            // Header background with rounded TOP corners only (square bottom),
            // so it matches the node body's rounded top (rx:4) instead of a
            // square rect poking past the rounded outline. Same bounding box —
            // no effect on size, ports, connections, or layout.
            svg('path', {
                class: { 'header-background': true },
                attrs: {
                    d: this.headerBackgroundPath(width, height)
                }
            }),
            ...labelChildren
        );
    }

    /**
     * SVG path for the header background: rounded TOP corners only (radius 4 to
     * match the node body's rx:4), square bottom so it butts cleanly against the
     * node body. Keeps the exact same w×h bounding box as the old rect.
     */
    protected headerBackgroundPath(width: number, height: number): string {
        const r = Math.max(0, Math.min(4, width / 2, height / 2));
        return `M 0,${height} V ${r} A ${r},${r} 0 0 1 ${r},0 H ${width - r} A ${r},${r} 0 0 1 ${width},${r} V ${height} Z`;
    }
}

/**
 * Base view for Workflow nodes
 */
@injectable()
export class WorkflowNodeView extends ShapeView {
    override render(node: Readonly<WorkflowNode>, context: RenderingContext, args?: IViewArgs): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }

        // Use server-provided size, not Sprotty-computed bounds
        const { width, height } = getNodeSize(node, NODE_WIDTH, NODE_HEIGHT);

        return svg('g', {
            class: { 'workflow-node': true, selected: node.selected, 'hover': node.hoverFeedback },
            attrs: {
                transform: `translate(${node.position.x}, ${node.position.y})`
            }
        },
            svg('rect', {
                class: { 'node-body': true },
                attrs: {
                    x: 0, y: 0,
                    width, height,
                    rx: 4, ry: 4
                }
            }),
            ...context.renderChildren(node)
        );
    }
}

/**
 * Actor node view - renders node body AND port labels
 * Port labels are rendered from the node (not the port) to avoid SVG clipping issues.
 */
@injectable()
export class ActorNodeView extends ShapeView {
    override render(node: Readonly<ActorNode>, context: RenderingContext, args?: IViewArgs): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }

        const { width, height } = getNodeSize(node, NODE_WIDTH, NODE_HEIGHT);
        const cssClasses = Array.isArray((node as any).cssClasses) ? (node as any).cssClasses as string[] : [];
        const isExecuting = Boolean((node as any).args?.[WorkflowDiagramMetadata.IS_EXECUTING]) || cssClasses.includes('cal-node-active');
        const isFinished = Boolean((node as any).args?.[WorkflowDiagramMetadata.IS_FINISHED]) || cssClasses.includes('cal-node-finished');
        const isErrored = Boolean((node as any).args?.[WorkflowDiagramMetadata.IS_ERRORED]) || cssClasses.includes('cal-node-error') || cssClasses.includes('cal-node-graph-error');
        const isWarned = !isErrored && cssClasses.includes('cal-node-graph-warning');

        const defAnnotations = ((node as any).args?.[WorkflowDiagramMetadata.ENTITY_DEFINITION_ANNOTATIONS] as Array<{ name?: string; arguments?: Array<{ name?: string; value?: string }> }> | undefined) ?? [];
        const family = resolveNodeFamily(defAnnotations, clientBehavior().nodeFamilies ?? []);
        const { height: bodyHeight, footerLabel } = getNodeBody(node as any, { width, height });
        const footerLabelNode = footerLabel
            ? svg('text', {
                class: { 'type-footer-label': true },
                attrs: {
                    x: width / 2,
                    y: bodyHeight + WorkflowDiagramConstants.NODE_FOOTER_LABEL_GAP_PX,
                    'text-anchor': 'middle',
                    'dominant-baseline': 'hanging'
                }
            }, footerLabel)
            : undefined;
        return svg('g', {
            class: {
                'workflow-node': true,
                'actor-node': true,
                'cal-node-active': isExecuting,
                'cal-node-finished': isFinished,
                'cal-node-error': isErrored,
                'cal-node-warning': isWarned,
                selected: node.selected,
                'hover': node.hoverFeedback
            },
            attrs: {
                transform: `translate(${node.position.x}, ${node.position.y})`
            }
        },
            svg('rect', {
                class: { 'node-body': true },
                attrs: {
                    x: 0, y: 0,
                    width, height: bodyHeight,
                    rx: 4, ry: 4
                }
            }),
            // Above the body so the travelling head is not painted over by it.
            ...(isExecuting ? [renderRunRing(width, bodyHeight)] : []),
            ...(family?.icon ? [renderNodeCenterIcon(family, width, bodyHeight)] : []),
            ...context.renderChildren(node),
            ...(footerLabelNode ? [footerLabelNode] : [])
        );
    }
}

/**
 * External actor node view - with port labels
 */
@injectable()
export class ExternalActorNodeView extends ShapeView {
    override render(node: Readonly<WorkflowNode>, context: RenderingContext, args?: IViewArgs): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }

        // Use server-provided size, not Sprotty-computed bounds
        const { width, height } = getNodeSize(node, NODE_WIDTH, NODE_HEIGHT);

        const defAnnotations = ((node as any).args?.[WorkflowDiagramMetadata.ENTITY_DEFINITION_ANNOTATIONS] as Array<{ name?: string; arguments?: Array<{ name?: string; value?: string }> }> | undefined)
            ?? [];
        const family = resolveNodeFamily(defAnnotations, clientBehavior().nodeFamilies ?? []);
        const cssClasses = Array.isArray((node as any).cssClasses) ? (node as any).cssClasses as string[] : [];
        const isExecuting = Boolean((node as any).args?.[WorkflowDiagramMetadata.IS_EXECUTING]) || cssClasses.includes('cal-node-active');
        const isFinished = Boolean((node as any).args?.[WorkflowDiagramMetadata.IS_FINISHED]) || cssClasses.includes('cal-node-finished');
        const isErrored = Boolean((node as any).args?.[WorkflowDiagramMetadata.IS_ERRORED]) || cssClasses.includes('cal-node-error') || cssClasses.includes('cal-node-graph-error');
        const isWarned = !isErrored && cssClasses.includes('cal-node-graph-warning');

        const { height: bodyHeight, footerLabel } = getNodeBody(node as any, { width, height });
        const footerLabelNode = footerLabel
            ? svg('text', {
                class: { 'type-footer-label': true },
                attrs: {
                    x: width / 2,
                    y: bodyHeight + WorkflowDiagramConstants.NODE_FOOTER_LABEL_GAP_PX,
                    'text-anchor': 'middle',
                    'dominant-baseline': 'hanging'
                }
            }, footerLabel)
            : undefined;
        return svg('g', {
            class: {
                'workflow-node': true,
                'external-actor-node': true,
                'external-actor-default': !family,
                ...(family ? { [`external-actor-${family.id ?? family.annotation}`]: true } : {}),
                'cal-node-active': isExecuting,
                'cal-node-finished': isFinished,
                'cal-node-error': isErrored,
                'cal-node-warning': isWarned,
                selected: node.selected,
                'hover': node.hoverFeedback
            },
            attrs: {
                transform: `translate(${node.position.x}, ${node.position.y})`
            }
        },
            svg('rect', {
                class: { 'node-body': true },
                attrs: {
                    x: 0, y: 0,
                    width, height: bodyHeight,
                    rx: 4, ry: 4
                }
            }),
            // Above the body so the travelling head is not painted over by it.
            ...(isExecuting ? [renderRunRing(width, bodyHeight)] : []),
            ...(family?.icon ? [renderNodeCenterIcon(family, width, bodyHeight)] : []),
            ...context.renderChildren(node),
            ...(footerLabelNode ? [footerLabelNode] : [])
        );
    }
}

/**
 * Network node view - with port labels
 */
@injectable()
export class NetworkNodeView extends ShapeView {
    override render(node: Readonly<NetworkNode>, context: RenderingContext, args?: IViewArgs): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }

        // Use server-provided size, not Sprotty-computed bounds
        const { width, height } = getNodeSize(node, NODE_WIDTH, NODE_HEIGHT);
        const cssClasses = Array.isArray((node as any).cssClasses) ? (node as any).cssClasses as string[] : [];
        const isExecuting = Boolean((node as any).args?.[WorkflowDiagramMetadata.IS_EXECUTING]) || cssClasses.includes('cal-node-active');
        const isFinished = Boolean((node as any).args?.[WorkflowDiagramMetadata.IS_FINISHED]) || cssClasses.includes('cal-node-finished');
        const isErrored = Boolean((node as any).args?.[WorkflowDiagramMetadata.IS_ERRORED]) || cssClasses.includes('cal-node-error') || cssClasses.includes('cal-node-graph-error');
        const isWarned = !isErrored && cssClasses.includes('cal-node-graph-warning');

        const { height: bodyHeight, footerLabel } = getNodeBody(node as any, { width, height });
        const footerLabelNode = footerLabel
            ? svg('text', {
                class: { 'type-footer-label': true },
                attrs: {
                    x: width / 2,
                    y: bodyHeight + WorkflowDiagramConstants.NODE_FOOTER_LABEL_GAP_PX,
                    'text-anchor': 'middle',
                    'dominant-baseline': 'hanging'
                }
            }, footerLabel)
            : undefined;
        return svg('g', {
            class: {
                'workflow-node': true,
                'network-node': true,
                'cal-node-active': isExecuting,
                'cal-node-finished': isFinished,
                'cal-node-error': isErrored,
                'cal-node-warning': isWarned,
                selected: node.selected,
                'hover': node.hoverFeedback
            },
            attrs: {
                transform: `translate(${node.position.x}, ${node.position.y})`
            }
        },
            svg('rect', {
                class: { 'node-body': true },
                attrs: {
                    x: 0, y: 0,
                    width, height: bodyHeight,
                    rx: 4, ry: 4
                }
            }),
            // Above the body so the travelling head is not painted over by it.
            ...(isExecuting ? [renderRunRing(width, bodyHeight)] : []),
            ...context.renderChildren(node),
            ...(footerLabelNode ? [footerLabelNode] : [])
        );
    }
}

/**
 * Collapsed conditional node view (EntityIfExpr)
 */
@injectable()
export class CollapsedConditionalNodeView extends WorkflowNodeView {
    override render(node: Readonly<CollapsedConditionalNode>, context: RenderingContext, args?: IViewArgs): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }

        // Use server-provided size, not Sprotty-computed bounds
        const { width, height } = getNodeSize(node, NODE_WIDTH, NODE_HEIGHT);

        return svg('g', {
            class: {
                'workflow-node': true,
                'collapsed-node': true,
                'conditional-node': true,
                selected: node.selected,
                'hover': node.hoverFeedback,
                'read-only': true
            },
            attrs: {
                transform: `translate(${node.position.x}, ${node.position.y})`
            }
        },
            // Dashed border to indicate collapsed
            svg('rect', {
                class: { 'node-body': true, 'collapsed-border': true },
                attrs: {
                    x: 0, y: 0,
                    width, height,
                    rx: 4, ry: 4,
                    'stroke-dasharray': '4,2'
                }
            }),
            // "if" badge
            svg('rect', {
                class: { 'badge': true, 'conditional-badge': true },
                attrs: {
                    x: width - 28, y: 4,
                    width: 24, height: 16,
                    rx: 3
                }
            }),
            svg('text', {
                class: { 'badge-text': true },
                attrs: {
                    x: width - 16, y: 15,
                    'text-anchor': 'middle',
                    'font-size': '10px'
                }
            }, 'if'),
            // Children
            ...context.renderChildren(node)
        );
    }
}

/**
 * Collapsed array node view (EntityListExpr)
 */
@injectable()
export class CollapsedArrayNodeView extends WorkflowNodeView {
    override render(node: Readonly<CollapsedArrayNode>, context: RenderingContext, args?: IViewArgs): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }

        // Use server-provided size, not Sprotty-computed bounds
        const { width, height } = getNodeSize(node, NODE_WIDTH, NODE_HEIGHT);

        return svg('g', {
            class: {
                'workflow-node': true,
                'array-node': true,
                selected: node.selected,
                'hover': node.hoverFeedback,
                'read-only': true
            },
            attrs: {
                transform: `translate(${node.position.x}, ${node.position.y})`
            }
        },
            // Render like a regular entity node (solid border / no badge)
            svg('rect', {
                class: { 'node-body': true },
                attrs: {
                    x: 0, y: 0,
                    width, height,
                    rx: 4, ry: 4
                }
            }),
            // Children
            ...context.renderChildren(node)
        );
    }
}

/**
 * Proxy node view for indexed entity references like c[i], c[nSegs-1].
 * Renders similarly to entity nodes but with a dashed border to indicate
 * it's a loop-variable-dependent reference.
 */
@injectable()
export class ProxyNodeView extends ShapeView {
    override render(node: Readonly<any>, context: RenderingContext, args?: IViewArgs): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }

        // Use server-provided size, not Sprotty-computed bounds
        const { width, height } = getNodeSize(node, NODE_WIDTH, NODE_HEIGHT);

        return svg('g', {
            class: {
                'workflow-node': true,
                'workflow-node-proxy': true,
                'proxy-node': true,
                selected: node.selected,
                'hover': node.hoverFeedback,
                'read-only': true
            },
            attrs: {
                transform: `translate(${node.position.x}, ${node.position.y})`
            }
        },
            // Dashed border to indicate this is a proxy/indexed reference
            svg('rect', {
                class: { 'node-body': true, 'proxy-border': true },
                attrs: {
                    x: 0, y: 0,
                    width, height,
                    rx: 4, ry: 4,
                    'stroke-dasharray': '4,2'
                }
            }),
            // Children (header compartment, ports, labels)
            ...context.renderChildren(node)
        );
    }
}

/**
 * Boundary input port node (left margin) - network's input exposed to internal entities
 * Styled as a terminal connector shape with port name centered
 */
/** Whether an edge terminates on a boundary port, whose glyph is already an arrow. */
function endsAtBoundaryPort(edge: Readonly<SEdgeImpl>): boolean {
    let element: any = (edge as any).target;
    while (element) {
        if (element.type === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT
            || element.type === WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT) {
            return true;
        }
        element = element.parent;
    }
    return false;
}

/** One of a boundary node's own text values, from the args the server set. */
function boundaryText(node: unknown, key: string): string {
    const value = (node as { args?: Record<string, unknown> })?.args?.[key];
    return typeof value === 'string' ? value : '';
}

/**
 * A boundary port, drawn on the wire's axis: glyph, name and type as one object.
 *
 * An input is a bare arrow pointing into the diagram; an output is an arrow
 * that stops against a bar, the way a terminal is drawn on a schematic.
 *
 * The hit target is deliberately far larger than the arrow, and deliberately
 * only as tall as one row: an 8px arrow cannot be grabbed reliably, and
 * including the type line would move the drag target whenever the type is
 * hidden at low zoom. It also carries selection now that there is no body to
 * outline.
 *
 * The x it is built at must agree with where the SERVER placed the port, or the
 * wire misses the arrow — both read `BoundaryPortGeometry` for exactly that
 * reason.
 */
function boundaryPort(isInput: boolean, nodeWidth: number, name: string, type: string): VNode[] {
    const G = BoundaryPortGeometry;
    const axis = G.AXIS_Y_PX;
    const arrow = isInput ? G.SOURCE_ARROW : G.SINK_ARROW;
    // Inputs occupy the node's right edge, outputs its left.
    const glyphX = isInput ? nodeWidth - G.glyphWidth(true) : 0;
    const top = axis - arrow.height / 2;
    const tipX = glyphX + arrow.width;
    const textX = isInput ? nodeWidth - G.textOffset(true) : G.textOffset(false);
    const anchor = isInput ? 'end' : 'start';

    // How far the text reaches, from the glyph outward. Approximate by design —
    // see approximateTextWidth; it sizes these rectangles and nothing else.
    const nameReach = G.approximateTextWidth(name, G.NAME_FONT_PX);
    const textReach = Math.max(nameReach, G.approximateTextWidth(type, G.TYPE_FONT_PX));
    const spanFrom = (reach: number): { x: number; width: number } => isInput
        ? { x: textX - reach, width: reach + G.textOffset(true) }
        : { x: 0, width: G.textOffset(false) + reach };

    // Two rectangles, because clicking and highlighting are not the same extent
    // — the diagram already draws that distinction and the port was not.
    // Clicking the type selects its port, exactly as clicking a node's type
    // caption selects the node; but a node's hover tints only its body, leaving
    // the caption outside, so a port highlights only its glyph and name.
    const hit = spanFrom(textReach);
    const highlight = { ...spanFrom(nameReach), height: G.NAME_LINE_HEIGHT_PX };

    const parts: VNode[] = [
        // The whole row is the grab target, so the name belongs to the port
        // rather than sitting beside it — see HIT_HEIGHT_PX. First in the list
        // so it paints behind the glyph and the text.
        //
        // Sized to the text rather than to the node box. The box is a fixed 120
        // so that the glyph columns line up, which has nothing to do with how
        // wide any particular port reads: using it made a short name leave dead
        // clickable space beside it, while a long one overflowed the box and
        // stopped being clickable at exactly the point it became visible.
        svg('rect', {
            class: { 'boundary-hit': true },
            attrs: { x: hit.x, y: 0, width: hit.width, height: G.HIT_HEIGHT_PX }
        }),
        svg('rect', {
            class: { 'boundary-highlight': true },
            attrs: { x: highlight.x, y: 0, width: highlight.width, height: highlight.height }
        }),
        // Both arrows point the way the data flows: into the diagram for an
        // input, into the bar for an output.
        svg('path', {
            class: { 'boundary-glyph': true },
            attrs: { d: `M ${glyphX} ${top} L ${tipX} ${axis} L ${glyphX} ${top + arrow.height} Z` }
        })
    ];
    if (!isInput) {
        parts.push(svg('rect', {
            class: { 'boundary-glyph': true, 'boundary-glyph-bar': true },
            attrs: {
                x: tipX,
                y: axis - G.SINK_BAR.height / 2,
                width: G.SINK_BAR.width,
                height: G.SINK_BAR.height
            }
        }));
    }

    // The name belongs to the symbol, not beside it. It used to be a child
    // label element positioned by its own view, which is what made it drift off
    // the glyph — an element with no layout feature still carries a stale
    // position, and anything that reads it moves the text. Drawn here it cannot
    // disagree with the arrow it labels.
    parts.push(svg('text', {
        class: { 'boundary-name': true },
        // As an inline style, NOT only as an attribute. A presentation attribute
        // loses to any stylesheet rule, and upstream GLSP/Sprotty styles set
        // `text-anchor: middle` — which is why the name kept rendering centred
        // on its own glyph however the attribute was set. The port labels below
        // hit this years ago and say so; this is the same fix.
        style: { 'text-anchor': anchor },
        attrs: { x: textX, y: axis, 'text-anchor': anchor, 'dominant-baseline': 'middle' }
    }, name));

    // The type reuses the nodes' own footer treatment, so a port's type reads
    // exactly like an entity's does rather than inventing a second convention.
    if (type) {
        parts.push(svg('text', {
            class: { 'type-footer-label': true, 'boundary-type': true },
            style: { 'text-anchor': anchor },
            attrs: { x: textX, y: G.TYPE_Y_PX, 'text-anchor': anchor, 'dominant-baseline': 'middle' }
        }, type));
    }
    return parts;
}

@injectable()
export class BoundaryInputNodeView extends ShapeView {
    override render(node: Readonly<BoundaryInputNode>, context: RenderingContext, args?: IViewArgs): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }

        // Use server-provided size, not Sprotty-computed bounds
        const { width } = getNodeSize(node, BOUNDARY_NODE_WIDTH, BOUNDARY_NODE_HEIGHT);

        return svg('g', {
            class: {
                'boundary-node': true,
                'boundary-input': true,
                selected: node.selected,
                'hover': node.hoverFeedback
            },
            attrs: {
                transform: `translate(${node.position.x}, ${node.position.y})`
            }
        },
            // No body: the symbol on the axis IS the port — glyph, name and
            // type together, drawn as one thing.
            ...boundaryPort(true, width, boundaryText(node, WorkflowDiagramMetadata.PORT_NAME),
                boundaryText(node, WorkflowDiagramMetadata.PORT_TYPE)),
            // The port element (an anchor only) and the label elements, which
            // render nothing — see WorkflowLabelView.
            ...context.renderChildren(node)
        );
    }
}

/**
 * Boundary output port node (right margin) - network's output receiving from internal entities
 * Styled as a terminal connector shape with port name centered
 */
@injectable()
export class BoundaryOutputNodeView extends ShapeView {
    override render(node: Readonly<BoundaryOutputNode>, context: RenderingContext, args?: IViewArgs): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }

        // Use server-provided size, not Sprotty-computed bounds
        const { width } = getNodeSize(node, BOUNDARY_NODE_WIDTH, BOUNDARY_NODE_HEIGHT);

        return svg('g', {
            class: {
                'boundary-node': true,
                'boundary-output': true,
                selected: node.selected,
                'hover': node.hoverFeedback
            },
            attrs: {
                transform: `translate(${node.position.x}, ${node.position.y})`
            }
        },
            // No body — see the input view above.
            ...boundaryPort(false, width, boundaryText(node, WorkflowDiagramMetadata.PORT_NAME),
                boundaryText(node, WorkflowDiagramMetadata.PORT_TYPE)),
            ...context.renderChildren(node)
        );
    }
}

/**
 * Input port view (left side of node)
 * Port position is managed by ELK layout.
 */
@injectable()
export class WorkflowInputPortView extends ShapeView {
    override render(port: Readonly<WorkflowInputPort>, context: RenderingContext, args?: IViewArgs): VNode {
        const portWidth = port.size?.width ?? WorkflowDiagramConstants.PORT_WIDTH_PX;
        const portHeight = port.size?.height ?? WorkflowDiagramConstants.PORT_HEIGHT_PX;
        const cornerRadius = 1;
        const isArray = port.multiplicity !== undefined && port.multiplicity > 1;

        // Non-visual hit target to make connecting reliable without changing visible port size.
        const hitSize = Math.max(14, portWidth, portHeight);
        // IMPORTANT: Do not expand the hit area past the node boundary.
        // If the hit target extends outward, edge anchoring can use the larger bounds,
        // which makes connections (and thus labels) look "far" from the visible port.
        // For input ports (left side), expand inward (to the right).
        const hitX = 0;
        const hitY = (portHeight - hitSize) / 2;
        
        const children: VNode[] = [
            svg('rect', {
                class: { 'port-hit-area': true },
                attrs: {
                    x: hitX,
                    y: hitY,
                    width: hitSize,
                    height: hitSize,
                    rx: cornerRadius,
                    ry: cornerRadius,
                    'pointer-events': 'all'
                }
            }),
            svg('rect', {
                class: { 'port-shape': true, 'array-port': isArray },
                attrs: {
                    x: 0,
                    y: 0,
                    width: portWidth,
                    height: portHeight,
                    rx: cornerRadius,
                    ry: cornerRadius
                }
            })
        ];

        // Multiplicity badge (for array ports)
        if (isArray) {
            children.push(svg('text', {
                class: { 'multiplicity-badge': true },
                attrs: {
                    x: -4,
                    y: portHeight + 8,
                    'text-anchor': 'end',
                    'font-size': '8px'
                }
            }, `[${port.multiplicity}]`));
        }

        return svg('g', {
            class: {
                'workflow-port': true,
                'input-port': true,
                'cal-port-control': (port as any).args?.['wf:portRole'] === 'control',
                selected: port.selected,
                'hover': port.hoverFeedback,
                'unresolved': port.hasUnresolvedGenerics
            },
            attrs: {
                transform: `translate(${port.position.x}, ${port.position.y})`,
                'data-cal-port-id': port.id,
                'data-cal-port-direction': 'input'
            }
        }, 
            ...context.renderChildren(port),
            ...children
        );
    }
}

/**
 * Output port view (right side of node)
 * Port position is managed by ELK layout.
 */
@injectable()
export class WorkflowOutputPortView extends ShapeView {
    override render(port: Readonly<WorkflowOutputPort>, context: RenderingContext, args?: IViewArgs): VNode {
        const portWidth = port.size?.width ?? WorkflowDiagramConstants.PORT_WIDTH_PX;
        const portHeight = port.size?.height ?? WorkflowDiagramConstants.PORT_HEIGHT_PX;
        const cornerRadius = 1;
        const isArray = port.multiplicity !== undefined && port.multiplicity > 1;

        // Non-visual hit target to make connecting reliable without changing visible port size.
        const hitSize = Math.max(14, portWidth, portHeight);
        // For output ports (right side), expand inward (to the left) so the hit area right edge
        // matches the visible port right edge.
        const hitX = portWidth - hitSize;
        const hitY = (portHeight - hitSize) / 2;
        
        const children: VNode[] = [
            svg('rect', {
                class: { 'port-hit-area': true },
                attrs: {
                    x: hitX,
                    y: hitY,
                    width: hitSize,
                    height: hitSize,
                    rx: cornerRadius,
                    ry: cornerRadius,
                    'pointer-events': 'all'
                }
            }),
            svg('rect', {
                class: { 'port-shape': true, 'output': true, 'array-port': isArray },
                attrs: {
                    x: 0,
                    y: 0,
                    width: portWidth,
                    height: portHeight,
                    rx: cornerRadius,
                    ry: cornerRadius
                }
            })
        ];

        // Multiplicity badge
        if (isArray) {
            children.push(svg('text', {
                class: { 'multiplicity-badge': true },
                attrs: {
                    x: portWidth + 8,
                    y: portHeight + 8,
                    'text-anchor': 'start',
                    'font-size': '8px'
                }
            }, `[${port.multiplicity}]`));
        }

        return svg('g', {
            class: {
                'workflow-port': true,
                'output-port': true,
                'cal-port-control': (port as any).args?.['wf:portRole'] === 'control',
                selected: port.selected,
                'hover': port.hoverFeedback,
                'unresolved': port.hasUnresolvedGenerics
            },
            attrs: {
                transform: `translate(${port.position.x}, ${port.position.y})`,
                'data-cal-port-id': port.id,
                'data-cal-port-direction': 'output'
            }
        }, 
            ...context.renderChildren(port),
            ...children
        );
    }
}

/**
 * Edge view - orthogonal routing with arrows
 */
@injectable()
export class WorkflowEdgeView extends PolylineEdgeView {
    protected formatViewerLastTokenForTooltip(value: unknown): string | undefined {
        if (value === undefined || value === null) {
            return undefined;
        }
        if (typeof value === 'string') {
            return value;
        }
        if (Array.isArray(value)) {
            const last = value.length > 0 ? value[value.length - 1] : undefined;
            if (typeof last === 'string') {
                return last;
            }
        }
        try {
            const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
            return text.length > 500 ? `${text.slice(0, 500)}…` : text;
        } catch {
            return String(value);
        }
    }

    protected shouldDebugEdgePoints(): boolean {
        return (globalThis as any)?.WORKFLOW_DEBUG_EDGE_POINTS === true;
    }

    protected renderDebugPoints(
        points: Array<{ x: number; y: number }>,
        className: string,
        r: number,
        fill: string,
        stroke: string
    ): VNode[] {
        const out: VNode[] = [];
        for (const p of points) {
            if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
                continue;
            }
            out.push(svg('circle', {
                class: { [className]: true },
                attrs: {
                    cx: p.x,
                    cy: p.y,
                    r,
                    // `.sprotty-edge` sets `fill: none` on the parent <g>, which SVG inherits.
                    // Set explicit colors so the debug overlay is actually visible.
                    fill,
                    stroke,
                    'stroke-width': 0.8
                }
            }));
        }
        return out;
    }
    protected isRoutingHandleEditActive(edge: SEdgeImpl): boolean {
        const children = (edge as any).children as Array<any> | undefined;
        if (!children || children.length === 0) {
            return false;
        }
        // Different GLSP client builds expose slightly different flags during interaction.
        // We keep this conservative: only treat it as "active" when a handle is being
        // interacted with (drag/hover/selection).
        return children.some(child => {
            if (!child) {
                return false;
            }
            return child.editMode === true
                || child.dragging === true
                || child.selected === true
                || child.hoverFeedback === true
                || child.hover === true
                || (Array.isArray(child.cssClasses) && (child.cssClasses.includes('mouseover') || child.cssClasses.includes('selected')));
        });
    }

    protected dedupeSegments(segments: { x: number; y: number }[], eps: number = 0.001): { x: number; y: number }[] {
        if (segments.length <= 1) {
            return segments;
        }
        const eq = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
            Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;
        const result: { x: number; y: number }[] = [];
        for (const p of segments) {
            if (result.length === 0 || !eq(result[result.length - 1], p)) {
                result.push(p);
            }
        }
        return result;
    }

    protected offsetPointAlongSegment(
        from: { x: number; y: number },
        to: { x: number; y: number },
        alongPx: number,
        perpPx: number
    ): { x: number; y: number } {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        // Perpendicular (left-hand)
        const px = -uy;
        const py = ux;
        return {
            x: from.x + ux * alongPx + px * perpPx,
            y: from.y + uy * alongPx + py * perpPx
        };
    }

    protected computeVisualRoute(
        edge: SEdgeImpl,
        segments: { x: number; y: number }[]
    ): { computedSegments: { x: number; y: number }[]; handleEditActive: boolean } {
        const handleEditActive = this.isRoutingHandleEditActive(edge);
        
        let computedSegments = segments;

        // Clear any previous render-frame fallback flags so selection/deselection
        // cannot “stick” a dashed fallback style.
        delete (edge as any)._isFallingBack;
        delete (edge as any)._debugReason;

        // Drag preview and final routes are both computed server-side by ELK.
        // The client renders server-provided segments without local rerouting.

        // "Start from scratch": do not rewrite endpoints, do not do client-side ELK preview,
        // and do not freeze/cache routes. Just render what the model provides.
        return { computedSegments, handleEditActive };
    }

    protected fallbackRouteFromEndpoints(edge: Readonly<SEdgeImpl>): { x: number; y: number }[] | undefined {
        const root: any = (edge as any).root;
        const index: any = root?.index;
        const sourceId: string | undefined = (edge as any).sourceId;
        const targetId: string | undefined = (edge as any).targetId;
        if (!index || typeof sourceId !== 'string' || typeof targetId !== 'string') {
            return undefined;
        }

        const getById = (id: string): any | undefined =>
            (typeof index.getById === 'function' ? index.getById(id) : undefined)
            ?? (typeof index.get === 'function' ? index.get(id) : undefined);

        const sourceEl = getById(sourceId);
        const targetEl = getById(targetId);
        if (!sourceEl || !targetEl) {
            return undefined;
        }

        // Use centers if bounds/size exist; fall back to absolute position.
        const a = (sourceEl.size || sourceEl.bounds) ? centerOfRect(sourceEl) : absPos(sourceEl);
        const b = (targetEl.size || targetEl.bounds) ? centerOfRect(targetEl) : absPos(targetEl);

        if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) {
            return undefined;
        }
        return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
    }

    override render(edge: Readonly<SEdgeImpl>, context: RenderingContext, args?: IViewArgs): VNode | undefined {
        // Two tiers. The server's polyline is authoritative: computed with the
        // whole graph in view and persisted, so it wins whenever it exists.
        //
        // The exception is an edge attached to a node being dragged right now.
        // Its stored route was computed for where that node used to be, so
        // drawing it leaves the edge lagging the cursor — which is what produced
        // the straight port-to-port diagonals during a drag. For those edges the
        // live client router takes over until the drag settles and the server's
        // route arrives.
        //
        // Handing over is safe because both tiers run libavoid over the same
        // anchors (@dialogram/shared portAnchor), so the two agree and the swap
        // is not visible. That shared geometry is what made this possible: the
        // client router previously computed anchors differently, which is why
        // this code used to bypass the router registry entirely.
        const serverRoute = (edge as any).routingPoints as { x: number; y: number }[] | undefined;
        const hasServerRoute = Array.isArray(serverRoute) && serverRoute.length >= 2;
        const liveRouted = isIncidentEdgeInActiveDrag(rootOfEdge(edge), String((edge as any).id));
        const route = hasServerRoute && !liveRouted
            ? serverRoute
            : ((this.edgeRouterRegistry?.route(edge as any, args) as any) ?? serverRoute ?? []);

        // Some intermediate interaction states can temporarily report an empty/invalid route.
        // Never drop the edge completely; fall back to a simple source->target line.
        const safeRoute = Array.isArray(route) && route.length >= 2
            ? route
            : this.fallbackRouteFromEndpoints(edge) ?? [];

        if (!Array.isArray(safeRoute) || safeRoute.length < 2) {
            return svg('g', {});
        }

        const visualRouteState = this.computeVisualRoute(edge as any, safeRoute as any);
        const trimmedSegments = hasServerRoute
            ? (visualRouteState.computedSegments as any)
            : this.trimRouteToPortBounds(edge as any, visualRouteState.computedSegments as any);

        const debug = this.shouldDebugEdgePoints();
        // Use model bendpoints unless we're falling back due to drag - then they are stale/ghosts.
        const showModelBendpoints = !(edge as any)._isFallingBack;
        const modelBendpoints = showModelBendpoints 
            ? ((edge as any).routingPoints as Array<{ x: number; y: number }> | undefined)
            : undefined;
            
        const debugNodes: VNode[] = debug
            ? [
                // Full route points (blue, small)
                ...this.renderDebugPoints(trimmedSegments as any, 'cal-debug-route-point', 2.6, '#00b3ff', '#003a55'),
                // Model bendpoints only (red, slightly larger)
                ...this.renderDebugPoints(Array.isArray(modelBendpoints) ? modelBendpoints : [], 'cal-debug-bendpoint', 3.2, '#ff2d55', '#5a0011')
            ]
            : [];

        return svg('g', {
            class: {
                'sprotty-edge': true,
                'mouseover': (edge as any).hoverFeedback
            }
        },
            this.renderLine(edge as any, trimmedSegments as any, context),
            ...debugNodes,
            ...context.renderChildren(edge as any, { route: trimmedSegments })
        );
    }

    protected override renderLine(edge: SEdgeImpl, segments: { x: number; y: number }[], context: RenderingContext): VNode {
        // `segments` must already represent the route we want to render (computed in `render()`).
        // Do NOT recompute routing/snap/translation here; doing so causes the edge to “switch”
        // shape during dragging because it gets adjusted twice per frame.
        if (segments.length < 2) {
            return svg('g', {});
        }

        const isSelected = (edge as any).selected === true;
        const handleEditActive = this.isRoutingHandleEditActive(edge);
        const routeRef = segments;
        const first = segments[0];
        const last = segments[segments.length - 1];
        const cache = (edge as any)._workflowEdgeRenderCache as {
            routeRef?: { x: number; y: number }[];
            routeLen?: number;
            firstX?: number;
            firstY?: number;
            lastX?: number;
            lastY?: number;
            isSelected?: boolean;
            handleEditActive?: boolean;
            normalizedSegments?: { x: number; y: number }[];
            isComputedOrthogonal?: boolean;
            path?: string;
        } | undefined;

        const canReuseCache = !!cache
            && cache.routeRef === routeRef
            && cache.routeLen === routeRef.length
            && cache.firstX === first?.x
            && cache.firstY === first?.y
            && cache.lastX === last?.x
            && cache.lastY === last?.y
            && cache.isSelected === isSelected
            && cache.handleEditActive === handleEditActive
            && Array.isArray(cache.normalizedSegments)
            && typeof cache.path === 'string'
            && typeof cache.isComputedOrthogonal === 'boolean';

        const normalizedSegments = canReuseCache
            ? (cache!.normalizedSegments as { x: number; y: number }[])
            : ((isSelected || handleEditActive)
                ? this.dedupeSegments(segments)
                : this.normalizePathSegments(segments));

        const isComputedOrthogonal = canReuseCache
            ? (cache!.isComputedOrthogonal as boolean)
            : this.isOrthogonal(segments);

        const path = canReuseCache
            ? (cache!.path as string)
            : this.buildPath(normalizedSegments, (isSelected || handleEditActive) ? 0 : (isComputedOrthogonal ? 8 : 6));

        if (!canReuseCache) {
            (edge as any)._workflowEdgeRenderCache = {
                routeRef,
                routeLen: routeRef.length,
                firstX: first?.x,
                firstY: first?.y,
                lastX: last?.x,
                lastY: last?.y,
                isSelected,
                handleEditActive,
                normalizedSegments,
                isComputedOrthogonal,
                path
            };
        }
        
        const workflowEdge = edge as WorkflowEdge;
        const edgeArgs = (edge as any).args as Record<string, unknown> | undefined;
        const structureBranch = (edgeArgs?.[WorkflowDiagramMetadata.STRUCTURE_BRANCH] as string | undefined) ?? undefined;
        const structureCondition = (edgeArgs?.[WorkflowDiagramMetadata.STRUCTURE_CONDITION] as string | undefined) ?? undefined;
        const structureForeach = (edgeArgs?.[WorkflowDiagramMetadata.STRUCTURE_FOREACH] as string | undefined) ?? undefined;

        const viewerLastToken = edgeArgs?.[WorkflowDiagramMetadata.VIEWER_LAST_TOKEN];
        const viewerLastTokenText = this.formatViewerLastTokenForTooltip(viewerLastToken);
        const queueSizeRaw = edgeArgs?.[WorkflowDiagramMetadata.QUEUE_SIZE];
        const queueSize = typeof queueSizeRaw === 'number' && Number.isFinite(queueSizeRaw) ? Math.max(0, Math.trunc(queueSizeRaw)) : undefined;
        const fromEntity = (edgeArgs?.['wf:from'] as string | undefined) ?? undefined;
        const toEntity = (edgeArgs?.['wf:to'] as string | undefined) ?? undefined;
        const outPort = (edgeArgs?.['wf:outPort'] as string | undefined) ?? undefined;
        const inPort = (edgeArgs?.['wf:inPort'] as string | undefined) ?? undefined;

        const endpointLine = (fromEntity || toEntity || outPort || inPort)
            ? `${fromEntity ?? '?'}${outPort ? '.' + outPort : ''} -> ${toEntity ?? '?'}${inPort ? '.' + inPort : ''}`
            : undefined;

        const hasViewerToken = !!viewerLastTokenText;
        const tooltipLines = [
            endpointLine,
            viewerLastTokenText ? `Last token: ${viewerLastTokenText}` : undefined,
            queueSize !== undefined ? `Queue size: ${queueSize}` : undefined
        ].filter(Boolean) as string[];
        const viewerTooltip = tooltipLines.length > 0 ? tooltipLines.join('\n') : undefined;

        const fromIndex = (edgeArgs?.[WorkflowDiagramMetadata.EDGE_FROM_INDEX] as string | undefined) ?? undefined;
        const toIndex = (edgeArgs?.[WorkflowDiagramMetadata.EDGE_TO_INDEX] as string | undefined) ?? undefined;

        const isConditional = !!structureBranch;
        const isForeach = !!structureForeach;

        const hasEndpoints = normalizedSegments.length >= 2;
        const startSeg = hasEndpoints ? normalizedSegments[0] : undefined;
        const startNext = hasEndpoints ? normalizedSegments[1] : undefined;
        const endSeg = hasEndpoints ? normalizedSegments[normalizedSegments.length - 1] : undefined;
        const endPrev = hasEndpoints ? normalizedSegments[normalizedSegments.length - 2] : undefined;

        const fromIndexLabel = fromIndex ? `[${fromIndex}]` : undefined;
        const toIndexLabel = toIndex ? `[${toIndex}]` : undefined;

        const fromIndexPos = (fromIndexLabel && startSeg && startNext)
            ? this.offsetPointAlongSegment(startSeg, startNext, 12, -10)
            : undefined;
        const toIndexPos = (toIndexLabel && endSeg && endPrev)
            ? this.offsetPointAlongSegment(endSeg, endPrev, 18, -10)
            : undefined;

        return svg('g', {
            class: {
                'workflow-edge': true,
                'edge-has-last-token': hasViewerToken,
                'structure-conditional': isConditional,
                'structure-foreach': isForeach,
                'structure-branch-then': structureBranch === 'then',
                'structure-branch-else': structureBranch === 'else',
                'structure-branch-elsif': structureBranch === 'elsif',
                selected: workflowEdge.selected,
                'hover': workflowEdge.hoverFeedback,
                'read-only': workflowEdge.readOnly
            }
        },
            ...(viewerTooltip ? [svg('title', {}, viewerTooltip)] : []),
            // Edge line
            svg('path', {
                class: { 'edge-line': true },
                attrs: {
                    d: path,
                    fill: 'none'
                },
                style: (edge as any)._debugReason ? {
                    stroke: (edge as any)._debugReason === 'stale' ? '#ffa500' : '#00cc44', // Orange (stale), Green (moving)
                    'stroke-dasharray': '5, 3',
                    'stroke-width': '2px'
                } : {}
            }),
            ...(hasViewerToken ? this.renderEdgeOpenButton(workflowEdge as any, normalizedSegments as any) : []),
            ...(queueSize !== undefined ? this.renderEdgeQueueSizeBadge(normalizedSegments as any, queueSize, hasViewerToken) : []),
            // Endpoint index labels for list/entity indexing (e.g. bf[0].In)
            ...(fromIndexLabel && fromIndexPos
                ? [svg('text', {
                    class: { 'cal-edge-index-label': true, 'from-index': true },
                    attrs: {
                        x: (fromIndexPos as any).x,
                        y: (fromIndexPos as any).y,
                        'text-anchor': 'middle',
                        'dominant-baseline': 'middle'
                    }
                }, svg('tspan', {}, fromIndexLabel))]
                : []),
            ...(toIndexLabel && toIndexPos
                ? [svg('text', {
                    class: { 'cal-edge-index-label': true, 'to-index': true },
                    attrs: {
                        x: (toIndexPos as any).x,
                        y: (toIndexPos as any).y,
                        'text-anchor': 'middle',
                        'dominant-baseline': 'middle'
                    }
                }, svg('tspan', {}, toIndexLabel))]
                : []),
            // Arrow marker at target (use trimmed segments so arrow is at end of visible line)
            this.renderArrow(normalizedSegments, edge)
        );
    }

    /**
     * Check if segments form an orthogonal path
     */
    protected isOrthogonal(segments: { x: number; y: number }[]): boolean {
        if (segments.length < 2) return true;
        for (let i = 0; i < segments.length - 1; i++) {
            const p1 = segments[i];
            const p2 = segments[i+1];
            // Allow small tolerance for floating point
            const dx = Math.abs(p1.x - p2.x);
            const dy = Math.abs(p1.y - p2.y);
            if (dx > 1 && dy > 1) { // If both change by more than 1px, it's diagonal
                return false;
            }
        }
        return true;
    }

    protected normalizePathSegments(segments: { x: number; y: number }[]): { x: number; y: number }[] {
        if (segments.length <= 2) {
            return segments;
        }

        const eq = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => {
            // Use a small epsilon; routing points may be floats.
            return Math.abs(a.x - b.x) < 0.001 && Math.abs(a.y - b.y) < 0.001;
        };

        const result: { x: number; y: number }[] = [];
        for (const p of segments) {
            if (result.length === 0 || !eq(result[result.length - 1], p)) {
                result.push(p);
            }
        }

        // Remove colinear middle points: A->B->C where AB and BC are both horizontal or both vertical.
        const isColinear = (
            a: { x: number; y: number },
            b: { x: number; y: number },
            c: { x: number; y: number }
        ): boolean => {
            const abx = Math.abs(a.x - b.x);
            const aby = Math.abs(a.y - b.y);
            const bcx = Math.abs(b.x - c.x);
            const bcy = Math.abs(b.y - c.y);
            const abHorizontal = aby < 0.001;
            const abVertical = abx < 0.001;
            const bcHorizontal = bcy < 0.001;
            const bcVertical = bcx < 0.001;
            return (abHorizontal && bcHorizontal) || (abVertical && bcVertical);
        };

        const simplified: { x: number; y: number }[] = [];
        for (const p of result) {
            simplified.push(p);
            while (simplified.length >= 3) {
                const c = simplified[simplified.length - 1];
                const b = simplified[simplified.length - 2];
                const a = simplified[simplified.length - 3];
                if (isColinear(a, b, c)) {
                    simplified.splice(simplified.length - 2, 1);
                } else {
                    break;
                }
            }
        }

        return simplified;
    }

    protected getRouteMidpoint(segments: { x: number; y: number }[]): { x: number; y: number } | undefined {
        if (!Array.isArray(segments) || segments.length < 2) {
            return undefined;
        }
        const segLen = (a: { x: number; y: number }, b: { x: number; y: number }): number => {
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            return Math.sqrt(dx * dx + dy * dy);
        };

        let total = 0;
        for (let i = 1; i < segments.length; i++) {
            total += segLen(segments[i - 1], segments[i]);
        }
        if (total <= 0.001) {
            return { x: segments[0].x, y: segments[0].y };
        }

        const mid = total / 2;
        let acc = 0;
        for (let i = 1; i < segments.length; i++) {
            const a = segments[i - 1];
            const b = segments[i];
            const len = segLen(a, b);
            if (acc + len >= mid) {
                const t = len > 0 ? (mid - acc) / len : 0;
                return {
                    x: a.x + (b.x - a.x) * t,
                    y: a.y + (b.y - a.y) * t
                };
            }
            acc += len;
        }

        return segments[segments.length - 1];
    }

    protected getElementRect(el: any): { x: number; y: number; width: number; height: number } | undefined {
        if (!el) {
            return undefined;
        }
        const size = el.size || el.bounds;
        if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) {
            return undefined;
        }
        const pos = absPos(el);
        if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
            return undefined;
        }
        return {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height
        };
    }

    protected isPointInRect(p: { x: number; y: number }, rect: { x: number; y: number; width: number; height: number }, eps = 0.01): boolean {
        return p.x >= rect.x - eps
            && p.x <= rect.x + rect.width + eps
            && p.y >= rect.y - eps
            && p.y <= rect.y + rect.height + eps;
    }

    protected intersectRayWithRect(
        from: { x: number; y: number },
        toward: { x: number; y: number },
        rect: { x: number; y: number; width: number; height: number }
    ): { x: number; y: number } | undefined {
        const dx = toward.x - from.x;
        const dy = toward.y - from.y;
        if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) {
            return undefined;
        }

        const candidates: Array<{ t: number; x: number; y: number }> = [];
        const addCandidate = (t: number): void => {
            if (!Number.isFinite(t) || t <= 1e-6) {
                return;
            }
            const x = from.x + dx * t;
            const y = from.y + dy * t;
            if (this.isPointInRect({ x, y }, rect)) {
                candidates.push({ t, x, y });
            }
        };

        if (Math.abs(dx) >= 1e-6) {
            addCandidate((rect.x - from.x) / dx);
            addCandidate((rect.x + rect.width - from.x) / dx);
        }
        if (Math.abs(dy) >= 1e-6) {
            addCandidate((rect.y - from.y) / dy);
            addCandidate((rect.y + rect.height - from.y) / dy);
        }

        if (candidates.length === 0) {
            return undefined;
        }

        candidates.sort((a, b) => a.t - b.t);
        return { x: candidates[0].x, y: candidates[0].y };
    }

    protected trimRouteToPortBounds(edge: SEdgeImpl, segments: { x: number; y: number }[]): { x: number; y: number }[] {
        if (!Array.isArray(segments) || segments.length < 2) {
            return segments;
        }

        const root: any = (edge as any).root;
        const index: any = root?.index;
        if (!index) {
            return segments;
        }

        const getById = (id: string): any | undefined =>
            (typeof index.getById === 'function' ? index.getById(id) : undefined)
            ?? (typeof index.get === 'function' ? index.get(id) : undefined);

        const sourceId: string | undefined = (edge as any).sourceId;
        const targetId: string | undefined = (edge as any).targetId;
        const source = typeof sourceId === 'string' ? getById(sourceId) : undefined;
        const target = typeof targetId === 'string' ? getById(targetId) : undefined;

        const adjusted = segments.slice();

        const trimEndpoint = (element: any, endpointIndex: number, nextIndex: number): void => {
            const rect = this.getElementRect(element);
            if (!rect) {
                return;
            }
            const p0 = adjusted[endpointIndex];
            const p1 = adjusted[nextIndex];
            if (!p0 || !p1) {
                return;
            }
            if (!this.isPointInRect(p0, rect)) {
                return;
            }
            const hit = this.intersectRayWithRect(p0, p1, rect);
            if (hit) {
                adjusted[endpointIndex] = hit;
            }
        };

        if (source) {
            trimEndpoint(source, 0, 1);
        }
        if (target) {
            trimEndpoint(target, adjusted.length - 1, adjusted.length - 2);
        }

        return adjusted;
    }

    protected renderEdgeOpenButton(edge: SEdgeImpl, segments: { x: number; y: number }[]): VNode[] {
        const mid = this.getRouteMidpoint(segments);
        const args = (edge as any).args as Record<string, unknown> | undefined;
        const anchorX = args?.[EDGE_OPEN_ANCHOR_X_ARG];
        const anchorY = args?.[EDGE_OPEN_ANCHOR_Y_ARG];
        const hasAnchor = typeof anchorX === 'number' && Number.isFinite(anchorX)
            && typeof anchorY === 'number' && Number.isFinite(anchorY);
        const anchor = hasAnchor
            ? { x: anchorX as number, y: anchorY as number }
            : mid;
        if (!anchor) {
            return [];
        }

        const label = 'Open';
        const width = 40;
        const height = 18;
        const rx = 4;
        const x = -width / 2;
        const y = -height / 2 - 10;

        return [
            svg('g', {
                class: { 'edge-open-button': true },
                attrs: {
                    transform: `translate(${anchor.x}, ${anchor.y})`
                }
            },
                svg('rect', {
                    class: { 'edge-open-pill': true },
                    attrs: { x, y, width, height, rx, ry: rx }
                }),
                svg('text', {
                    class: { 'edge-open-label': true },
                    attrs: {
                        x: 0,
                        y: y + height / 2 + 0.5,
                        'text-anchor': 'middle',
                        'dominant-baseline': 'middle'
                    }
                }, label),
                svg('rect', {
                    class: { 'edge-open-hit': true },
                    attrs: { x, y, width, height, rx, ry: rx }
                })
            )
        ];
    }

    protected renderEdgeQueueSizeBadge(segments: { x: number; y: number }[], queueSize: number, hasOpenButton: boolean): VNode[] {
        const mid = this.getRouteMidpoint(segments);
        if (!mid) {
            return [];
        }

        const label = String(queueSize);
        const width = Math.max(22, 10 + label.length * 7);
        const height = 16;
        const rx = 4;
        const x = -width / 2;
        const y = hasOpenButton ? 2 : -8;

        return [
            svg('g', {
                class: { 'edge-queue-badge': true },
                attrs: {
                    transform: `translate(${mid.x}, ${mid.y})`
                }
            },
                svg('rect', {
                    class: { 'edge-queue-pill': true },
                    attrs: { x, y, width, height, rx, ry: rx }
                }),
                svg('text', {
                    class: { 'edge-queue-label': true },
                    attrs: {
                        x: 0,
                        y: y + height / 2 + 0.5,
                        'text-anchor': 'middle',
                        'dominant-baseline': 'middle'
                    }
                }, label)
            )
        ];
    }

    protected buildPath(segments: { x: number; y: number }[], cornerRadiusPx: number = 8): string {
        if (segments.length === 0) return '';
        if (segments.length === 1) return `M ${segments[0].x},${segments[0].y}`;

        // Render orthogonal polylines with rounded corners.
        // Note: when routing handles are visible we pass 0 to keep corners sharp so
        // the handle dots lie exactly on the rendered path.
        const effectiveCornerRadiusPx = Math.max(0, cornerRadiusPx);

        const sign = (n: number): number => (n === 0 ? 0 : n > 0 ? 1 : -1);
        const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => {
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            return Math.sqrt(dx * dx + dy * dy);
        };

        const start = segments[0];
        let path = `M ${start.x},${start.y}`;

        for (let i = 1; i < segments.length - 1; i++) {
            const prev = segments[i - 1];
            const corner = segments[i];
            const next = segments[i + 1];

            const inDir = { x: sign(corner.x - prev.x), y: sign(corner.y - prev.y) };
            const outDir = { x: sign(next.x - corner.x), y: sign(next.y - corner.y) };

            // If we don't actually turn here, just draw a straight segment.
            const isTurn = (inDir.x !== outDir.x) || (inDir.y !== outDir.y);
            if (!isTurn || (inDir.x === 0 && inDir.y === 0) || (outDir.x === 0 && outDir.y === 0)) {
                path += ` L ${corner.x},${corner.y}`;
                continue;
            }

            const inLen = dist(prev, corner);
            const outLen = dist(corner, next);
            const r = Math.max(0, Math.min(effectiveCornerRadiusPx, inLen / 2, outLen / 2));

            if (r <= 0.001) {
                path += ` L ${corner.x},${corner.y}`;
                continue;
            }

            // Point before the corner on the incoming segment
            const pIn = {
                x: corner.x - inDir.x * r,
                y: corner.y - inDir.y * r
            };
            // Point after the corner on the outgoing segment
            const pOut = {
                x: corner.x + outDir.x * r,
                y: corner.y + outDir.y * r
            };

            // Approach corner, then round via quadratic bezier through the corner.
            path += ` L ${pIn.x},${pIn.y}`;
            path += ` Q ${corner.x},${corner.y} ${pOut.x},${pOut.y}`;
        }

        const end = segments[segments.length - 1];
        path += ` L ${end.x},${end.y}`;
        return path;
    }

    protected renderArrow(segments: { x: number; y: number }[], edge?: Readonly<SEdgeImpl>): VNode {
        // A boundary port is drawn AS an arrow, so an edge ending at one must
        // not bring its own. Two arrowheads meeting is not the only problem:
        // the tip is deliberately nudged past the endpoint to meet the stroke
        // cap, and the endpoint is the glyph's own edge — so it landed inside
        // the glyph. The wire is a plain line into the symbol, which is how the
        // drawing shows it.
        if (edge && endsAtBoundaryPort(edge)) {
            return svg('g', {});
        }
        if (segments.length < 2) {
            return svg('g', {});
        }
        
        const last = segments[segments.length - 1];
        let prev = segments[segments.length - 2];
        
        // Handle tiny last segments for angle calculation
        const dx1 = last.x - prev.x;
        const dy1 = last.y - prev.y;
        const len1 = Math.sqrt(dx1*dx1 + dy1*dy1);
        
        if (len1 < 2 && segments.length > 2) {
            prev = segments[segments.length - 3];
        }
        
        // Calculate arrow direction
        const dx = last.x - prev.x;
        const dy = last.y - prev.y;
        const length = Math.sqrt(dx * dx + dy * dy);
        
        if (length === 0) return svg('g', {});

        const angle = Math.atan2(dy, dx) * 180 / Math.PI;
        
        // Arrow tip is at the end of the (already trimmed) line.
        // Nudge forward slightly so the tip aligns with the visible stroke cap.
        const tipOffset = 4;
        const tipX = last.x + (dx / length) * tipOffset;
        const tipY = last.y + (dy / length) * tipOffset;
        
        return svg('polygon', {
            class: { 'edge-arrow': true },
            attrs: {
                points: '-7.5,-3.75 0,0 -7.5,3.75',
                transform: `translate(${tipX},${tipY}) rotate(${angle})`
            }
        });
    }
}

/**
 * Connection edge view without arrowheads.
 * Used for structural wiring inside the `if` container (if->branch, branch->join, join->if).
 */
@injectable()
export class WorkflowNoArrowEdgeView extends WorkflowEdgeView {
    protected override renderArrow(_segments: { x: number; y: number }[], _edge?: Readonly<SEdgeImpl>): VNode {
        return svg('g', {});
    }
}

/**
 * Virtual edge view - dashed line for edges derived from foreach loop symbolic substitution.
 * These edges show what connections would exist when the loop variable takes a specific value.
 * Read-only and not user-editable.
 */
@injectable()
export class WorkflowVirtualEdgeView extends WorkflowEdgeView {
    override render(edge: Readonly<SEdgeImpl>, context: RenderingContext, args?: IViewArgs): VNode | undefined {
        const routingPoints = (edge as any).routingPoints;
        
        // If no valid route polyline, don't render - avoids spurious straight-line edges.
        if (!Array.isArray(routingPoints) || routingPoints.length < 2) {
            return undefined;
        }
        
        const result = super.render(edge, context, args);
        if (result) {
            // Add virtual edge class for dashed styling
            const existingClasses = (result.data?.class as Record<string, boolean>) ?? {};
            result.data = result.data ?? {};
            result.data.class = {
                ...existingClasses,
                'workflow-edge-virtual': true,
                'virtual-edge': true
            };
        }
        return result;
    }
}

/**
 * Label view - renders labels with positions computed by ELK.
 */
@injectable()
export class WorkflowLabelView implements IView {
    render(label: Readonly<WorkflowLabel>, context: RenderingContext, args?: IViewArgs): VNode | undefined {
        const labelType = (label as any).type as string || '';
        const pos = label.position ?? { x: 0, y: 0 };

        // Boundary labels render NOTHING here.
        //
        // The boundary node view draws its own name and type as part of the port
        // symbol, so drawing them again from the label elements would double the
        // text. The elements stay in the model because they are what a rename
        // addresses (`<node>_label_name`), and because the server owns them —
        // they simply have no appearance of their own.
        //
        // This is also what put the name on top of its glyph. A label positioned
        // by its own view still carries whatever position it was left with, and
        // the view applied it; the text and the arrow it belonged to were being
        // placed by two different pieces of code that had no way to agree.
        if (labelType === WorkflowDiagramTypes.LABEL_BOUNDARY_NAME || labelType === WorkflowDiagramTypes.LABEL_BOUNDARY_TYPE) {
            return undefined;
        }

        // Port labels - ELK positions the label box, we handle text anchoring
        // NOTE: The framework applies the label's position transform; do NOT translate again here.
        if (labelType === WorkflowDiagramTypes.LABEL_PORT || label.cssClasses?.includes('port-label')) {
            const parentPort = (label as any).parent as any;
            const direction = parentPort?.args?.['cal:portDirection'] as string | undefined;
            const parentType = parentPort?.type as string | undefined;
            const isOutputByType = parentType?.includes('output') ?? false;
            const isOutput = direction === 'output' || isOutputByType;

            // Input labels: do not add extra inner padding. The label box already has a
            // PORT_LABEL_GAP_PX from the port marker; additional inset makes inputs look
            // farther than outputs.

            // For output labels with text-anchor:end, the text "ends" at x.
            // ELK positions the label box so that its RIGHT edge is at the port.
            // So we need to set x = labelWidth so text ends at the right edge of the box.
            const estimateLabelSizeFallback = (text: string): { width: number; height: number } => {
                // Keep aligned with server-side fallback in WorkflowDiagramModule.applyDeterministicPortLabelPositions.
                const fontSizePx = WorkflowDiagramConstants.PORT_LABEL_FONT_SIZE_PX;
                const avgCharWidth = fontSizePx * 0.7;
                const padding = 3;
                return {
                    width: Math.max(1, Math.ceil(text.length * avgCharWidth + padding * 2)),
                    height: Math.max(1, Math.ceil(fontSizePx * 1.25)),
                };
            };

            const labelWRaw = label.size?.width ?? label.bounds?.width ?? 0;
            const labelHRaw = label.size?.height ?? label.bounds?.height ?? 0;
            // On persisted-layout reopen (ELK skipped), labels may briefly have width 0
            // before client-measured bounds are sent; keep output anchoring stable.
            const labelW = labelWRaw > 0 ? labelWRaw : estimateLabelSizeFallback(label.text || '').width;
            const labelH = labelHRaw > 0 ? labelHRaw : estimateLabelSizeFallback(label.text || '').height;
            const textX = isOutput ? labelW : 0;
            const textY = Math.round(labelH / 2);

            return svg('g', {},
                svg('text', {
                    class: {
                        'port-label': true,
                        'input-port-label': !isOutput,
                        'output-port-label': isOutput
                    },
                    // Presentation attributes can be overridden by CSS. Some upstream GLSP/Sprotty
                    // styles set `text-anchor: middle`, which breaks our output label anchoring
                    // (x = labelWidth + text-anchor:end). Force via inline style.
                    style: {
                        'text-anchor': isOutput ? 'end' : 'start'
                    },
                    attrs: {
                        x: textX,
                        y: textY,
                        'data-cal-label-id': (label as any).id ?? undefined,
                        'text-anchor': isOutput ? 'end' : 'start',
                        // Vertically center glyphs within the label box.
                        'dominant-baseline': 'middle'
                    }
                }, label.text || '')
            );
        }

        // Derive label kind from type property
        let labelKind = label.labelKind || 'name';
        if (labelType.includes('type')) {
            labelKind = 'type';
        } else if (labelType.includes('badge')) {
            labelKind = 'badge';
        }
        
        const labelRole = (label as any).args?.['wf:labelRole'];
        // Skip rendering type labels (except boundary labels handled above)
        if (labelKind === 'type') {
            if (labelRole !== 'type-footer') {
                return undefined;
            }
        }
        
        // Simplest possible label - just text, no positioning
        const textAnchor = labelKind === 'type' ? 'middle' : 'start';
        const parent = (label as any).parent as { size?: { width?: number; height?: number }; bounds?: { width?: number; height?: number } } | undefined;
        const parentSize = parent?.size ?? parent?.bounds;
        const footerPos = labelRole === 'type-footer' && parentSize
            ? { x: (parentSize.width ?? 0) / 2, y: (parentSize.height ?? 0) + 4 }
            : pos;
        return svg('g', {
            attrs: {
                transform: `translate(${footerPos.x}, ${footerPos.y})`
            }
        },
            svg('text', {
                class: {
                    'sprotty-label': true,
                    'type-footer-label': labelKind === 'type'
                },
                style: labelKind === 'type' ? {
                    'font-style': 'italic',
                    'fill': 'var(--vscode-descriptionForeground, #8b8b8b)'
                } : undefined,
                attrs: {
                    'text-anchor': textAnchor,
                    'dominant-baseline': 'hanging'
                }
            }, label.text || '')
        );
    }
}

/**
 * Map of element types to view constructors
 */
export const workflowDiagramViewMap = new Map<string, new () => IView>([
    [WorkflowDiagramTypes.NODE_ACTOR, ActorNodeView],
    [WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR, ExternalActorNodeView],
    [WorkflowDiagramTypes.NODE_NETWORK, NetworkNodeView],
    [WorkflowDiagramTypes.NODE_COLLAPSED_CONDITIONAL, CollapsedConditionalNodeView],
    [WorkflowDiagramTypes.NODE_COLLAPSED_ARRAY, CollapsedArrayNodeView],
    [WorkflowDiagramTypes.NODE_BOUNDARY_INPUT, BoundaryInputNodeView],
    [WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT, BoundaryOutputNodeView],
    [WorkflowDiagramTypes.PORT_INPUT, WorkflowInputPortView],
    [WorkflowDiagramTypes.PORT_OUTPUT, WorkflowOutputPortView],
    [WorkflowDiagramTypes.EDGE_CONNECTION, WorkflowEdgeView],
    [WorkflowDiagramTypes.EDGE_CONNECTION_NO_ARROW, WorkflowNoArrowEdgeView],
    [WorkflowDiagramTypes.LABEL_NAME, WorkflowLabelView],
    [WorkflowDiagramTypes.LABEL_TYPE, WorkflowLabelView],
    [WorkflowDiagramTypes.LABEL_BADGE, WorkflowLabelView],
    [WorkflowDiagramTypes.LABEL_PORT, WorkflowLabelView],
    [WorkflowDiagramTypes.LABEL_BOUNDARY_NAME, WorkflowLabelView],
    [WorkflowDiagramTypes.LABEL_BOUNDARY_TYPE, WorkflowLabelView]
]);
