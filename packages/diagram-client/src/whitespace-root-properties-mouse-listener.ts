import { Ranked } from '@eclipse-glsp/client';
import { Action, GModelElement, MouseListener } from '@eclipse-glsp/sprotty';
import { inject, injectable } from 'inversify';
import { WorkflowDiagramTypes } from '@dialogram/shared';
import { PropertyPanel } from './property-panel';

@injectable()
export class WhitespaceRootPropertiesMouseListener extends MouseListener implements Ranked {
    // Run after node-specific double-click listeners.
    rank = 20;

    @inject(PropertyPanel)
    protected readonly propertyPanel!: PropertyPanel;

    override doubleClick(target: GModelElement, _event: MouseEvent): (Action | Promise<Action>)[] {
        if (target.type !== WorkflowDiagramTypes.GRAPH) {
            return [];
        }

        this.propertyPanel.showRootPropertiesFromWhitespaceDoubleClick();
        return [];
    }
}