# Changelog

All notable changes to Dialogram are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/); versions are the Dialogram
platform API version.

## [Unreleased]

### Fixed

- Edges no longer render detached from their ports. Persisted edge routes are re-anchored to the
  current port anchors on load; the snap existed but had never run, because ports were resolved
  through a `GModelRoot.index` property that does not exist.
- Node sizes are server-authoritative on every path. A fresh open no longer commits the client's
  measured bounds — which include the port and type-footer overhang — nor re-anchors ports inside
  the committed width, so fresh-open and persisted-reopen geometry now agree.
- Diagrams no longer twitch on reload. ELK re-centres `FIXED_POS` ports on a whole-pixel routing
  lane, returning ports of odd height half a pixel low; its port geometry is no longer written
  into the model, and edge endpoints are snapped to the server anchors instead.

### Security

- Resolved npm audit findings.

## [0.6.0] - 2026-07-29

MCP cutover: one agent surface. (#5, #6)

### Added

- `create-task-type` as a reversible GLSP operation and custom MCP tool (undoable).
- `create-edges` accepts `nodeName.portName` addressing.
- Auto-layout after agent structural edits.
- Shared, parameterized property-panel chrome, field toolkit and CSS for library consumers. (#6)

### Changed

- Agents now get exactly two servers: the in-host GLSP-MCP loopback (undoable diagram editing) and the in-process registry (read tools).
- Agent-dispatched node creation is headless (no dialog), with actionable errors and port-rich confirmations.
- Chat UX: named tool chips, scroll respected during streaming, clean new-session transcript, explicit empty-state picker, unique session names, model-loading notice always clears.

### Removed

- Legacy stdio MCP server and its plumbing.

### Fixed

- MCP label-edit renames now apply (were a silent no-op).

## [0.5.0] - 2026-07-28

GLSP-MCP adoption (parallel-run). (#4)

### Added

- Loopback HTTP GLSP-MCP server per opted-in diagram profile, advertised to agents alongside the legacy stdio server.
- Agent diagram edits ride GLSP operation handlers as reversible workspace edits — user-undoable like palette edits.
- Opt-in via `profile.mcp.enabled`; per-user rollback `dialogram.chat.useGlspMcp` (legacy `workflow.chat.useGlspMcp` honored).

### Changed

- Undo/redo persists the document so the diagram reloads immediately.

### Removed

- Server-stack `undo`/`redo` MCP tools (the host owns undo).

### Fixed

- Reversible-edit snapshots read authoritative disk content (no false undo refusals).
- Undo on an empty stack no longer shows an error toast.

## [GLSP 2.7.0 + Node 22] - 2026-07-28

Toolchain upgrade, no intended behavior change. (#3)

### Changed

- Exact GLSP 2.7.0 pins on a Node 22 toolchain.

### Fixed

- Diagram no longer force-reloads on build-artifact (`.py`) changes; own-source edits still reload.
- Enrichment/queue-visibility redeliveries take an agent-context-only fast path (less drag-time work).

## [0.4.0] - 2026-07-27

One chat panel everywhere. (#2)

### Changed

- Single diagram-profile chat panel across products, with richer chat configuration.

### Removed

- Chat-only API surface.

## [0.3.0] - 2026-07-24

Chat runtime convergence. (#1)

### Changed

- Unified the two chat runtimes into one ChatRuntime with shared selection context.
