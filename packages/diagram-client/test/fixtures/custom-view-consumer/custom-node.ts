/**
 * A custom-view consumer's model element — the shape an external consumer
 * (e.g. mlir in SP4) registers through `configureModelElement`. It extends
 * GLSP's OWN base class (`RectangularNode`), not any stock diagram-client class:
 * the library owns NO product-specific model, so a fully custom consumer needs
 * nothing from `./model`.
 */
import { RectangularNode } from '@eclipse-glsp/client';

/** Consumer-owned type id (not a library/GLSP constant). */
export const CUSTOM_DEMO_NODE_TYPE = 'custom:demo-node';

/** A trivial custom node the fixture registers to prove the consumer path. */
export class CustomDemoNode extends RectangularNode {
    override type = CUSTOM_DEMO_NODE_TYPE;
}
