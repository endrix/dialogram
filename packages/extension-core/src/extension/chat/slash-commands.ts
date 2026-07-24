/**
 * Generic slash-command surface for the unified chat runtime.
 *
 * Every profile contributes its own commands ({@link ChatCommandContribution});
 * the registry owns parsing, mode gating and the auto-provided `/help`. A
 * contribution WITHOUT a handler is a pass-through suggestion: the raw text is
 * sent to the agent (mlir's 0.2.0 `slashCommands` semantics). Parsing is the
 * legacy intent-resolver grammar, ported verbatim: `/cmd a b key=value` with
 * positionals collected under `_positional` and quotes stripped from values.
 */

export interface ChatCommandContext {
    /** Absolute path of the file the chat is scoped to. */
    file: string;
    /** Document URI string of the owning panel. */
    uri: string;
    sessionId: string;
    /** Live diagram selection for the file (empty when nothing selected). */
    selectedNodeIds: string[];
    /** Chat mode the command was invoked in; drives mode-aware `/help`. */
    mode: 'plan' | 'build';
}

export interface ChatCommandResult {
    success: boolean;
    error?: string;
    /** Optional system-message text posted instead of the generic confirmation. */
    info?: string;
}

export interface ChatCommandContribution {
    /** Command name without the leading '/'. */
    command: string;
    description: string;
    /** Argument hint shown in the '/' menu, e.g. '<name>'. */
    usage?: string;
    /** Modes the command is available in; absent = both. */
    modes?: Array<'plan' | 'build'>;
    /** Absent ⇒ pass-through: the raw text goes to the agent. */
    handler?: (args: Record<string, any>, ctx: ChatCommandContext) => Promise<ChatCommandResult>;
}

const SLASH_RE = /^\/([\w-]+)(?:\s+(.+))?$/;

function parseArgs(argsString: string): Record<string, any> {
    const args: Record<string, any> = {};
    for (const part of argsString.split(/\s+/)) {
        const [key, value] = part.split('=');
        if (key && value) {
            args[key] = value.replace(/^["']|["']$/g, '');
        } else if (key) {
            args['_positional'] = args['_positional'] || [];
            args['_positional'].push(key);
        }
    }
    return args;
}

export class SlashCommandRegistry {
    private readonly commands = new Map<string, ChatCommandContribution>();

    constructor(contributions: ChatCommandContribution[] = []) {
        for (const c of contributions) {
            this.commands.set(c.command, c);
        }
        // `/help` is generic: it renders the registry itself. A profile may
        // override it by contributing its own 'help'.
        if (!this.commands.has('help')) {
            this.commands.set('help', {
                command: 'help',
                description: 'Show available commands',
                handler: async (_args, ctx) => ({
                    success: true,
                    info: this.helpText(ctx.mode)
                })
            });
        }
    }

    private modesOf(c: ChatCommandContribution): Array<'plan' | 'build'> {
        return c.modes ?? ['plan', 'build'];
    }

    /** Returns null for non-slash input, including malformed '/…' (legacy: agent). */
    parse(input: string): { command: string; args: Record<string, any> } | null {
        const match = input.match(SLASH_RE);
        if (!match) {
            return null;
        }
        const [, command, argsString] = match;
        return { command, args: argsString ? parseArgs(argsString) : {} };
    }

    listForMode(mode: 'plan' | 'build'): Array<{ command: string; description: string; usage?: string }> {
        const out: Array<{ command: string; description: string; usage?: string }> = [];
        for (const c of this.commands.values()) {
            if (this.modesOf(c).includes(mode)) {
                out.push({ command: c.command, description: c.description, usage: c.usage });
            }
        }
        return out;
    }

    helpText(mode: 'plan' | 'build'): string {
        const lines = this.listForMode(mode).map(
            c => `/${c.command}${c.usage ? ` ${c.usage}` : ''} — ${c.description}`
        );
        return `Available commands (${mode} mode):\n${lines.join('\n')}`;
    }

    /**
     * Resolve input to a contribution. Null = not a slash command (send to the
     * agent). Throws the legacy errors for unknown commands and mode mismatch.
     */
    resolve(
        input: string,
        mode: 'plan' | 'build'
    ): { contribution: ChatCommandContribution; args: Record<string, any> } | null {
        if (!input.startsWith('/')) {
            return null;
        }
        const parsed = this.parse(input);
        if (!parsed) {
            return null;
        }
        const contribution = this.commands.get(parsed.command);
        if (!contribution) {
            throw new Error(`Unknown command: ${parsed.command}. Type /help for available commands.`);
        }
        const modes = this.modesOf(contribution);
        if (!modes.includes(mode)) {
            throw new Error(
                `Command '${parsed.command}' requires ${modes.join(' or ')} mode. ` +
                    `Switch to ${modes[0]} mode to use this command.`
            );
        }
        return { contribution, args: parsed.args };
    }
}
