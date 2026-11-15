import { Command, DefaultCommandStack } from '@eclipse-glsp/server';
import { injectable } from 'inversify';

/**
 * A command that can say, once executed, whether it changed anything. An
 * edit refused, or cancelled at a prompt, or one that came back to the text
 * it started from, changed nothing.
 */
export interface CommandThatMayChangeNothing extends Command {
    /** After `execute`: true when it changed nothing, so there is nothing to undo. */
    changedNothing(): boolean;
}

/** Whether `command`, executed, says it changed nothing. One that cannot say has changed something. */
export function changedNothing(command: Command): boolean {
    const candidate = command as Partial<CommandThatMayChangeNothing>;
    return typeof candidate.changedNothing === 'function' && candidate.changedNothing() === true;
}

/**
 * GLSP's command stack, but a command that changed nothing is not kept.
 *
 * GLSP puts every command an operation handler returns on the stack, after
 * executing it, whatever it did. One that wrote nothing cannot be undone,
 * and while it is on top, the stack cannot undo at all: Undo no longer
 * reaches the edits before it. A refusal is often only known once the
 * command has run (the program that writes the source answered no), too
 * late for a handler to return no command, so the stack decides, after
 * `execute`: a command that says it changed nothing (`changedNothing`)
 * leaves the stack as it was, the edits to redo included, and the
 * document's dirty state with it.
 */
@injectable()
export class WorkflowCommandStack extends DefaultCommandStack {
    override async execute(command: Command): Promise<void> {
        try {
            await command.execute();
        } catch (error) {
            this.handleError(error);
        }
        if (changedNothing(command)) {
            return;
        }
        // The rest is DefaultCommandStack.execute's (GLSP 2.7): the edits to
        // redo go, the command goes on top, and a save made at a state no
        // longer reachable leaves the stack dirty for good.
        this.commands = this.commands.slice(0, this.top + 1);
        this.commands.push(command);
        ++this.top;
        if (this.saveIndex >= this.top) {
            this.saveIndex = -2;
        }
    }
}
