import { GEdge } from '@eclipse-glsp/server';

export function clearAllEdgeRoutingPoints(root: any): void {
    const visit = (element: any): void => {
        if (!element) {
            return;
        }
        if (element instanceof GEdge) {
            delete (element as any).routingPoints;
            const args = (element as any).args as Record<string, unknown> | undefined;
            if (args && typeof args === 'object') {
                delete (args as any)['cal:manualRoute'];
            }
        }
        const children = element.children as any[] | undefined;
        if (Array.isArray(children)) {
            for (const child of children) {
                visit(child);
            }
        }
    };
    visit(root);
}
