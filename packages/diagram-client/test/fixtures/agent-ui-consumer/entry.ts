// A product's own webview bundle that loads the agent workflow UI itself,
// through the path import `src/agent-ui/index.ts` documents.
import { startStockDiagram } from '@dialogram/diagram-client/stock-starter';
import '@dialogram/diagram-client/diagram-client.css';
import { agentUiModule } from '@dialogram/diagram-client/agent-ui/index';

startStockDiagram({ features: [agentUiModule] });
