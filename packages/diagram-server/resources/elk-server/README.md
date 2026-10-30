# ELK server

`elk-server-0.3.0-all.jar` is the Java ELK layout server the diagram server
uses for large graphs (`src/server/elk-server/`). A product ships it by
copying this file into its extension and naming it in its profile
(`elkServer: { jar: 'resources/elk-server/elk-server-0.3.0-all.jar' }`).

- What it is: TypeFox's elk-server (`io.typefox.elkserver`) with the
  gzip-framed socket mode added for ascpp-graph-sprotty (`af9cc65`), built as
  one fat jar from the source in [`elk-server/`](../../../../elk-server) at
  the repository root, recovered from the 0.2.0 jar.
- ELK: **0.10.0**, the release the platform's elkjs (pinned at 0.10.0) is
  built from, so the two engines lay a graph out alike;
  `test/elk-server-parity.test.ts` holds them to it. Raise elkjs and the
  jar's ELK together.
- SHA-256: `ee447412e076357d6d57eeea9686d5f9b34bebb2d5d1c53e7f43d4280f3d5e41`
- Needs: Java 17 or later (class file version 61) on the machine, since ELK
  0.10 is built for it. Without it every layout stays on elkjs.
- Run: `java -jar elk-server-0.3.0-all.jar --socket`, port from the
  `ELK_SERVER_PORT` environment variable. Talk to it only in the framed mode
  (`GZ10`, a 4-byte big-endian length, a gzip body, both ways): the plain JSON
  mode finds the end of a message by counting braces, and a brace inside an id
  hangs it.
- Licences: Eclipse ELK and the server under the Eclipse Public License 2.0;
  the bundled Gson and Guava under the Apache License 2.0 (their notices are
  inside the jar).
- Before: `elk-server-0.2.0-all.jar`, the same server on ELK 0.8.1, which
  laid some graphs out differently from elkjs 0.9.3 (node order, routes).
