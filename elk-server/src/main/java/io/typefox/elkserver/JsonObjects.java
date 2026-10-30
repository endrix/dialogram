// SPDX-License-Identifier: EPL-2.0
package io.typefox.elkserver;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.List;

/** The answer's JSON shapes: per element id, a position and size, or an edge's route; or an error. */
public final class JsonObjects {

    private JsonObjects() {
    }

    public interface LayoutElement {
    }

    public static class ShapeLayoutElement implements LayoutElement {
        public Point position;
        public Dimension size;

        public ShapeLayoutElement(Point position, Dimension size) {
            this.position = position;
            this.size = size;
        }
    }

    public static class EdgeLayoutElement implements LayoutElement {
        public List<Point> route;

        public EdgeLayoutElement(List<Point> route) {
            this.route = route;
        }
    }

    public static class Point {
        public double x;
        public double y;

        public Point(double x, double y) {
            this.x = x;
            this.y = y;
        }
    }

    public static class Dimension {
        public double width;
        public double height;

        public Dimension(double width, double height) {
            this.width = width;
            this.height = height;
        }
    }

    public static class Error {
        public String message;
        public String name;
        public String stack;

        public Error(Exception exception) {
            this.message = exception.getMessage();
            this.name = exception.getClass().getSimpleName();
            StringWriter sw = new StringWriter();
            exception.printStackTrace(new PrintWriter(sw));
            this.stack = sw.toString();
        }
    }
}
