/**
 * Container parity — the SP3 Task-2 oracle.
 *
 * The old monolith `workflowDiagramModule` mixed neutral GLSP infrastructure,
 * stock workflow model/view registration, and workflow feature UI. Task 2 splits
 * it into a neutral base module (`diagramBaseModule`) + `workflowViewsModule` +
 * `workflowFeaturesModule`, recomposed by `createDiagramContainer`. The shipped
 * stock bundle MUST behave identically.
 *
 * This test records the DI registrations of the modules the factory composes
 * (`composeDiagramModules`) and asserts their union equals a baseline captured
 * from the pre-refactor monolith (`fixtures/container-parity.baseline.json`,
 * generated from commit 26442ac's `workflowDiagramModule`). No binding may be
 * dropped, added, or altered. It also pins the module composition order.
 *
 * The baseline is no longer a pure capture of that commit: features added since
 * the split are appended to it deliberately, and the fixture currently carries
 * two additions — `IEdgeRouter -> LibavoidEdgeRouter` (the client-side live
 * routing tier) and `ChangeBoundsTool -> WorkflowChangeBoundsTool` (the
 * mouse-drag threshold) — plus one change: `label:boundary:type` is bound to
 * the non-editable `WorkflowLabel`, because editing it renamed the port.
 * The oracle still does its job: it fails on any binding this composition gains
 * or loses, and updating the fixture is the deliberate act of accepting one.
 * Regenerate it only after confirming the diff contains exactly the bindings the
 * change intends — never to make a red test go green.
 */
import { describe, it, expect } from 'vitest';
import baseline from './fixtures/container-parity.baseline.json';
import {
    recordModuleRegistrations,
    sortEntries,
    type RegistrationEntry
} from './container-registration-recorder';
import { composeDiagramModules } from '../src/container';
import { diagramBaseModule } from '../src/base.module';
import { workflowViewsModule } from '../src/stock-views.module';
import { workflowFeaturesModule } from '../src/stock-features.module';

const STOCK_FEATURES = [workflowViewsModule, workflowFeaturesModule];

describe('container parity — split modules reproduce the monolith', () => {
    it('the stock composition union equals the monolith baseline', () => {
        const composed = recordModuleRegistrations(
            composeDiagramModules({ clientId: 'workflow_0', features: STOCK_FEATURES })
        );
        expect(composed).toEqual(sortEntries(baseline as RegistrationEntry[]));
    });

    it('composes exactly [base, views, features] in order for the stock entry', () => {
        expect(composeDiagramModules({ clientId: 'workflow_0', features: STOCK_FEATURES })).toEqual([
            diagramBaseModule,
            workflowViewsModule,
            workflowFeaturesModule
        ]);
    });

    it('withStockViews prepends workflowViewsModule before consumer features', () => {
        expect(
            composeDiagramModules({ clientId: 'workflow_0', features: [workflowFeaturesModule], withStockViews: true })
        ).toEqual([diagramBaseModule, workflowViewsModule, workflowFeaturesModule]);
    });

    it('no stock model/view registration leaks into the neutral base', () => {
        const baseOnly = recordModuleRegistrations([diagramBaseModule]);
        const stockModelElements = baseOnly.filter(
            entry => entry.op === 'modelElement' && !String(entry.typeId).includes('routing')
        );
        expect(stockModelElements).toEqual([]);
    });
});
