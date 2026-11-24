/**
 * Where an untangle's port orders can go into the source.
 *
 * An untangle applied keeps each definition's port order with the diagram's
 * layout (definition-port-order.ts), whatever the product. A product whose
 * producer can rewrite the order a definition declares its ports in, where
 * that order means nothing else (no instance binds its ports by position),
 * binds a writer here; the orders it takes are written into the source, and
 * the layout keeps none of them. Without one (a read-only product binds
 * none), or where it says the diagram's source takes none, every order stays
 * with the layout and no file changes.
 *
 * The writer writes one definition at a time; the untangle reads each file
 * before, and puts every file back when a write is refused or fails, so that
 * nothing is left half done (apply-port-orders-handler.ts).
 */
import type { ModelState } from '@eclipse-glsp/server';

export const SOURCE_PORT_ORDER_WRITER = Symbol('SourcePortOrderWriter');

/** One definition's port order to write: all its ports, each once, by name, in the order to declare them. */
export interface PortOrderWrite {
    entity: string;
    /** One of its instances in this diagram: where its file is found from. */
    elementId: string;
    order: string[];
}

export interface SourcePortOrderWriter {
    /** Whether the diagram of `sourceUri` takes port orders into its source at all. */
    canWrite(sourceUri: string): Promise<boolean>;
    /** The file (a URI) the definition `write` names declares its ports in. */
    fileOf(modelState: ModelState, sourceUri: string, write: PortOrderWrite): string;
    /** Write one definition's order into `fileUri`: done, or refused with why. */
    write(sourceUri: string, fileUri: string, write: PortOrderWrite): Promise<{ ok: boolean; message?: string }>;
    /**
     * The other diagrams that draw the definition, as `name (file)`, which a
     * written order changes too; none when the producer cannot say.
     */
    usedElsewhere?(sourceUri: string, fileUri: string, entity: string): Promise<string[]>;
}
