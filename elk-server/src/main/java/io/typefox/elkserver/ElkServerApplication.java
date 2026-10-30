// SPDX-License-Identifier: EPL-2.0
/*
 * The ELK layout server: TypeFox's elk-server 0.2.0, with the gzip-framed socket
 * mode added for ascpp-graph-sprotty (af9cc65). Recovered from the shipped
 * elk-server-0.2.0-all.jar (decompiled with CFR 0.152), its logic, wire format and
 * log lines unchanged; see ../../../../../../README.md.
 */
package io.typefox.elkserver;

import java.util.Arrays;
import java.util.List;

public class ElkServerApplication {

    public static void main(String[] args) {
        List<String> argsList = Arrays.asList(args);
        boolean stdio = argsList.contains("--stdio");
        boolean socket = argsList.contains("--socket");
        if (!stdio && !socket) {
            System.err.println("The server must be started with either --stdio or --socket argument.");
            System.exit(1);
        }
        if (stdio && socket) {
            System.err.println("The --stdio and --socket arguments cannot be used at the same time.");
            System.exit(1);
        }
        if (stdio) {
            new StdioElkServer().start();
        }
        if (socket) {
            new GzipFramedSocketElkServer().start();
        }
    }
}
