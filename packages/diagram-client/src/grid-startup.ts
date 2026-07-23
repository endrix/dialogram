import { IDiagramStartup, IGridManager, TYPES } from '@eclipse-glsp/client';
import { inject, injectable, optional } from 'inversify';

@injectable()
export class WorkflowGridStartup implements IDiagramStartup {
    /** Run early during startup so the first render already has a grid. */
    rank = -100;

    @optional()
    @inject(TYPES.IGridManager)
    protected gridManager?: IGridManager;

    preInitialize(): void {
        this.gridManager?.setGridVisible(true);
    }
}
