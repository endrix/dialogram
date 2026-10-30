// SPDX-License-Identifier: EPL-2.0
package io.typefox.elkserver;

import com.google.gson.Gson;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.eclipse.elk.alg.force.options.ForceMetaDataProvider;
import org.eclipse.elk.alg.layered.options.LayeredMetaDataProvider;
import org.eclipse.elk.alg.mrtree.options.MrTreeMetaDataProvider;
import org.eclipse.elk.core.data.LayoutMetaDataService;
import org.eclipse.elk.graph.ElkBendPoint;
import org.eclipse.elk.graph.ElkEdge;
import org.eclipse.elk.graph.ElkEdgeSection;
import org.eclipse.elk.graph.ElkLabel;
import org.eclipse.elk.graph.ElkNode;
import org.eclipse.elk.graph.ElkPort;
import org.eclipse.elk.graph.ElkShape;
import org.eclipse.elk.graph.json.ElkGraphJson;

/** A layout server: reads ELK JSON graphs, lays them out, answers with the positions, sizes and routes. */
public abstract class AbstractElkServer {

    private static final int STRING_BUILDER_CAPACITY = 262144;

    public void start() {
        initialize();
        try {
            run();
        } catch (Throwable thr) {
            thr.printStackTrace();
            System.exit(1);
        }
    }

    protected void initialize() {
        LayoutMetaDataService.getInstance().registerLayoutMetaDataProviders(
                new LayeredMetaDataProvider(), new ForceMetaDataProvider(), new MrTreeMetaDataProvider());
    }

    protected abstract void run() throws Exception;

    /**
     * One graph from a stream of concatenated JSON objects, found by counting
     * braces, those inside strings included: a brace in an id leaves it waiting.
     * The framed socket mode does not use it.
     */
    protected ElkNode readGraph(InputStream input) throws IOException {
        int objLevel = 0;
        StringBuilder strBuilder = new StringBuilder(STRING_BUILDER_CAPACITY);
        do {
            int ch = input.read();
            if (ch < 0) {
                return null;
            }
            if (ch == '{') {
                objLevel++;
            } else if (ch == '}') {
                objLevel--;
            }
            strBuilder.append((char) ch);
        } while (objLevel > 0);
        return ElkGraphJson.forGraph(strBuilder.toString()).toElk();
    }

    protected void writeLayoutData(ElkNode graph, Appendable output, Gson gson) {
        Map<String, JsonObjects.LayoutElement> data = new LinkedHashMap<>();
        computeLayoutData(graph, data);
        gson.toJson(data, output);
    }

    protected void computeLayoutData(ElkNode node, Map<String, JsonObjects.LayoutElement> data) {
        if (node.getIdentifier() != null) {
            data.put(node.getIdentifier(), getShapeLayout(node));
        }
        for (ElkLabel label : node.getLabels()) {
            if (label.getIdentifier() != null) {
                data.put(label.getIdentifier(), getShapeLayout(label));
            }
        }
        for (ElkPort port : node.getPorts()) {
            if (port.getIdentifier() != null) {
                data.put(port.getIdentifier(), getShapeLayout(port));
            }
            for (ElkLabel label : port.getLabels()) {
                if (label.getIdentifier() != null) {
                    data.put(label.getIdentifier(), getShapeLayout(label));
                }
            }
        }
        for (ElkEdge edge : node.getContainedEdges()) {
            if (edge.getIdentifier() != null) {
                data.put(edge.getIdentifier(), getEdgeLayout(edge));
            }
        }
        for (ElkNode child : node.getChildren()) {
            computeLayoutData(child, data);
        }
    }

    protected JsonObjects.ShapeLayoutElement getShapeLayout(ElkShape shape) {
        JsonObjects.Point position = new JsonObjects.Point(shape.getX(), shape.getY());
        JsonObjects.Dimension size = new JsonObjects.Dimension(shape.getWidth(), shape.getHeight());
        return new JsonObjects.ShapeLayoutElement(position, size);
    }

    protected JsonObjects.EdgeLayoutElement getEdgeLayout(ElkEdge edge) {
        if (edge.getSections().isEmpty()) {
            return new JsonObjects.EdgeLayoutElement(Collections.emptyList());
        }
        ElkEdgeSection section = edge.getSections().get(0);
        List<JsonObjects.Point> routingPoints = new ArrayList<>();
        routingPoints.add(new JsonObjects.Point(section.getStartX(), section.getStartY()));
        for (ElkBendPoint bendPoint : section.getBendPoints()) {
            routingPoints.add(new JsonObjects.Point(bendPoint.getX(), bendPoint.getY()));
        }
        routingPoints.add(new JsonObjects.Point(section.getEndX(), section.getEndY()));
        return new JsonObjects.EdgeLayoutElement(routingPoints);
    }
}
