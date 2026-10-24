# render-svg

Render a graph document to SVG headlessly, through the diagram server's layout
and the real diagram client, and write what the editor's **Export as SVG**
would write. For looking at what a change does to a real diagram, or how the
layouts compare, without opening VS Code.

```bash
# Any producer's plan command prints a graph document:
ndf diagram docs/pipeline.md --format graph --group refinement > doc.json

node scripts/render-svg/render.mjs doc.json --out pipeline.svg --png
node scripts/render-svg/render.mjs doc.json --out pipeline.svg --all-layouts   # -default, -untangled, -free-ports
node scripts/render-svg/render.mjs - --elk elk.direction=DOWN < doc.json        # an ELK option on top
```

| Option | What it does |
| --- | --- |
| `--out <path.svg>` | Where to write (default `./diagram.svg`) |
| `--png` | Also rasterise next to the SVG, with a Chrome screenshot |
| `--layout <name>` | `default`, `untangled` or `free-ports`: the editor's Layout menu |
| `--all-layouts` | Render all three, suffixing the output name |
| `--elk <key=value>` | An extra ELK graph option, repeatable |
| `--families <path.json>` | The product's node families (`NodeFamilySpec[]`), for its colours and icons |
| `--css <path.css>` | A product stylesheet, served after the platform's, repeatable |
| `--behavior <json>` | Client behavior flags, as a profile's `clientBehavior` |
| `--theme <dark\|light>` | The editor colours the page is drawn in (default dark) |
| `--states <path.json>` | Node states to draw (`ExecutionNodeState[]`, `[{ nodeId, status }]`), as a status source publishes them, through the client's own painter. A `nodeId` is the producer's id or the diagram's; ids this view does not have are skipped (a project's states fit any of its documents); `idle` draws nothing |
| `--chrome <path>` | Chrome or Chromium (default `$CHROME` or `google-chrome`) |
| `--keep` | Keep the schema, bundles and page in the work directory |

How it works: `build-schema.ts` runs `GraphGModelSource.transform`,
`convertToGModelRoot` and the `WorkflowElkLayoutEngine` with the
`WorkflowLayoutConfigurator`, as the server does on open, and writes the
laid-out model. `headless-entry.ts` builds the webview's container
(`createDiagramContainer` with the stock views) with a GLSP client that has no
server, pushes the model with `SetModelAction`, and extracts the drawing with
`svg-export.ts`. `render.mjs` bundles both with esbuild, runs the page in
headless Chrome and reads the result out of the dumped DOM. Modelled on
mlir-viewer's `scripts/render-symbol-svg`.
