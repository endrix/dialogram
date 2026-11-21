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

/** The host's ear for {@link OutOfBandWrite}s: one call per edit, with every file it wrote. */
export type OutOfBandWriteSink = (writes: readonly OutOfBandWrite[]) => void;

/** A command whose producer may write files itself, which can say, once executed, which. */
export interface CommandThatWritesOutOfBand extends Command {
    /** After `execute`: the files the producer wrote, each as it is now; none when it wrote nothing. */
    outOfBandWrites(): readonly OutOfBandWrite[];
}
