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

vi.mock('../../diagram-client/src/diagram-surface-host', () => ({
    DiagramSurfaceHost: class {}
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

    it('leaves a double-click to a mounted surface that hears clicks', () => {
        const showRootPropertiesFromWhitespaceDoubleClick = vi.fn();
        const withSurface = (mounted: boolean, surface: object | undefined) => {
            const listener = new WhitespaceRootPropertiesMouseListener();
            (listener as any).propertyPanel = { showRootPropertiesFromWhitespaceDoubleClick };
            (listener as any).surfaceHost = { mounted: () => mounted, surface: () => surface };
            return listener.doubleClick({ type: WorkflowDiagramTypes.GRAPH } as any, {} as MouseEvent);
        };

        expect(withSurface(true, { click: () => undefined })).toEqual([]);
        expect(showRootPropertiesFromWhitespaceDoubleClick).not.toHaveBeenCalled();

        withSurface(true, {});
        withSurface(false, { click: () => undefined });
        withSurface(true, undefined);
        expect(showRootPropertiesFromWhitespaceDoubleClick).toHaveBeenCalledTimes(3);
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