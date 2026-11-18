/**
 * The session's action dispatcher, which also tells the session's
 * {@link LoadCancellation} when a load has lost its reader.
 *
 * GLSP's dispatcher runs a session's requests one at a time. A request for
 * the model that arrives while another is loading waits in the queue for
 * that load to finish, so the only place that sees it arrive in time to
 * replace the load is `dispatch` itself. And the dispatcher is what the
 * session disposes when its editor closes.
 */

import { RequestModelAction, type Action } from '@eclipse-glsp/protocol';
import { DefaultActionDispatcher } from '@eclipse-glsp/server';
import { inject, injectable, optional } from 'inversify';
import { LoadCancellation } from './load-cancellation';
import { isBackgroundLoad } from './load-progress';

@injectable()
export class LoadCancellingActionDispatcher extends DefaultActionDispatcher {
    @inject(LoadCancellation)
    @optional()
    protected loadCancellation?: LoadCancellation;

    override dispatch(action: Action): Promise<void> {
        // From outside (the client, the host), and one the reader waits on: a
        // request a handler makes in the middle of a load runs inside it, and
        // a background one (a run's overlay being redrawn) is nobody's wait.
        if (
            this.loadCancellation &&
            RequestModelAction.is(action) &&
            !this.dispatchScope.isReentrant(action) &&
            !isBackgroundLoad(action.requestId, action.options)
        ) {
            this.loadCancellation.supersede();
        }
        return super.dispatch(action);
    }

    override dispose(): void {
        this.loadCancellation?.close();
        super.dispose();
    }
}
