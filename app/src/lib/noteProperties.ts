import { parseDocument, stringify } from 'yaml';

export type NotePropertyValue = string | number | boolean | null | string[];
export type NoteProperties = Record<string, NotePropertyValue>;

export type ParsePropertiesResult =
  | { ok: true; properties: NoteProperties }
  | { ok: false; error: string };

export type ParsePropertyValueResult =
  | { ok: true; value: NotePropertyValue }
  | { ok: false; error: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isSupportedPropertyValue = (value: unknown): value is NotePropertyValue => {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return Array.isArray(value) && value.every(item => typeof item === 'string');
};

const stableObject = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!isPlainObject(value)) return value;

  return Object.keys(value)
    .sort((a, b) => a.localeCompare(b))
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = stableObject(value[key]);
      return result;
    }, {});
};

const formatYamlError = (error: unknown) => {
  const anyError = error as { message?: string; linePos?: Array<{ line?: number; col?: number }> };
  const message = anyError?.message || String(error);
  const firstLine = anyError?.linePos?.[0];
  if (firstLine?.line != null) {
    return `${message} (${firstLine.line}:${firstLine.col ?? 1})`;
  }
  return message;
};

export const validateNoteProperties = (value: unknown): ParsePropertiesResult => {
  if (value == null) return { ok: true, properties: {} };
  if (!isPlainObject(value)) {
    return { ok: false, error: 'top-level YAML must be an object' };
  }

  const properties: NoteProperties = {};
  for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
    const propertyValue = value[key];
    if (!isSupportedPropertyValue(propertyValue)) {
      return { ok: false, error: `unsupported value at "${key}"` };
    }
    properties[key] = propertyValue;
  }

  return { ok: true, properties };
};

export const parseNotePropertiesYaml = (input: string): ParsePropertiesResult => {
  if (!input.trim()) return { ok: true, properties: {} };

  try {
    const document = parseDocument(input, { prettyErrors: true });
    if (document.errors.length > 0) {
      return { ok: false, error: formatYamlError(document.errors[0]) };
    }

    const parsed = document.toJSON();
    return validateNoteProperties(parsed);
  } catch (error) {
    return { ok: false, error: formatYamlError(error) };
  }
};

export const parseNotePropertyValueInput = (input: string): ParsePropertyValueResult => {
  if (!input.trim()) return { ok: true, value: '' };

  try {
    const document = parseDocument(input, { prettyErrors: true });
    if (document.errors.length > 0) {
      return { ok: false, error: formatYamlError(document.errors[0]) };
    }

    const parsed = document.toJSON();
    if (!isSupportedPropertyValue(parsed)) {
      return { ok: false, error: 'error.unsupported-property-value' };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, error: formatYamlError(error) };
  }
};

export const stringifyNotePropertiesYaml = (value: unknown) => {
  if (!isPlainObject(value) || Object.keys(value).length === 0) return '';
  return stringify(stableObject(value), { lineWidth: 0 }).trimEnd();
};

export const stringifyNotePropertyValueInput = (value: NotePropertyValue) => {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value === null) return 'null';
  return String(value);
};

export const hasNoteProperties = (value: unknown): value is NoteProperties => {
  return isPlainObject(value)
    && Object.keys(value).length > 0
    && Object.values(value).every(isSupportedPropertyValue);
};
