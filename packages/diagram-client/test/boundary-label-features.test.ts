/**
 * Boundary labels must not participate in layout.
 *
 * `WorkflowLabelView` positions a boundary node's name and type itself, relative
 * to the parent node and centred on the parent's width. That only works while
 * the labels are invisible to the layout engine — so both boundary label classes
 * REPLACE sprotty's default label features, which include `boundsFeature`,
 * `alignFeature` and `layoutableChildFeature`.
 *
 * This has already been broken once. Making the type label non-editable by
 * pointing it at the generic `WorkflowLabel` looked like a pure capability
 * change, but `WorkflowLabel` declares no features of its own and therefore
 * inherits sprotty's — so the layout engine claimed the label and parked it in
 * the node's top-left corner, small and outside the rounded box. Nothing failed;
 * it only looked wrong.
 *
 * The trap is inheritance, so that is what these assert: each boundary label
 * declares its OWN feature list, and that list contains no layout feature. The
 * real sprotty defaults are read through `createRequire` — the vitest alias
 * points `@eclipse-glsp/sprotty` at a stub, and asserting against the stub's
 * (empty) defaults would pass no matter what.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { BoundaryEditableLabel, BoundaryLabel, WorkflowLabel } from '../src/model';

const { SLabelImpl } = createRequire(import.meta.url)('sprotty/lib/graph/sgraph');

/** Feature symbols compared by description: the stub's and sprotty's differ by identity. */
const describeAll = (features: readonly symbol[] | undefined): string[] =>
    (features ?? []).map(f => String(f));

const LAYOUT_FEATURES = ['Symbol(boundsFeature)', 'Symbol(alignFeature)', 'Symbol(layoutableChildFeature)'];

describe('boundary label features', () => {
    /** If sprotty ever stopped defaulting labels into layout, this whole concern would be moot. */
    it("sprotty's own label defaults are the hazard", () => {
        const defaults = describeAll(SLabelImpl.DEFAULT_FEATURES);

        for (const feature of LAYOUT_FEATURES) {
            expect(defaults, `sprotty labels no longer default to ${feature}`).toContain(feature);
        }
    });

    it.each([
        ['BoundaryLabel', BoundaryLabel],
        ['BoundaryEditableLabel', BoundaryEditableLabel]
    ])('%s declares its own features rather than inheriting', (name, cls) => {
        // The inheritance trap: a class that does not declare DEFAULT_FEATURES
        // silently takes sprotty's, layout features and all.
        expect(
            Object.prototype.hasOwnProperty.call(cls, 'DEFAULT_FEATURES'),
            `${name} must declare DEFAULT_FEATURES, not inherit them`
        ).toBe(true);
    });

    it.each([
        ['BoundaryLabel', BoundaryLabel],
        ['BoundaryEditableLabel', BoundaryEditableLabel]
    ])('%s carries no layout feature', (name, cls) => {
        // EFFECTIVE features, the way sprotty resolves them: a class without its
        // own list gets sprotty's. Reading only the own list would make this
        // pass for a class that inherits every layout feature there is — which
        // is precisely the regression, so it has to be modelled here.
        const own = (cls as { DEFAULT_FEATURES?: symbol[] }).DEFAULT_FEATURES;
        const effective = describeAll(own ?? SLabelImpl.DEFAULT_FEATURES);

        for (const feature of LAYOUT_FEATURES) {
            expect(effective, `${name} would be positioned by the layout engine`).not.toContain(feature);
        }
    });

    /**
     * The class the regression reached for. Pinning that it is NOT safe here is
     * what makes the distinction visible to the next person.
     */
    it('the generic WorkflowLabel is not a valid boundary label', () => {
        expect(Object.prototype.hasOwnProperty.call(WorkflowLabel, 'DEFAULT_FEATURES')).toBe(false);
    });
});
