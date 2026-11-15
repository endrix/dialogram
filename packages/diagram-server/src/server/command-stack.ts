import { Command, CompoundCommand, CompoundOperationHandler, DefaultCommandStack } from '@eclipse-glsp/server';
import type { CompoundOperation } from '@eclipse-glsp/protocol';
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

/**
 * Whether `command`, executed, says it changed nothing. One that cannot say
 * has changed something; GLSP's compound changed nothing when none of its
 * parts did.
 */
export function changedNothing(command: Command): boolean {
    const candidate = command as Partial<CommandThatMayChangeNothing>;
    if (typeof candidate.changedNothing === 'function') {
        return candidate.changedNothing() === true;
    }
    if (command instanceof CompoundCommand) {
        return partsOf(command).every(changedNothing);
    }
    return false;
}

/** The parts of a compound command, in order (GLSP keeps them protected). */
function partsOf(command: CompoundCommand): Command[] {
    return (command as unknown as { commands: Command[] }).commands;
}

/**
 * GLSP's compound command, of parts that may change nothing. It changed
 * nothing when none of its parts did, so the stack keeps it only when one
 * wrote; and it can be undone when each part that changed something can.
 * GLSP's own asks that of every part, and a part that wrote nothing (one
 * operation of several that the producer refused) cannot be undone: the
 * whole would then keep Undo from the edits below it. Undoing a part that
 * changed nothing does nothing.
 */
export class CompoundCommandThatMayChangeNothing extends CompoundCommand implements CommandThatMayChangeNothing {
    changedNothing(): boolean {
        return this.commands.every(changedNothing);
    }

    override canUndo(): boolean {
        return this.commands.every(command => changedNothing(command) || Command.canUndo(command));
    }
}

/**
 * GLSP's handler of several operations sent as one (a `CompoundOperation`),
 * making a {@link CompoundCommandThatMayChangeNothing} of their commands, so
 * one of them refused keeps neither the whole off the stack nor Undo from it.
 */
@injectable()
export class WorkflowCompoundOperationHandler extends CompoundOperationHandler {
    override async createCommand(operation: CompoundOperation): Promise<Command | undefined> {
        const command = await super.createCommand(operation);
        return command instanceof CompoundCommand ? new CompoundCommandThatMayChangeNothing(partsOf(command)) : command;
    }
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
