# Mirrors gemini-tools.ts: converts OpenAI tool definitions to Gemini FunctionDeclarations.
from google.genai import types

_TYPE_MAP = {
    'string':  'STRING',
    'integer': 'INTEGER',
    'number':  'NUMBER',
    'boolean': 'BOOLEAN',
    'object':  'OBJECT',
    'array':   'ARRAY',
}


def _convert_schema(schema: dict) -> dict:
    if not schema or not isinstance(schema, dict):
        return {'type': 'STRING'}

    if any(k in schema for k in ('$ref', 'anyOf', 'oneOf')):
        desc = schema.get('description', '')
        return {'type': 'STRING', 'description': f'{desc} (complex schema coerced to string)'.strip()}

    result = {}
    raw_type = schema.get('type')
    if raw_type and raw_type in _TYPE_MAP:
        result['type'] = _TYPE_MAP[raw_type]
    elif raw_type:
        result['type'] = 'STRING'
    if 'description' in schema:
        result['description'] = schema['description']
    if 'enum' in schema:
        result['enum'] = schema['enum']
    if 'required' in schema:
        result['required'] = schema['required']
    if 'properties' in schema:
        result['properties'] = {k: _convert_schema(v) for k, v in schema['properties'].items()}
    if 'items' in schema:
        result['items'] = _convert_schema(schema['items'])

    return result


def to_gemini_declarations(openai_tools: list[dict]) -> list[types.FunctionDeclaration]:
    declarations = []
    for tool in openai_tools:
        fn = tool.get('function', {})
        params = fn.get('parameters')
        declarations.append(
            types.FunctionDeclaration(
                name=fn['name'],
                description=fn.get('description', ''),
                parameters=_convert_schema(params) if params else None,
            )
        )
    return declarations
