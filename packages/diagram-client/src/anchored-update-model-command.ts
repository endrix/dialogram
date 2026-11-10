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
import { ToggleAnchor, type Point } from './toggle-anchor';

/**
 * The server's update, with the view scrolled in the same animation that
 * moves the nodes when it is the model a toggle asked for: the node pressed
 * stays still on screen. Unanimated, the scroll is simply the new one.
 */
@injectable()
export class AnchoredUpdateModelCommand extends FeedbackAwareUpdateModelCommand {
    @inject(ToggleAnchor) @optional() protected readonly anchor?: ToggleAnchor;

    private anchored: Point | undefined;

    constructor(@inject(TYPES.Action) action: UpdateModelAction) {
        super(action);
    }

    protected override performUpdate(oldRoot: GModelRoot, newRoot: GModelRoot, context: CommandExecutionContext): any {
        this.anchored = this.anchor?.take(newRoot, oldRoot);
        const result = super.performUpdate(oldRoot, newRoot, context);
        const root = result as any;
        if (this.anchored && root && !(result instanceof Promise) && root.scroll) {
            root.scroll = { ...this.anchored };
        }
        return result;
    }

    protected override createAnimations(data: any, root: GModelRoot, context: CommandExecutionContext): any[] {
        const animations = super.createAnimations(data, root, context);
        const viewport = root as any;
        if (this.anchored && viewport.scroll && typeof viewport.zoom === 'number') {
            animations.push(new ViewportAnimation(
                viewport,
                { scroll: { ...viewport.scroll }, zoom: viewport.zoom },
                { scroll: { ...this.anchored }, zoom: viewport.zoom },
                context
            ));
        }
        return animations;
    }
}
