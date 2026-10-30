package io.typefox.elkserver;

import com.google.gson.Gson;
import org.eclipse.elk.core.RecursiveGraphLayoutEngine;
import org.eclipse.elk.core.util.BasicProgressMonitor;
import org.eclipse.elk.graph.ElkNode;

/** Plain JSON graphs on stdin, answers on stdout ({@code --stdio}). */
public class StdioElkServer extends AbstractElkServer {

    @Override
    protected void run() throws Exception {
        RecursiveGraphLayoutEngine engine = new RecursiveGraphLayoutEngine();
        Gson gson = new Gson();
        ElkNode graph;
        while ((graph = readGraph(System.in)) != null) {
            try {
                engine.layout(graph, new BasicProgressMonitor());
                writeLayoutData(graph, System.out, gson);
            } catch (Exception exc) {
                gson.toJson(new JsonObjects.Error(exc), System.out);
            }
        }
    }
}
