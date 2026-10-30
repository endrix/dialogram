# elk-server

The Java ELK layout server the diagram server sends large graphs to
(`packages/diagram-server/src/server/elk-server/`). It is TypeFox's elk-server
(`io.typefox.elkserver`) with a gzip-framed socket mode added for
ascpp-graph-sprotty (its commit `af9cc65`).

## Where the source comes from

Only the built jar was ever committed anywhere (`elk-server-0.2.0-all.jar`, in
ascpp-graph-sprotty, mlir-viewer and here). These six classes were recovered
from it with the CFR decompiler (0.152), and are otherwise as the jar had them:
the same logic, wire format and log lines; CFR's expanded `try` blocks were
written back as try-with-resources.

The recovery was checked by building it on the ELK the jar bundled
(`-Delk.version=0.8.1 -Dmaven.compiler.release=11`) and laying out the graphs
the platform builds for six documents (a chain whose every id holds braces, two
grouped specification documents, a 148-node one, two HDL modules) on both jars
through the platform's gzip-framed client: every node, port and route came out
identical.

## The protocol

`java -jar elk-server-<version>-all.jar --socket` listens on
`ELK_SERVER_HOST`:`ELK_SERVER_PORT` (or the `elk.server.host` and
`elk.server.port` system properties; default localhost:5008) and logs
`ELK Gzip-Framed Server listening on <host>/<address>:<port>` when ready.

Each connection is framed or not by its first bytes:

- **Framed** (the only one the platform uses): every message, both ways, is the
  magic `GZ10`, the body's length in 4 bytes big-endian, and the body: gzip
  JSON. A request is an ELK JSON graph; the answer maps each element id to
  `{ position, size }`, or an edge id to `{ route }`, or is an error
  `{ message, name, stack }`. A body that is not gzip fails the connection
  without an answer, so a client compresses every request, however small.
- **Legacy**: plain JSON graphs back to back, found by counting braces, those
  in strings included. A brace inside an id leaves it waiting forever.

`--stdio` serves the legacy form on stdin and stdout.

## Building

```bash
mvn -q package    # target/elk-server-0.3.0-all.jar
cp target/elk-server-0.3.0-all.jar ../packages/diagram-server/resources/elk-server/
```

Maven 3.9 and a JDK 17. The shade plugin merges every dependency into the one
jar, keeping each ELK bundle's list of layout providers.

## ELK and elkjs

The server is built on the ELK the platform's elkjs is: ELK 0.10.0 and elkjs
0.10.0 lay every graph the parity test holds them to out alike, node for node
and route for route. elkjs 0.9.x matched no ELK release (0.9.1 and 0.10.0 each
differed on some graphs), which is why elkjs is pinned to an exact version.
To move to another ELK, raise `elk.version` here and `elkjs` in
`packages/diagram-server/package.json` to the same release, rebuild, copy the
jar, and run `test/elk-server-parity.test.ts`.

ELK 0.10 is built for Java 17, so the server needs Java 17 or later.
