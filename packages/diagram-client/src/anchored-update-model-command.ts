/**
 * The server's model update, scrolled with the toggle anchor (toggle-anchor.ts).
 *
 * Kept apart from the anchor: this extends GLSP's update command at load, and
 * the toggles' mouse listeners, which only tell the anchor what was pressed,
 * load in places that have no GLSP runtime.
 */
import { inject, injectable, optional } from 'inversify';
import { FeedbackAwareUpdateModelCommand, TYPES } from '@eclipse-glsp/client';
import type { UpdateModelAction } from '@eclipse-glsp/protocol';
import { ViewportAnimation, type CommandExecutionContext, type GModelRoot } from '@eclipse-glsp/sprotty';
import { ToggleAnchor, absolutePosition, type Anchored, type Point } from './toggle-anchor';

/** Where an element ends up, in diagram coordinates: each ancestor at the place a move takes it, or where it is. */
function finalPosition(element: any, finals: Map<unknown, Point>): Point {
    let x = 0;
    let y = 0;
    for (let at = element; at && at.parent && at.parent !== at; at = at.parent) {
        const position = finals.get(at) ?? at.position;
        x += position?.x ?? 0;
        y += position?.y ?? 0;
    }
    return { x, y };
}

/**
 * The server's update, with the view scrolled in the same animation that
 * moves the nodes when it is the model a toggle asked for: the node pressed
 * stays still on screen. Unanimated, the scroll is simply the new one.
 */
@injectable()
export class AnchoredUpdateModelCommand extends FeedbackAwareUpdateModelCommand {
    @inject(ToggleAnchor) @optional() protected readonly anchor?: ToggleAnchor;

    private anchored: Anchored | undefined;

    constructor(@inject(TYPES.Action) action: UpdateModelAction) {
        super(action);
    }

    protected override performUpdate(oldRoot: GModelRoot, newRoot: GModelRoot, context: CommandExecutionContext): any {
        this.anchored = this.anchor?.take(newRoot, oldRoot);
        const result = super.performUpdate(oldRoot, newRoot, context);
        const root = result as any;
        if (this.anchored && root && !(result instanceof Promise) && root.scroll) {
            root.scroll = { ...this.anchored.scroll };
        }
        return result;
    }

    protected override createAnimations(data: any, root: GModelRoot, context: CommandExecutionContext): any[] {
        if (this.anchored && this.anchored.id !== this.anchored.pressed) {
            carryAcross(data, root, this.anchored);
        }
        const animations = super.createAnimations(data, root, context);
        const viewport = root as any;
        if (this.anchored && viewport.scroll && typeof viewport.zoom === 'number') {
            animations.push(new ViewportAnimation(
                viewport,
                { scroll: { ...viewport.scroll }, zoom: viewport.zoom },
                { scroll: { ...this.anchored.scroll }, zoom: viewport.zoom },
                context
            ));
        }
        return animations;
    }
}

/**
 * A node opened into its frame, or a frame closed back into its node: two
 * ids, which the update matches to nothing, so neither moves. The one coming
 * in slides from where the one pressed was, and the one fading out slides to
 * where the new one goes: both stay under the pointer while the view pans.
 * Before the update's own moves are made into its animation, which then
 * carries these too; matched elements stand at their old places by then.
 */
export function carryAcross(data: any, root: any, anchored: Anchored): void {
    const moves: any[] = data.moves ?? (data.moves = []);
    const finals = new Map<unknown, Point>(moves.map(move => [move.element, move.toPosition]));
    const index = root?.index;
    const arriving = index?.getById?.(anchored.id);
    if (arriving?.position && !finals.has(arriving)) {
        const parent = arriving.parent ? absolutePosition(arriving.parent) : { x: 0, y: 0 };
        const from = { x: anchored.from.x - parent.x, y: anchored.from.y - parent.y };
        moves.push({ element: arriving, fromPosition: from, toPosition: { ...arriving.position } });
        arriving.position = { ...from };
    }
    const leaving = index?.getById?.(anchored.pressed);
    if (leaving?.position && leaving !== arriving && !finals.has(leaving)) {
        const parent = leaving.parent ? finalPosition(leaving.parent, finals) : { x: 0, y: 0 };
        moves.push({
            element: leaving,
            fromPosition: { ...leaving.position },
            toPosition: { x: anchored.to.x - parent.x, y: anchored.to.y - parent.y }
        });
    }
}
