/**
 * GLSP Operation Handler infrastructure
 *
 * The source-editing operation handlers moved to the language toolkit package; this barrel now
 * re-exports only the neutral reversible-edit command infrastructure that stays in diagram-server.
 */

export * from './reversible-multi-workspace-edit-command';
