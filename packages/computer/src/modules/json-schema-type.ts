// A JSON Schema written as a TypeScript type, for declarations a model
// reads. It covers what tool input schemas use: objects, arrays,
// primitives, enums, constants, unions, intersections, and local
// `$ref`s. Anything else becomes `unknown`, which is honest rather than
// wrong.

const MAX_DEPTH = 8;
const MAX_INLINE_LENGTH = 72;

type Schema = Readonly<Record<string, unknown>>;

/**
 * Write a JSON Schema as a TypeScript type.
 *
 * @param schema - The schema. A value that is not a schema object becomes `unknown`.
 * @returns The type, formatted over several lines when it is long.
 */
export function jsonSchemaType(schema: unknown): string {
  if (!isSchema(schema)) return "unknown";
  return typeOf(schema, { root: schema, refs: new Set(), depth: 0 });
}

/**
 * Whether every property of an object schema is optional, so a
 * function taking it can be called with nothing.
 *
 * @param schema - The schema.
 * @returns True unless the schema requires at least one property.
 */
export function acceptsNothing(schema: unknown): boolean {
  if (!isSchema(schema)) return true;
  const required = schema.required;
  return !Array.isArray(required) || required.length === 0;
}

interface Context {
  readonly root: Schema;
  readonly refs: ReadonlySet<string>;
  readonly depth: number;
}

function typeOf(schema: Schema, context: Context): string {
  if (context.depth > MAX_DEPTH) return "unknown";
  const next = { ...context, depth: context.depth + 1 };

  if (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    const target = context.refs.has(ref) ? undefined : resolveRef(context.root, ref);
    return target === undefined
      ? "unknown"
      : typeOf(target, { ...next, refs: new Set([...context.refs, ref]) });
  }
  if ("const" in schema) return literal(schema.const);
  if (Array.isArray(schema.enum)) return union(schema.enum.map(literal));
  const oneOf = schemas(schema.oneOf) ?? schemas(schema.anyOf);
  if (oneOf !== undefined) return union(oneOf.map((part) => typeOf(part, next)));
  const allOf = schemas(schema.allOf);
  if (allOf !== undefined) return allOf.map((part) => typeOf(part, next)).join(" & ");

  if (Array.isArray(schema.type)) {
    return union(
      schema.type
        .filter((type): type is string => typeof type === "string")
        .map((type) => typeOf({ ...schema, type }, context)),
    );
  }
  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return arrayType(schema, next);
    case "object":
      return objectType(schema, next);
    default:
      if (isSchema(schema.properties)) return objectType(schema, next);
      if (schema.items !== undefined) return arrayType(schema, next);
      return "unknown";
  }
}

function objectType(schema: Schema, context: Context): string {
  const properties = isSchema(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : [],
  );
  const members: string[] = [];
  let documented = false;
  for (const [name, value] of Object.entries(properties)) {
    if (!isSchema(value)) continue;
    const description = typeof value.description === "string" ? value.description : undefined;
    if (description !== undefined) {
      documented = true;
      members.push(`/** ${comment(description)} */`);
    }
    members.push(
      `${propertyName(name)}${required.has(name) ? "" : "?"}: ${typeOf(value, context)};`,
    );
  }
  const extra = schema.additionalProperties;
  if (isSchema(extra)) members.push(`[key: string]: ${typeOf(extra, context)};`);
  else if (extra === true) members.push("[key: string]: unknown;");
  // An object schema with no properties takes any keys unless it says otherwise.
  if (members.length === 0) return extra === false ? "{}" : "Record<string, unknown>";
  const inline = `{ ${members.join(" ")} }`;
  if (!documented && inline.length <= MAX_INLINE_LENGTH && !inline.includes("\n")) return inline;
  return `{\n${members.map((member) => indent(member)).join("\n")}\n}`;
}

function arrayType(schema: Schema, context: Context): string {
  const items = schema.items;
  if (Array.isArray(items)) {
    return `[${items.map((item) => (isSchema(item) ? typeOf(item, context) : "unknown")).join(", ")}]`;
  }
  if (!isSchema(items)) return "unknown[]";
  const item = typeOf(items, context);
  return /[|&\n]/.test(item) ? `Array<${item}>` : `${item}[]`;
}

function resolveRef(root: Schema, ref: string): Schema | undefined {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isSchema(current)) return undefined;
    current = current[key];
  }
  return isSchema(current) ? current : undefined;
}

function schemas(value: unknown): Schema[] | undefined {
  return Array.isArray(value) && value.length > 0 && value.every(isSchema) ? value : undefined;
}

function literal(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return typeof value === "string" ? JSON.stringify(value) : "unknown";
}

function union(types: readonly string[]): string {
  const unique = [...new Set(types)];
  return unique.length === 0 ? "never" : unique.join(" | ");
}

function propertyName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function comment(text: string): string {
  return text.replace(/\*\//g, "* /").replace(/\s+/g, " ").trim();
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function isSchema(value: unknown): value is Schema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
