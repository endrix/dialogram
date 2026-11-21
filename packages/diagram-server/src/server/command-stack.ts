import { Command, CompoundCommand, CompoundOperationHandler, DefaultCommandStack } from '@eclipse-glsp/server';
import type { CompoundOperation } from '@eclipse-glsp/protocol';
import { inject, injectable, optional } from 'inversify';
import { OUT_OF_BAND_WRITE_SINK, type CommandThatWritesOutOfBand, type OutOfBandWrite, type OutOfBandWriteSink } from './out-of-band-writes';

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

/**
 * A command that can say, once undone or redone, that it did nothing: the
 * document had changed outside the diagram, which it said, or the edit was
 * refused. It is then still the edit to undo (or redo).
 */
export interface CommandThatMayRefuse extends Command {
    /** After `undo` or `redo`: true when it did nothing. */
    refused(): boolean;
}

/**
 * Whether `command`, undone or redone, did nothing. GLSP's compound did
 * nothing when every part that wrote did nothing; one that cannot say did
 * what it was asked.
 */
export function refused(command: Command | undefined): boolean {
    if (!command) {
        return false;
    }
    const candidate = command as Partial<CommandThatMayRefuse>;
    if (typeof candidate.refused === 'function') {
        return candidate.refused() === true;
    }
    if (command instanceof CompoundCommand) {
        const wrote = partsOf(command).filter(part => !changedNothing(part));
        return wrote.length > 0 && wrote.every(refused);
    }
    return false;
}

/**
 * The files `command`, executed, had its producer write, each as it is now.
 * A compound's are its parts', a file two parts wrote as the last left it;
 * one that cannot say wrote nothing out of band.
 */
export function outOfBandWrites(command: Command): OutOfBandWrite[] {
    const candidate = command as Partial<CommandThatWritesOutOfBand>;
    if (typeof candidate.outOfBandWrites === 'function') {
        return [...candidate.outOfBandWrites()];
    }
    if (command instanceof CompoundCommand) {
        const byUri = new Map<string, OutOfBandWrite>();
        for (const write of partsOf(command).flatMap(outOfBandWrites)) {
            byUri.delete(write.uri);
            byUri.set(write.uri, write);
        }
        return [...byUri.values()];
    }
    return [];
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
export class CompoundCommandThatMayChangeNothing extends CompoundCommand implements CommandThatMayChangeNothing, CommandThatMayRefuse {
    private refusedLast = false;

    changedNothing(): boolean {
        return this.commands.every(changedNothing);
    }

    /** Whether the last undo or redo did nothing: a part refused, and the parts done before it were put back. */
    refused(): boolean {
        return this.refusedLast;
    }

    /**
     * Its parts undone last first, as GLSP's; but a part refused (its file
     * changed outside the diagram) stops the undo, and the parts already
     * undone are redone: the edit is undone whole or not at all, and the
     * stack keeps it as the edit to undo.
     */
    override async undo(): Promise<void> {
        this.refusedLast = await this.applyAll([...this.commands].reverse(), part => part.undo(), part => part.redo());
    }

    /** As `undo`, first part first. */
    override async redo(): Promise<void> {
        this.refusedLast = await this.applyAll(this.commands, part => part.redo(), part => part.undo());
    }

    /** `apply` to each of `parts` in turn; on one refused, `back` to those done, last done first. True when one refused. */
    private async applyAll(parts: Command[], apply: (part: Command) => unknown, back: (part: Command) => unknown): Promise<boolean> {
        const done: Command[] = [];
        try {
            for (const part of parts) {
                await apply(part);
                if (refused(part)) {
                    for (const each of done) {
                        await back(each);
                    }
                    return true;
                }
                done.unshift(part);
            }
        } catch (error) {
            for (const each of done) {
                await back(each);
            }
            throw error;
        }
        return false;
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
 *
 * A command whose producer wrote files itself is told to the host
 * ({@link OUT_OF_BAND_WRITE_SINK}), which reloads what they affect: nothing
 * else in VS Code saw the write.
 */
@injectable()
export class WorkflowCommandStack extends DefaultCommandStack {
    @inject(OUT_OF_BAND_WRITE_SINK)
    @optional()
    protected readonly outOfBandWriteSink?: OutOfBandWriteSink;

    override async execute(command: Command): Promise<void> {
        try {
            await command.execute();
        } catch (error) {
            this.handleError(error);
        }
        if (changedNothing(command)) {
            return;
        }
        this.tellOutOfBandWrites(command);
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

    /**
     * Tell the host what `command` had its producer write. The edit is made
     * whatever the host does with it: a host that fails is logged.
     */
    private tellOutOfBandWrites(command: Command): void {
        if (!this.outOfBandWriteSink) {
            return;
        }
        const writes = outOfBandWrites(command);
        if (writes.length === 0) {
            return;
        }
        try {
            this.outOfBandWriteSink(writes);
        } catch (error) {
            console.warn('[WorkflowCommandStack] the host could not be told what the producer wrote:', error);
        }
    }

    /**
     * GLSP's undo moves down the stack before it undoes, whatever the undo
     * did. One refused (the document changed outside the diagram) did
     * nothing, and stays the edit to undo: moved past, it would be redone
     * on a text it was not made on, and every undo below it be refused in
     * turn, each finding the text of the one above.
     */
    override async undo(): Promise<void> {
        const at = this.top;
        await super.undo();
        if (this.top === at - 1 && refused(this.commands[at])) {
            this.top = at;
        }
    }

    /** As `undo`: a redo refused stays the edit to redo. */
    override async redo(): Promise<void> {
        const at = this.top;
        await super.redo();
        if (this.top === at + 1 && refused(this.commands[at + 1])) {
            this.top = at;
        }
    }
}
