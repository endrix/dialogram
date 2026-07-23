import { describe, expect, it, vi } from 'vitest';
import { WorkflowDiagramTypes } from '@dialogram/shared';

vi.mock('@eclipse-glsp/client', () => ({
    Ranked: class {}
}));

vi.mock('@eclipse-glsp/sprotty', () => ({
    MouseListener: class {}
}));

vi.mock('../../diagram-client/src/property-panel', () => ({
    PropertyPanel: class {}
}));

import { WhitespaceRootPropertiesMouseListener } from '../../diagram-client/src/whitespace-root-properties-mouse-listener';

describe('WhitespaceRootPropertiesMouseListener', () => {
    it('shows root/workflow properties on whitespace double-click', () => {
        const listener = new WhitespaceRootPropertiesMouseListener();
        const showRootPropertiesFromWhitespaceDoubleClick = vi.fn();
        (listener as any).propertyPanel = { showRootPropertiesFromWhitespaceDoubleClick };

        const actions = listener.doubleClick({ type: WorkflowDiagramTypes.GRAPH } as any, {} as MouseEvent);

        expect(actions).toEqual([]);
        expect(showRootPropertiesFromWhitespaceDoubleClick).toHaveBeenCalledTimes(1);
    });

    it('ignores non-whitespace double-click targets', () => {
        const listener = new WhitespaceRootPropertiesMouseListener();
        const showRootPropertiesFromWhitespaceDoubleClick = vi.fn();
        (listener as any).propertyPanel = { showRootPropertiesFromWhitespaceDoubleClick };

        const actions = listener.doubleClick({ type: WorkflowDiagramTypes.NODE_ACTOR } as any, {} as MouseEvent);

        expect(actions).toEqual([]);
        expect(showRootPropertiesFromWhitespaceDoubleClick).not.toHaveBeenCalled();
    });
});