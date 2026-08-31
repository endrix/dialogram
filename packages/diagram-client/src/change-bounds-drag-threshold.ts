/**
 * Mouse-drag threshold for node moves and resizes.
 *
 * A double-click on a node — the gesture that navigates into a nested network —
 * routinely carries a pixel or two of pointer travel between press and release.
 * GLSP's stock listeners treat *any* movement while the button is down as a
 * drag, so that stray travel committed a real `ChangeBoundsOperation`: the node
 * shifted, the server rerouted its edges, and the diagram changed under a
 * gesture the user never meant as a move.
 *
 * The fix uses GLSP's own mechanism rather than a bespoke suppression pass.
 * `DragAwareMouseListener` already carries a `_dragSensitivity`: while the
 * pointer stays within that radius of the press point, `mouseMove` is routed to
 * `nonDraggingMouseMove` and the listener never flips into drag state, so the
 * release lands on `nonDraggingMouseUp` — the plain-click path both stock
 * listeners already implement and already clean up after (feedback disposed,
 * tracker stopped). The sensitivity simply defaults to `0`, which disables the
 * check outright: `mouseDown` only records a press point when it is positive.
 *
 * Both listeners hard-code `super()` with no argument, so the threshold is
 * applied by assigning the protected field after construction.
 *
 * Scope is mouse-only by construction. The threshold lives in the mouse
 * listeners; keyboard nudges run through `MoveElementKeyListener`, a separate
 * listener this does not touch, so arrow-key moves of any size still commit.
 */
import { ChangeBoundsListener, ChangeBoundsTool, FeedbackMoveMouseListener } from '@eclipse-glsp/client';
import type { ISelectionListener } from '@eclipse-glsp/client';
import type { MouseListener } from '@eclipse-glsp/sprotty';
import { injectable } from 'inversify';

/**
 * Pointer travel, in screen pixels, below which a press-drag-release is treated
 * as a click rather than a move. Measured as Chebyshev distance from the press
 * point (`Point.maxDistance`), matching GLSP's own comparison.
 *
 * Four pixels absorbs the tremor of a double-click without swallowing a
 * deliberate nudge — a user who means to move a node moves it further than
 * this, and anything below it would be lost in the diagram's own grid anyway.
 */
export const DRAG_THRESHOLD_PX = 4;

/** Move-feedback listener that ignores sub-threshold pointer travel. */
export class WorkflowFeedbackMoveMouseListener extends FeedbackMoveMouseListener {
    constructor(tool: ChangeBoundsTool) {
        super(tool);
        this._dragSensitivity = DRAG_THRESHOLD_PX;
    }
}

/** Change-bounds listener that ignores sub-threshold pointer travel. */
export class WorkflowChangeBoundsListener extends ChangeBoundsListener {
    constructor(tool: ChangeBoundsTool) {
        super(tool);
        this._dragSensitivity = DRAG_THRESHOLD_PX;
    }
}

/**
 * `ChangeBoundsTool` wired with the threshold-aware listeners.
 *
 * Both listeners need it, and for different reasons: the feedback listener
 * decides whether the node visibly follows the pointer, the change-bounds
 * listener decides whether a move operation is sent to the server. Raising the
 * threshold on only the latter would leave the node drifting under the cursor
 * and then snapping back on release.
 */
@injectable()
export class WorkflowChangeBoundsTool extends ChangeBoundsTool {
    protected override createMoveMouseListener(): MouseListener {
        return new WorkflowFeedbackMoveMouseListener(this);
    }

    protected override createChangeBoundsListener(): MouseListener & ISelectionListener {
        return new WorkflowChangeBoundsListener(this);
    }
}
