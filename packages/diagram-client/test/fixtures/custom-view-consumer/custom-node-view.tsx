/**
 * A custom Sprotty view for {@link CustomDemoNode} — the mlir-shaped consumer
 * asset: a `.tsx` `IView` authored with the Sprotty `svg` JSX factory and
 * bundled by the consumer's OWN esbuild (`--jsx-factory=svg`). The library never
 * sees this class type; it only accepts it through `configureModelElement`.
 *
 * The `@jsx svg` pragma pins the factory per-file, so the same source compiles
 * under the fixture's standalone esbuild build AND under vitest's transform.
 */
/** @jsx svg */
import { injectable } from 'inversify';
import { svg, RenderingContext, ShapeView, GShapeElement } from '@eclipse-glsp/client';
import type { VNode } from 'snabbdom';

@injectable()
export class CustomDemoNodeView extends ShapeView {
    override render(node: Readonly<GShapeElement>, _context: RenderingContext): VNode | undefined {
        return (
            <g class-custom-demo-node={true}>
                <rect x={0} y={0} width={80} height={40} rx={4} />
            </g>
        ) as unknown as VNode;
    }
}
