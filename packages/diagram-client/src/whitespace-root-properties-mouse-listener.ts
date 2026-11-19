import { Ranked } from '@eclipse-glsp/client';
import { Action, GModelElement, MouseListener } from '@eclipse-glsp/sprotty';
import { inject, injectable, optional } from 'inversify';
import { WorkflowDiagramTypes } from '@dialogram/shared';
import { PropertyPanel } from './property-panel';
import { DiagramSurfaceHost } from './diagram-surface-host';

@injectable()
export class WhitespaceRootPropertiesMouseListener extends MouseListener implements Ranked {
    // Run after node-specific double-click listeners.
    rank = 20;

    @inject(PropertyPanel)
    protected readonly propertyPanel!: PropertyPanel;

    @inject(DiagramSurfaceHost) @optional()
    protected readonly surfaceHost?: DiagramSurfaceHost;

    override doubleClick(target: GModelElement, _event: MouseEvent): (Action | Promise<Action>)[] {
        if (target.type !== WorkflowDiagramTypes.GRAPH) {
            return [];
        }
        // Where a mounted surface hears clicks, the graph's whitespace is the
        // surface's: a double-click there is its to answer (it was handed the
        // click with clickCount 2), and showing the root's properties would
        // replace the selection it has just put in the panel. The panel shows
        // them there by itself while nothing is selected.
        if (this.surfaceHandlesClicks()) {
            return [];
        }

        this.propertyPanel.showRootPropertiesFromWhitespaceDoubleClick();
        return [];
    }

    private surfaceHandlesClicks(): boolean {
        const host = this.surfaceHost;
        return !!host?.mounted() && typeof host.surface()?.click === 'function';
    }
}
