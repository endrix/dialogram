/**
 * CAL Issue Marker View
 *
 * Provides a tooltip for validation markers so users can see the actual issue
 * message by hovering the marker.
 */

/** @jsx svg */
import { injectable } from 'inversify';
import { VNode } from 'snabbdom';
import { svg, GIssueMarker, GIssueMarkerView, RenderingContext } from '@eclipse-glsp/client';

@injectable()
export class WorkflowIssueMarkerView extends GIssueMarkerView {
    override render(marker: GIssueMarker, context: RenderingContext): VNode {
        const group = super.render(marker, context) as VNode;

        const messages = (marker.issues ?? [])
            .map(issue => (issue as any)?.message as string | undefined)
            .filter((m): m is string => typeof m === 'string' && m.trim() !== '');

        if (messages.length > 0) {
            const title = svg('title', {}, messages.join('\n'));
            const children = (group as any).children;
            if (Array.isArray(children)) {
                children.unshift(title);
            } else {
                (group as any).children = [title];
            }
        }

        return group;
    }
}
