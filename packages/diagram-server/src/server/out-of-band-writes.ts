/**
 * The files an edit's producer wrote itself, told to the host.
 *
 * Many edits are written by the product's producer, on disk; the editor applies
 * nothing, and nothing in VS Code sees the write happen. The diagram is read
 * again only once the host hears that the file changed, and it heard that
 * only from its file watcher. A watcher can fail: on a machine out of
 * inotify instances, every new window's watcher reports nothing. The diagram
 * then stayed as it was, the edit written and not drawn.
 *
 * So the command stack, once it has executed an edit, tells the host which
 * files the producer wrote and what they hold now
 * ({@link OUT_OF_BAND_WRITE_SINK}), and the host reloads the diagrams they
 * affect without waiting for the watcher. When the watcher's report of the
 * same write comes, it finds the text the diagram was read from, and the
 * host reloads nothing more.
 *
 * Undo and redo are told the same way when they write on disk: where the
 * editor's copy of a file lags it (the watcher reported no write), they put
 * the file back where the producer wrote it (see file-on-disk.ts).
 */
import type { Command } from '@eclipse-glsp/server';

/** A file the producer wrote, as it is since. */
export interface OutOfBandWrite {
    /** The file, as a URI string. */
    uri: string;
    /** What it holds since the write. */
    text: string;
}

/** Where the command stack tells the host what an edit wrote out of band. */
export const OUT_OF_BAND_WRITE_SINK = Symbol('OutOfBandWriteSink');

/** The host's ear for {@link OutOfBandWrite}s: one call per edit, undo or redo, with every file it wrote. */
export type OutOfBandWriteSink = (writes: readonly OutOfBandWrite[]) => void;

/** A command that may write files out of band, which can say, once executed, undone or redone, which. */
export interface CommandThatWritesOutOfBand extends Command {
    /**
     * After `execute`, `undo` or `redo`: the files it wrote out of band (its
     * producer, or its undo on disk), each as it is now; none when it wrote
     * nothing so.
     */
    outOfBandWrites(): readonly OutOfBandWrite[];
}
