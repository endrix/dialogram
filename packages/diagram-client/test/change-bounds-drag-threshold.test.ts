/**
 * A double-click must not move the node it lands on.
 *
 * Double-clicking a node navigates into its nested network, and that gesture
 * routinely carries a pixel or two of pointer travel. GLSP's stock listeners
 * count any movement while the button is down as a drag, so that travel used to
 * commit a real move: the node shifted and the server rerouted its edges under a
 * gesture the user never meant as a move.
 *
 * These tests drive the GENUINE GLSP listeners — `glsp-stub.ts` re-exports the
 * real classes past the CSS-importing package index for exactly this reason.
 * That matters because the fix is not our own logic: it sets GLSP's built-in
 * `_dragSensitivity`, and the dispatch that consults it lives in
 * `DragAwareMouseListener`. A test against a re-implementation would keep
 * passing if a GLSP upgrade renamed or dropped that field, which is precisely
 * the silent regression worth catching — the diagram would look fine and start
 * nudging nodes again.
 *
 * The two listeners are checked at their own choke points, since they fail
 * differently: the feedback listener decides whether the node visibly follows
 * the pointer (`draggingMouseMove`), the change-bounds listener decides whether
 * an operation reaches the server (`handleMoveOnServer`).
 */
import { describe, expect, it } from 'vitest';
import {
    DRAG_THRESHOLD_PX,
    WorkflowChangeBoundsListener,
    WorkflowChangeBoundsTool,
    WorkflowFeedbackMoveMouseListener
} from '../src/change-bounds-drag-threshold';

/** Chainable no-op stand-in for a GLSP feedback emitter. */
function feedbackEmitter(): unknown {
    const emitter = {
        add: () => emitter,
        submit: () => emitter,
        dispose: () => emitter
    };
    return emitter;
}

/** The slice of `ChangeBoundsTool` both listeners touch in their constructors. */
function fakeTool(): unknown {
    return {
        createChangeBoundsTracker: () => ({
            isTracking: () => false,
            startTracking: () => undefined,
            stopTracking: () => undefined,
            dispose: () => undefined
        }),
        createFeedbackEmitter: feedbackEmitter,
        changeBoundsManager: { isValid: () => true },
        movementOptions: { allElementsNeedToBeValid: false }
    };
}

/**
 * A target that is neither the model root nor resizable/moveable, so the stock
 * `mouseDown` bookkeeping runs to completion and leaves the listener in the
 * plain "pressed on a node" state the gesture under test starts from.
 */
function target(): unknown {
    return { id: 'node1', features: new Set(), index: { all: () => [] } };
}

function press(x: number, y: number): MouseEvent {
    return { button: 0, clientX: x, clientY: y } as MouseEvent;
}

/** Records whether the node visibly followed the pointer. */
class ProbeFeedbackListener extends WorkflowFeedbackMoveMouseListener {
    moved = 0;
    protected override draggingMouseMove(): [] {
        this.moved++;
        return [];
    }
}

/** Records whether a move operation would be sent to the server. */
class ProbeChangeBoundsListener extends WorkflowChangeBoundsListener {
    committed = 0;
    protected override handleMoveOnServer(): [] {
        this.committed++;
        return [];
    }
}

/** Press at (100,100), travel to the given point, release. */
function gesture<T extends { mouseDown: Function; mouseMove: Function; mouseUp: Function }>(
    listener: T,
    toX: number,
    toY: number
): T {
    const element = target();
    listener.mouseDown(element, press(100, 100));
    listener.mouseMove(element, press(toX, toY));
    listener.mouseUp(element, press(toX, toY));
    return listener;
}

describe('mouse-drag threshold', () => {
    it('does not commit a move for double-click tremor', () => {
        const listener = gesture(new ProbeChangeBoundsListener(fakeTool() as never), 102, 101);

        expect(listener.committed).toBe(0);
    });

    it('commits a move for a deliberate drag', () => {
        const listener = gesture(new ProbeChangeBoundsListener(fakeTool() as never), 140, 100);

        expect(listener.committed).toBe(1);
    });

    it('does not move the node under the pointer for double-click tremor', () => {
        const listener = gesture(new ProbeFeedbackListener(fakeTool() as never), 102, 101);

        expect(listener.moved).toBe(0);
    });

    it('moves the node under the pointer for a deliberate drag', () => {
        const listener = gesture(new ProbeFeedbackListener(fakeTool() as never), 140, 100);

        expect(listener.moved).toBe(1);
    });

    /**
     * The boundary is worth pinning because it is a judgement call, not a
     * derived value: travel EQUAL to the threshold counts as a drag, since GLSP
     * compares `distance < sensitivity`.
     */
    it('treats travel at exactly the threshold as a drag', () => {
        const below = gesture(new ProbeChangeBoundsListener(fakeTool() as never), 100 + DRAG_THRESHOLD_PX - 1, 100);
        const at = gesture(new ProbeChangeBoundsListener(fakeTool() as never), 100 + DRAG_THRESHOLD_PX, 100);

        expect(below.committed).toBe(0);
        expect(at.committed).toBe(1);
    });

    /**
     * Both listeners must carry the threshold. With it on only the
     * change-bounds listener, the node would still drift under the cursor and
     * then snap back when the suppressed operation never arrived.
     */
    it('applies the threshold to both listeners the tool builds', () => {
        // Constructed directly, so inversify's property injection never ran:
        // stand in for the injected collaborators the listener constructors use.
        const tool = Object.assign(new WorkflowChangeBoundsTool(), fakeTool());

        expect(tool['createChangeBoundsListener']()).toBeInstanceOf(WorkflowChangeBoundsListener);
        expect(tool['createMoveMouseListener']()).toBeInstanceOf(WorkflowFeedbackMoveMouseListener);
    });
});
