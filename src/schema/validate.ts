/**
 * Minimal JSON-schema-subset validator. Deliberately dependency-free: the project
 * enforces a zero-runtime-dependency policy for the target repo and Foreman keeps
 * its own surface small. Supports the keywords Foreman actually emits:
 * type, properties, required, additionalProperties, items, enum, minItems,
 * maxItems, minLength.
 */

export type SchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';

export interface SchemaNode {
  type?: SchemaType;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  items?: SchemaNode;
  enum?: unknown[];
  minItems?: number;
  maxItems?: number;
  minLength?: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value: unknown, type: SchemaType): boolean {
  switch (type) {
    case 'object':
      return typeOf(value) === 'object';
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return true;
  }
}

/**
 * Constraint keywords the gateway (Bedrock-backed structured output) rejects.
 * Verified by a real 400: "For 'array' type, 'minItems' values other than 0 or 1
 * are not supported". We strip these for the wire schema and enforce them only
 * locally in validateAgainstSchema.
 */
const WIRE_UNSUPPORTED = new Set(['minItems', 'maxItems', 'minLength']);

/** Deep-clones a schema, dropping keywords the gateway's structured output rejects. */
export function pruneSchemaForWire(schema: SchemaNode): SchemaNode {
  const clone: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (WIRE_UNSUPPORTED.has(key)) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      const props: Record<string, SchemaNode> = {};
      for (const [propKey, propValue] of Object.entries(value as Record<string, SchemaNode>)) {
        props[propKey] = pruneSchemaForWire(propValue);
      }
      clone[key] = props;
    } else if (key === 'items' && value && typeof value === 'object') {
      clone[key] = pruneSchemaForWire(value as SchemaNode);
    } else {
      clone[key] = value;
    }
  }
  return clone as SchemaNode;
}

export function validateAgainstSchema(value: unknown, schema: SchemaNode, path = '$'): ValidationResult {
  const errors: string[] = [];

  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`);
    return { ok: false, errors };
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: value ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }

  if (schema.type === 'string' && typeof value === 'string' && schema.minLength !== undefined) {
    if (value.length < schema.minLength) errors.push(`${path}: string shorter than minLength ${schema.minLength}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: array has ${value.length} items, fewer than minItems ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: array has ${value.length} items, more than maxItems ${schema.maxItems}`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateAgainstSchema(item, schema.items as SchemaNode, `${path}[${index}]`).errors);
      });
    }
  }

  if (typeOf(value) === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) errors.push(`${path}: missing required property "${key}"`);
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(record)) {
        if (!(key in schema.properties)) errors.push(`${path}: unexpected property "${key}"`);
      }
    }
    if (schema.properties) {
      for (const [key, child] of Object.entries(schema.properties)) {
        if (key in record) {
          errors.push(...validateAgainstSchema(record[key], child, `${path}.${key}`).errors);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Extracts a JSON object/array from model text. Handles bare JSON, fenced code
 * blocks, and surrounding prose. Returns null when nothing parseable is found.
 */
export function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const tryParse = (candidate: string): unknown | null => {
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  };

  const direct = tryParse(trimmed);
  if (direct !== null) return direct;

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const parsed = tryParse(fence[1].trim());
    if (parsed !== null) return parsed;
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const parsed = tryParse(trimmed.slice(firstBrace, lastBrace + 1));
    if (parsed !== null) return parsed;
  }

  return null;
}
