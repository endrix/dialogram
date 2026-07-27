import { Ranked } from '@eclipse-glsp/client';
import {
    Action,
    Args,
    GModelElement,
    MouseListener,
    NavigateToExternalTargetAction
} from '@eclipse-glsp/sprotty';
import { injectable } from 'inversify';
import { WorkflowDiagramMetadata } from '@dialogram/shared';

const VIEWER_ACTION_ARG = 'wf:viewerAction';
const VIEWER_MESSAGE_ARG = 'wf:viewerMessage';
export const EDGE_OPEN_ANCHOR_X_ARG = 'wf:edgeOpenAnchorX';
export const EDGE_OPEN_ANCHOR_Y_ARG = 'wf:edgeOpenAnchorY';

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

function fileUriFromFsPath(fsPath: string): string {
    const p = fsPath.trim();
    if (p.startsWith('file:')) {
        return p;
    }
    const encoded = encodeURI(p);
    return encoded.startsWith('/') ? `file://${encoded}` : encoded;
}

function findContainingEdge(element: GModelElement | undefined): GModelElement | undefined {
    let current: GModelElement | undefined = element;
    while (current) {
        if (typeof current.type === 'string' && current.type.startsWith('edge:')) {
            return current;
        }
        current = (current as unknown as { parent?: GModelElement }).parent;
    }
    return undefined;
}

function edgeHasViewerToken(edge: GModelElement): boolean {
    const args = (edge as unknown as { args?: Args }).args;
    return lastTokenAsPath(args?.[WorkflowDiagramMetadata.VIEWER_LAST_TOKEN]) !== undefined;
}

function toDiagramPoint(event: MouseEvent): { x: number; y: number } | undefined {
    const target = event.target;
    if (!(target instanceof SVGElement)) {
        return undefined;
    }
    const svg = target.ownerSVGElement;
    if (!svg || typeof svg.createSVGPoint !== 'function') {
        return undefined;
    }

    // Use the graph group CTM so the point is converted into model coordinates
    // (matching edge route coordinates), not raw root-SVG viewport coordinates.
    const graphGroup = svg.querySelector('g.sprotty-graph') as SVGGraphicsElement | null;
    const reference = graphGroup ?? (target instanceof SVGGraphicsElement ? target : svg);
    const ctm = reference.getScreenCTM();
    if (!ctm) {
        return undefined;
    }

    const pt = svg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const local = pt.matrixTransform(ctm.inverse());
    if (!Number.isFinite(local.x) || !Number.isFinite(local.y)) {
        return undefined;
    }
    return { x: local.x, y: local.y };
}

function setEdgeOpenAnchor(edge: GModelElement, point: { x: number; y: number } | undefined): void {
    const model = edge as unknown as { args?: Args };
    const nextArgs: Args = {
        ...(model.args ?? {})
    };
    if (point) {
        nextArgs[EDGE_OPEN_ANCHOR_X_ARG] = point.x;
        nextArgs[EDGE_OPEN_ANCHOR_Y_ARG] = point.y;
    } else {
        delete nextArgs[EDGE_OPEN_ANCHOR_X_ARG];
        delete nextArgs[EDGE_OPEN_ANCHOR_Y_ARG];
    }
    model.args = nextArgs;
}

function updateEdgeOpenButtonDomPosition(event: MouseEvent, point: { x: number; y: number } | undefined): void {
    if (!point) {
        return;
    }

    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const elements = path.filter((entry): entry is Element => entry instanceof Element);
    if (elements.length === 0) {
        return;
    }

    const edgeGroup = elements.find(el => el.classList.contains('workflow-edge'));
    if (!edgeGroup) {
        return;
    }

    const openButton = edgeGroup.querySelector('.edge-open-button');
    if (!(openButton instanceof SVGGElement)) {
        return;
    }

    openButton.setAttribute('transform', `translate(${point.x}, ${point.y})`);
}

function hasEdgeOpenButtonTarget(event: MouseEvent): boolean {
    const hasClass = (candidate: EventTarget | null): boolean => {
        if (!(candidate instanceof Element)) {
            return false;
        }
        return candidate.classList.contains('edge-open-button')
            || candidate.classList.contains('edge-open-pill')
            || candidate.classList.contains('edge-open-label')
            || candidate.classList.contains('edge-open-hit');
    };

    if (hasClass(event.target)) {
        return true;
    }

    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    for (const entry of path) {
        if (hasClass(entry as EventTarget)) {
            return true;
        }
    }
    return false;
}

@injectable()
export class EdgeOpenMouseListener extends MouseListener implements Ranked {
    // Run early so default tools do not grab the click.
    rank = 9;

    override mouseOver(target: GModelElement, event: MouseEvent): (Action | Promise<Action>)[] {
        const edge = findContainingEdge(target);
        if (!edge || !edgeHasViewerToken(edge)) {
            return [];
        }
            if (hasEdgeOpenButtonTarget(event)) {
                return [];
            }
        const point = toDiagramPoint(event);
        setEdgeOpenAnchor(edge, point);
        updateEdgeOpenButtonDomPosition(event, point);
        return [];
    }

    override mouseMove(target: GModelElement, event: MouseEvent): (Action | Promise<Action>)[] {
        const edge = findContainingEdge(target);
        if (!edge || !edgeHasViewerToken(edge)) {
            return [];
        }
            if (hasEdgeOpenButtonTarget(event)) {
                return [];
            }
        const point = toDiagramPoint(event);
        setEdgeOpenAnchor(edge, point);
        updateEdgeOpenButtonDomPosition(event, point);
        return [];
    }

    override mouseOut(target: GModelElement, _event: MouseEvent): (Action | Promise<Action>)[] {
        const edge = findContainingEdge(target);
        if (!edge) {
            return [];
        }
        setEdgeOpenAnchor(edge, undefined);
        return [];
    }

    override mouseDown(target: GModelElement, event: MouseEvent): (Action | Promise<Action>)[] {
        if (!hasEdgeOpenButtonTarget(event)) {
            return [];
        }

        const edge = findContainingEdge(target);
        if (!edge) {
            return [];
        }

        try {
            event.preventDefault();
            event.stopPropagation();
        } catch {
            // ignore
        }

        const args = (edge as unknown as { args?: Args }).args;
        const tokenPath = lastTokenAsPath(args?.[WorkflowDiagramMetadata.VIEWER_LAST_TOKEN]);
        if (!tokenPath) {
            return [
                NavigateToExternalTargetAction.create({
                    uri: 'file:///',
                    args: {
                        [VIEWER_ACTION_ARG]: 'error',
                        [VIEWER_MESSAGE_ARG]: 'Edge open: missing last token (run the workflow first).'
                    }
                })
            ];
        }

        return [
            NavigateToExternalTargetAction.create({
                uri: fileUriFromFsPath(tokenPath),
                args: {
                    [VIEWER_ACTION_ARG]: 'open'
                }
            })
        ];
    }
}
