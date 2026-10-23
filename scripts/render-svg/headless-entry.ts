/**
 * Step 2 of the headless renderer: a laid-out GModel schema in, the rendered
 * SVG out, in a real browser, through the real client.
 *
 * The container is the one the webview builds (`createDiagramContainer` with
 * the stock views), with a GLSP client that has no server: the model is pushed
 * with `SetModelAction`, positions already set by the server-side layout. The
 * stylesheets are the webview's, plus the product's own. The SVG comes out of
 * the same extractor as the editor's "Export as SVG", so what is written is
 * what the editor would export.
 *
 * The page hands the result back in a hidden `<pre id="result">`, which the
 * driver reads out of the dumped DOM.
 */
import 'reflect-metadata';
import '@eclipse-glsp/vscode-integration-webview/css/glsp-vscode.css';
import '@eclipse-glsp/client/css/grid.css';
import '@vscode/codicons/dist/codicon.css';
import '../../packages/diagram-client/src/diagram-client.css';
import {
    TYPES,
    IActionDispatcher,
    DiagramLoader,
    createDiagramOptionsModule,
    SetModelAction,
    InitializeCanvasBoundsAction,
    overrideViewerOptions,
    GLSPClient,
    ClientState
} from '@eclipse-glsp/client';
import {
    Emitter,
    Event as GlspEvent,
    Disposable,
    ActionMessage,
    ActionMessageHandler,
    InitializeParameters,
    InitializeResult,
    InitializeClientSessionParameters,
    DisposeClientSessionParameters
} from '@eclipse-glsp/protocol';
import { createDiagramContainer } from '../../packages/diagram-client/src/container';
import { ExecutionOverlayMessageBridge } from '../../packages/diagram-client/src/execution-overlay-message-bridge';
import { showExecutionStates } from '../../packages/diagram-client/src/execution-states';
import { extractSvg, renderedDiagram } from '../../packages/diagram-client/src/svg-export';

const DIAGRAM_TYPE = 'dialogram-headless';
const CLIENT_ID = 'dialogram-headless';

/** No server: the model is pushed locally. */
class StubGLSPClient implements GLSPClient {
    constructor(readonly id: string) {}
    readonly currentState: ClientState = ClientState.Running;
    private readonly stateEmitter = new Emitter<ClientState>();
    readonly onCurrentStateChanged: GlspEvent<ClientState> = this.stateEmitter.event;
    private readonly initEmitter = new Emitter<InitializeResult>();
    readonly onServerInitialized: GlspEvent<InitializeResult> = this.initEmitter.event;
    initializeResult: InitializeResult | undefined = {
        protocolVersion: '1.0.0',
        serverActions: { [DIAGRAM_TYPE]: [] }
    };
    async start(): Promise<void> {}
    async initializeServer(_params: InitializeParameters): Promise<InitializeResult> {
        return this.initializeResult!;
    }
    async initializeClientSession(_params: InitializeClientSessionParameters): Promise<void> {}
    async disposeClientSession(_params: DisposeClientSessionParameters): Promise<void> {}
    onActionMessage(_handler: ActionMessageHandler, _clientId?: string): Disposable {
        return Disposable.create(() => undefined);
    }
    sendActionMessage(_message: ActionMessage): void {}
    async shutdownServer(): Promise<void> {}
    async stop(): Promise<void> {}
}

function report(result: unknown): void {
    const out = document.createElement('pre');
    out.id = 'result';
    out.style.display = 'none';
    out.textContent = JSON.stringify(result);
    document.body.appendChild(out);
}

async function main(): Promise<void> {
    const schema = (window as any).__SCHEMA__;
    const container = createDiagramContainer(
        { clientId: CLIENT_ID, features: [], withStockViews: true },
        createDiagramOptionsModule({
            clientId: CLIENT_ID,
            diagramType: DIAGRAM_TYPE,
            sourceUri: 'dialogram-headless://render',
            glspClientProvider: async () => new StubGLSPClient(CLIENT_ID)
        })
    );
    overrideViewerOptions(container as never, {
        baseDiv: CLIENT_ID,
        hiddenDiv: `${CLIENT_ID}_hidden`,
        popupDiv: `${CLIENT_ID}_popup`,
        needsClientLayout: false,
        needsServerLayout: false,
        zoomLimits: { min: 0.001, max: 50 }
    });

    const loader = container.get(DiagramLoader);
    try {
        await loader.load();
    } catch {
        // The stub answers no RequestModel; the model is pushed below.
    }
    const dispatcher = container.get<IActionDispatcher>(TYPES.IActionDispatcher);
    await dispatcher.dispatch(SetModelAction.create(schema));
    // Sprotty culls against the canvas bounds held in the model; announce a
    // canvas larger than any diagram so nothing is culled at zoom 1.
    const canvas = Number((window as any).__CANVAS__) || 0;
    if (canvas > 0) {
        await dispatcher.dispatch(InitializeCanvasBoundsAction.create({ x: 0, y: 0, width: canvas, height: canvas }));
    }
    // Node states, as a status source's answer reaches the webview: the
    // bridge hands the feedback dispatcher to the painter (the loader may not
    // have, with no server to answer it), and the states go on as feedback.
    const states = (window as any).__STATES__;
    if (Array.isArray(states) && states.length > 0) {
        container.get(ExecutionOverlayMessageBridge).postModelInitialization();
        showExecutionStates(states);
    }
    // Snabbdom patches on an animation frame; wait for the DOM to exist.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    const rendered = renderedDiagram();
    const result = rendered ? extractSvg(rendered.graph, 'diagram', true) : undefined;
    report(result
        ? { name: result.name, elementCount: result.elementCount, svg: result.svg }
        : { error: 'nothing rendered (no .sprotty svg in the page)' });
}

main().catch(error => report({ error: String(error?.stack ?? error) }));
