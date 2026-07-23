/**
 * @deprecated Thin back-compat alias over {@link DiagramWebviewChannel}.
 *
 * This module used to be the seed of the canonical channel: a module-global
 * `Messenger` published by the bootstrap so the chat panel and the
 * execution-overlay bridge shared one notification route (Round 5 — see
 * webview-channel.ts for the full history). Task 1 formalized that into
 * {@link DiagramWebviewChannel}, which owns the sole `Messenger` AND provides
 * first-class handler composition (retiring the round-6 monkey-patch).
 *
 * These two functions remain only so older import paths keep compiling; new
 * code should use `installDiagramWebviewChannel` / `getDiagramWebviewChannel`
 * from `./webview-channel` directly.
 */
import type { Messenger } from 'vscode-messenger-webview';
import {
    installDiagramWebviewChannel,
    getDiagramWebviewChannel,
    type ChannelMessenger
} from './webview-channel';

/**
 * @deprecated Use `installDiagramWebviewChannel` from `./webview-channel`.
 * Publishes the messenger by wrapping it in the canonical channel.
 */
export function setSharedWebviewMessenger(messenger: Messenger): void {
    installDiagramWebviewChannel(messenger as unknown as ChannelMessenger);
}

/**
 * @deprecated Use `getDiagramWebviewChannel()` from `./webview-channel`.
 * Returns the channel's underlying messenger, or `undefined` before the
 * bootstrap has run.
 */
export function getSharedWebviewMessenger(): Messenger | undefined {
    return getDiagramWebviewChannel()?.rawMessenger as unknown as Messenger | undefined;
}
