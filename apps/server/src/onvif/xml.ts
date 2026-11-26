/** Hardened XML parsing for camera answers: no DTDs, no entities, size-capped. */
import { XMLParser } from 'fast-xml-parser';

export const MAX_XML_BYTES = 256 * 1024;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  processEntities: false,
  htmlEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

export function parseXml(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > MAX_XML_BYTES) throw new Error('Camera answer too large');
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) {
    throw new Error('Camera answer has a DOCTYPE; refusing to read it');
  }
  return parser.parse(text) as Record<string, unknown>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Every child named `name` (the parser gives one child as an object, several as an array). */
export function children(node: unknown, name: string): unknown[] {
  if (!isObject(node)) return [];
  const v = node[name];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** The first node down a path of child names. */
export function child(node: unknown, ...path: string[]): unknown {
  let at = node;
  for (const name of path) {
    at = children(at, name)[0];
    if (at === undefined) return undefined;
  }
  return at;
}

/** A node's text, whether it is a plain value or has attributes. */
export function text(node: unknown): string | undefined {
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (isObject(node) && node['#text'] !== undefined) return String(node['#text']);
  return undefined;
}

export function attr(node: unknown, name: string): string | undefined {
  if (!isObject(node)) return undefined;
  const v = node[`@_${name}`];
  return v === undefined ? undefined : String(v);
}

/** The name of the first element inside a node, e.g. the operation in a SOAP Body. */
export function firstElementName(node: unknown): string | undefined {
  if (!isObject(node)) return undefined;
  return Object.keys(node).find((k) => !k.startsWith('@_') && k !== '#text');
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
}
