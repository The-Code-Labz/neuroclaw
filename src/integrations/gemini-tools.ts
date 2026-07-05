// Converts NeuroClaw's OpenAI-format tool definitions to Gemini FunctionDeclarations.
// Gemini's schema format diverges from JSON Schema on several keywords; this
// file applies the mapping table from the spec. Unsupported constructs ($ref,
// anyOf, oneOf) are coerced to STRING with a description note.

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

const TYPE_MAP: Record<string, string> = {
  string:  'STRING',
  integer: 'INTEGER',
  number:  'NUMBER',
  boolean: 'BOOLEAN',
  object:  'OBJECT',
  array:   'ARRAY',
};

function convertSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return { type: 'STRING' };

  // Unsupported: coerce to STRING
  if (schema.$ref || schema.anyOf || schema.oneOf) {
    return {
      type: 'STRING',
      description: `${(schema.description as string) ?? ''} (complex schema coerced to string)`.trim(),
    };
  }

  const result: Record<string, unknown> = {};

  if (typeof schema.type === 'string') {
    result.type = TYPE_MAP[schema.type] ?? 'STRING';
  }
  if (schema.description)  result.description = schema.description;
  if (schema.enum)         result.enum = schema.enum;
  if (schema.required)     result.required = schema.required;

  if (schema.properties && typeof schema.properties === 'object') {
    result.properties = {};
    for (const [k, v] of Object.entries(schema.properties as Record<string, unknown>)) {
      (result.properties as Record<string, unknown>)[k] = convertSchema(v as Record<string, unknown>);
    }
  }

  if (schema.items) {
    result.items = convertSchema(schema.items as Record<string, unknown>);
  }

  // Drop unsupported keywords
  // (additionalProperties, default are silently omitted)

  return result;
}

export function toGeminiFunctionDeclarations(tools: OpenAITool[]): GeminiFunctionDeclaration[] {
  return tools.map(t => ({
    name:        t.function.name,
    description: t.function.description ?? '',
    parameters:  t.function.parameters
      ? convertSchema(t.function.parameters as Record<string, unknown>)
      : undefined,
  }));
}
