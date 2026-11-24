/**
 * opencode 2's Code Mode, off for the chat.
 *
 * opencode 2 puts a session's MCP tools behind one `execute` tool: the model
 * writes a script that calls them, and only what the script prints comes
 * back. A tool result's image never reaches the model, so a diagram tool
 * that answers with a picture is read as text. Denying `execute` turns Code
 * Mode off: the MCP tools are offered as themselves and their results reach
 * the model whole.
 *
 * opencode honours a per-server `codemode: false` in its own MCP config, but
 * the chat hands its servers over through ACP's `newSession`, which keeps only
 * a server's url and headers. So the chat says it for the whole process, in
 * `OPENCODE_CONFIG_CONTENT`: a config layer opencode reads from its
 * environment. The variable is set on the `opencode acp` the chat spawns (and
 * so on the `opencode serve` that one starts), never on the user's own
 * opencode.
 *
 * The layer is read after the user's opencode.json files, so a
 * `permission.execute` they set there gives way to it in the chat; the chat's
 * setting is what keeps Code Mode on. A permission an agent declares for
 * itself (`agent.<name>.permission`) is read after it, so an agent's own
 * wildcard "allow" lets `execute` back in for that agent.
 *
 * opencode 1.x has no Code Mode and may refuse a permission it does not know:
 * the caller applies this to opencode 2 only.
 */

/** The variable opencode reads a config layer from (JSON text). */
export const OPENCODE_CONFIG_CONTENT = 'OPENCODE_CONFIG_CONTENT';

/** What became of the variable. */
export type CodeModeOutcome =
    /** `permission.execute` is "deny" in the environment returned. */
    | 'off'
    /** The user's own `OPENCODE_CONFIG_CONTENT` says `permission.execute`: theirs stands. */
    | 'user-says'
    /** The user's own `OPENCODE_CONFIG_CONTENT` is not a JSON object the chat can add to, or its
     *  `permission` is one rule for every tool: left as it is. */
    | 'left-as-is';

export interface CodeModeOffResult {
    /** The environment to spawn with: a copy when it changed, the one given otherwise. */
    env: NodeJS.ProcessEnv;
    outcome: CodeModeOutcome;
    /** One line for the log, saying what was done and why. */
    note: string;
}

/**
 * `env` with opencode 2's Code Mode off: `permission.execute` denied in
 * `OPENCODE_CONFIG_CONTENT`, added to the user's own value when there is one.
 * A value that says `permission.execute` (whatever it says) stands; one that
 * does not parse as JSON (opencode also reads JSONC), or whose `permission` is
 * one rule for every tool rather than an object, is left as it is.
 */
export function withOpencodeCodeModeOff(env: NodeJS.ProcessEnv): CodeModeOffResult {
    const text = env[OPENCODE_CONFIG_CONTENT];
    let config: Record<string, unknown> = {};
    if (text !== undefined && text.trim() !== '') {
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            return {
                env,
                outcome: 'left-as-is',
                note: `${OPENCODE_CONFIG_CONTENT} does not parse as JSON, so it is left as it is and opencode's Code Mode stays as that config says`,
            };
        }
        if (!isObject(parsed)) {
            return {
                env,
                outcome: 'left-as-is',
                note: `${OPENCODE_CONFIG_CONTENT} is not a JSON object, so it is left as it is and opencode's Code Mode stays as that config says`,
            };
        }
        config = parsed;
    }
    const given = config.permission;
    if (given !== undefined && !isObject(given)) {
        return {
            env,
            outcome: 'left-as-is',
            note: `${OPENCODE_CONFIG_CONTENT} gives one permission for every tool, so it is left as it is and opencode's Code Mode stays as that config says`,
        };
    }
    const permission = isObject(given) ? given : {};
    if (Object.prototype.hasOwnProperty.call(permission, 'execute')) {
        return {
            env,
            outcome: 'user-says',
            note: `${OPENCODE_CONFIG_CONTENT} says permission.execute: it stands`,
        };
    }
    // Added last: opencode reads a permission's rules in order, the last that
    // matches deciding, so a wildcard in this same `permission` does not
    // cover it (one in an agent's own permission does: see above).
    const next = { ...config, permission: { ...permission, execute: 'deny' } };
    return {
        env: { ...env, [OPENCODE_CONFIG_CONTENT]: JSON.stringify(next) },
        outcome: 'off',
        note: `${OPENCODE_CONFIG_CONTENT} denies permission.execute: Code Mode off, so MCP tool results reach the model whole (unless an agent's own permission allows execute)`,
    };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
