# ELK server

`elk-server-0.2.0-all.jar` is the Java ELK layout server the diagram server
uses for large graphs (`src/server/elk-server/`). A product ships it by
copying this file into its extension and naming it in its profile
(`elkServer: { jar: 'resources/elk-server/elk-server-0.2.0-all.jar' }`).

- What it is: TypeFox's elk-server 0.2.0 (`io.typefox.elkserver`), with a
  gzip-framed socket mode added, built as one fat jar. It bundles Eclipse ELK
  **0.8.1**; the platform's elkjs is 0.9.3, so the two engines can lay the
  same graph out differently. A rebuild on the ELK that elkjs carries is
  planned once the sources are located.
- Where it comes from: byte-identical to mlir-viewer's
  `packages/vscode/resources/elk-server/elk-server-0.2.0/` and to
  ascpp-graph-sprotty's `resources/elk-server/elk-server-0.2.0/` (commit
  `af9cc65`, which added the framing).
- SHA-256: `7018ac49eec47197b91f70bc5ce19754f64cad70209bf6e5c678c670ec96407d`
- Needs: Java 11 or later (class file version 55) on the machine. Without
  Java every layout stays on elkjs.
- Run: `java -jar elk-server-0.2.0-all.jar --socket`, port from the
  `ELK_SERVER_PORT` environment variable. Talk to it only in the framed mode
  (`GZ10`, a 4-byte big-endian length, a gzip body, both ways): the plain JSON
  mode finds the end of a message by counting braces, and a brace inside an id
  hangs it.
- Licences: Eclipse ELK and the server under the Eclipse Public License 2.0;
  the bundled Gson and Guava under the Apache License 2.0 (their notices are
  inside the jar).
