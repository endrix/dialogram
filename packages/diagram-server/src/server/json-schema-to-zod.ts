/**
 * Minimal JSON-Schema -> Zod shim.
 *
 * A platform chat tool declares its `inputSchema` as plain JSON-Schema
 * (`Record<string, unknown>`), but the GLSP-MCP tool-handler base requires a Zod `ZodObject`
 * (the framework calls `.strict()` on it and passes `.shape` to the MCP SDK). This shim
 * converts the tool's top-level `{ type:'object', properties, required }` schema into a Zod
 * raw shape the adapter then folds into `McpDiagramScopedInputSchema.extend(...)`.
 *
 * Scope is deliberately small — it covers the shapes the bridged registry tools actually use
 * (string, number/integer, boolean, array-of-<node>, nested object) and degrades every
 * unknown node to `z.any()` rather than throwing. `.strict()` on the resulting object means a
 * field the shim failed to model will be rejected as unknown, so the shim errs toward modelling
 * what it recognizes and leaving the rest permissive.
 */
import * as z from 'zod/v4';

/** A JSON-Schema node (object with a `type` and friends). Untyped by nature — validated defensively. */
type JsonSchemaNode = Record<string, unknown>;

/** Loosely-typed Zod raw shape (field name -> Zod schema). */
export type ZodShape = Record<string, z.ZodType>;

/** True when `value` is a non-null, non-array object. */
function isPlainObject(value: unknown): value is JsonSchemaNode {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Convert a single JSON-Schema node to a Zod schema. Unknown or malformed nodes degrade to
 * `z.any()` — this function never throws.
 */
function nodeToZod(node: unknown): z.ZodType {
    if (!isPlainObject(node)) {
        return z.any();
    }
    switch (node.type) {
        case 'string':
            return z.string();
        case 'number':
        case 'integer':
            return z.number();
        case 'boolean':
            return z.boolean();
        case 'array':
            return z.array(nodeToZod(node.items));
        case 'object':
            return z.object(jsonSchemaToZodShape(node));
        default:
            return z.any();
    }
}

/**
 * Convert a JSON-Schema object node (`{ type:'object', properties, required }`) into a Zod raw
 * shape. Properties listed in `required` stay mandatory; every other property is made optional.
 * A missing/malformed `properties` yields an empty shape. Never throws.
 */
export function jsonSchemaToZodShape(schema: Record<string, unknown>): ZodShape {
    const properties = isPlainObject(schema) && isPlainObject(schema.properties) ? schema.properties : {};
    const required = isPlainObject(schema) && Array.isArray(schema.required)
        ? (schema.required.filter(name => typeof name === 'string') as string[])
        : [];

    const shape: ZodShape = {};
    for (const [key, propNode] of Object.entries(properties)) {
        const zodType = nodeToZod(propNode);
        shape[key] = required.includes(key) ? zodType : zodType.optional();
    }
    return shape;
}
