# Proposal: structured port types

**Status:** proposal — nothing here is implemented in any sidecar.
**Affects:** the graph export schema and the operation vocabulary, so **every**
sidecar has to implement it identically or the platform behaves differently per
product.

## Why

Three things users ask for are blocked in the same place, and none of them can
be fixed in the platform:

1. **Editing a boundary port's type.** The platform has no operation that can
   address a boundary port for an update.
2. **A viewer for composite types** (products and variants) in the property
   panel.
3. **Go to the definition of a type**, from a port.

A fourth turned up while investigating them: a boundary port has no source
location at all, so "Go to Source" does not even reach the port, let alone its
type. That one is much smaller — see Part C.

(2) and (3) are blocked by one line of the export schema:

```ts
export type PyGraphPort = {
    id: string;
    name: string;
    direction: 'in' | 'out';
    type?: string;          // ← the whole type, as text
    role?: string;
    source?: { file?: string; line?: number } | null;
};
```

A type is opaque text. There is no structure to render and no location to
navigate to, and the platform cannot derive either: it never parses source —
that is the sidecar's entire job.

`source` is the **port's** declaration site. It is not where the type is
defined, and it is already used for "go to source" on the port itself.

## Part A — editing a boundary port's type

### The gap

Port operations already split by ownership, and address the two cases
differently:

| | addressed by | direction key |
| --- | --- | --- |
| `createPort` (boundary) | `workflow` | `direction` |
| `deletePort` (boundary) | `workflow` | `direction` |
| `createEntityPort` | `entityType` | `portDirection` |
| `deleteEntityPort` | `entityType` | `portDirection` |
| `renamePort` | `entity` | `portDirection` |
| `updatePortType` | `entity` | `portDirection` |

A boundary port belongs to the network, not to any entity, so `updatePortType`
cannot name it. `createPort` already writes a boundary port's type — the
capability exists in the sidecar; only the update path is missing.

### Proposed operation

```
updateBoundaryPortType
  args: { workflow: string, direction: 'input' | 'output',
          portName: string, newValue: string }
```

Addressed the way the other boundary port ops are. A separate op rather than a
`workflow` variant of `updatePortType`, because that op's `entity` is required
today and overloading it would make an un-updated sidecar interpret a boundary
edit as an entity edit — silently, against the wrong declaration.

Renaming a boundary port needs nothing new: it already rides `renameNode`.

## Part B — structured types

### Proposed schema

Additive and optional. A sidecar that has not implemented it emits nothing new,
and the platform behaves exactly as it does today.

```ts
export type PyTypeRef = {
    /** Rendered form, in the language's own formatting. ALWAYS present. */
    text: string;
    kind?: 'primitive' | 'alias' | 'product' | 'variant' | 'list' | 'unknown';
    /** The declared name, when it has one. */
    name?: string;
    /** Where the type is DEFINED. Not the port's declaration site. */
    source?: { file?: string; line?: number } | null;
    /** Fields of a product; cases of a variant. Omitted for other kinds. */
    members?: Array<{
        name: string;
        type?: PyTypeRef;
        source?: { file?: string; line?: number } | null;
    }>;
    /** Set when expansion stopped here rather than bottoming out. */
    truncated?: boolean;
};

export type PyGraphPort = {
    // ...unchanged...
    type?: string;        // unchanged; stays the display fallback
    typeRef?: PyTypeRef;  // NEW, optional
};
```

### Why it is shaped this way

**`text` is mandatory and `type` stays.** The platform must never re-render a
type from its structure — it would drift from how the language actually writes
it, and differ between products. The sidecar formats; the platform displays.
Keeping `type` means the change cannot regress an existing diagram.

**Expansion is bounded by the sidecar, not the platform.** A recursive type
would otherwise be an unbounded payload on every graph export. The sidecar
expands to whatever depth it judges reasonable and sets `truncated: true` where
it stopped; the platform shows an affordance that *navigates* rather than
expands, so depth is never the platform's problem.

**`kind` is open and `'unknown'` is legal.** A type the sidecar cannot resolve
must still round-trip its `text`. Partial information is expected — a graph
export is already allowed to be `partial`.

**`source` on each member.** Navigating to one field of a product is the useful
case; a viewer that can only reach the whole type is much less so.

### What the platform would do with it

| field | used for |
| --- | --- |
| `text` / `type` | the chip shown today — unchanged |
| `kind` + `members` | the property-panel viewer for products and variants |
| `source` | "Go to definition" on the type, and on each member |
| `truncated` | render "…" as a navigation affordance, not an expander |

Absent `typeRef`, the panel renders exactly what it renders now.

## Part C — a source location for boundary ports

Smaller than the other two, and possibly already satisfied.

"Go to Source" resolves from navigation metadata on the element. Every entity
node gets it from `node.meta.source`; an entity's ports get it from the typed
`port.source`. A boundary node read neither — it took `name` and `type` off its
port and nothing else — so a network's own inputs and outputs were the one kind
of port with no navigation at all.

The platform now reads **both**, preferring `node.meta.source` (so a boundary
node behaves like the nodes beside it) and falling back to `port.source`. It
requires neither specifically, because the platform cannot make a product
change. But it does require **one of them to be populated**, and as of writing
neither product appears to emit either for a boundary node — the feature is
wired and inert.

So: for a boundary node (`kind: 'wf-input'` / `'wf-output'`), populate
`meta.source = { file, line }` with the port's declaration site, exactly as
entity nodes already do. Nothing else is needed; no new op, no schema change —
`meta` is already an open bag and the field name is the one in use.

## Capability gating

Both parts should be gated through the existing negotiation rather than
version-bumped: `getCapabilities` returns `ops: string[]`, and the platform
already has `supportsOp(uri, kind)`.

- **Part A:** the panel offers the type edit only when
  `updateBoundaryPortType` is advertised. Otherwise the field stays read-only,
  which is what it is today.
- **Part B:** needs no gate. `typeRef` is optional and its absence is the
  current behaviour.

This means neither sidecar blocks the other, and neither blocks the platform.

## Open questions for the sidecar authors

1. Is a network's interface addressable by `workflow` name alone, or is a file
   with several networks ambiguous in a way `createPort` gets away with today
   only because it appends?
2. What is a sensible default expansion depth — is one level enough to be
   useful for the common product type?
3. Do the two products' type systems agree closely enough for one `kind`
   vocabulary, or does it need a product-specific escape hatch?
4. Should `typeRef` also be emitted for entity ports? The schema change is on
   `PyGraphPort`, so it comes for free — but only if the resolver is available
   on that path too.

## What is already done in the platform

- A boundary port type edit no longer **renames the port**. Every label edit was
  routed to a rename of the nearest entity; for a type label that resolved to
  the port itself. The handler now allow-lists name labels. This needs no
  sidecar work and is the one change here with immediate effect.
- Boundary nodes emit navigation metadata when a source location is available —
  see Part C for why that is currently never.
