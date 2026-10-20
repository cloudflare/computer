import { parse } from "acorn";

import {
  APP_MODULE,
  CAPABILITIES_MODULE,
  FACETS_MODULE,
} from "../worker-javascript/module-graph.js";

/** The class the app's Dynamic Worker exports for its facets. */
export const APP_CLASS = "WorkspaceApp";

/** The method the host calls on a facet to run one of the app's methods. */
export const DISPATCH_METHOD = "__workspaceCall";

/**
 * The internal specifier the bridge routes app calls by. It isn't a
 * `ws:*` name, so caller source can't import it; only the stand-in
 * modules the backend generates call it.
 */
export const APPS_SPECIFIER = "dynamic-javascript:apps";

/**
 * Whether a module's default export is a class that extends
 * `DurableObject` from `cloudflare:workers` directly. That is what makes
 * a Workspace file an app rather than an ordinary module.
 *
 * Reads the source without running it, so it recognizes the common
 * forms: `export default class extends DurableObject`, a class declared
 * first and exported as the default, and `DurableObject` imported under
 * another name or through a namespace import.
 *
 * @param source - The module's source.
 * @returns The class's name (`"default"` when it has none), or
 *   undefined when the module is not an app or doesn't parse.
 */
export function durableObjectClassName(source: string): string | undefined {
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    return undefined;
  }
  const direct = new Set<string>();
  const namespaces = new Set<string>();
  const classes = new Map<string, AstNode>();
  let defaultExport: AstNode | undefined;
  let defaultName: string | undefined;
  for (const node of ast.body as unknown as AstNode[]) {
    if (node.type === "ImportDeclaration" && node.source?.value === "cloudflare:workers") {
      for (const specifier of node.specifiers ?? []) {
        if (specifier.type === "ImportNamespaceSpecifier")
          namespaces.add(identifier(specifier.local));
        else if (
          specifier.type === "ImportSpecifier" &&
          importedName(specifier.imported) === "DurableObject"
        ) {
          direct.add(identifier(specifier.local));
        }
      }
    } else if (node.type === "ClassDeclaration" && node.id) {
      classes.set(identifier(node.id), node);
    } else if (node.type === "VariableDeclaration") {
      for (const declaration of node.declarations ?? []) {
        if (declaration.id?.type === "Identifier" && declaration.init?.type === "ClassExpression") {
          classes.set(identifier(declaration.id), declaration.init);
        }
      }
    } else if (node.type === "ExportDefaultDeclaration") {
      defaultExport = node.declaration;
    } else if (node.type === "ExportNamedDeclaration") {
      if (node.declaration?.type === "ClassDeclaration" && node.declaration.id) {
        classes.set(identifier(node.declaration.id), node.declaration);
      }
      if (node.source) continue;
      for (const specifier of node.specifiers ?? []) {
        if (importedName(specifier.exported) === "default") {
          defaultName = identifier(specifier.local);
        }
      }
    }
  }
  let candidate: AstNode | undefined = defaultExport;
  // A class expression bound to a name takes that name, as at run time.
  let boundName: string | undefined;
  if (candidate?.type === "Identifier") {
    boundName = identifier(candidate);
    candidate = classes.get(boundName);
  }
  if (candidate === undefined && defaultName !== undefined) {
    boundName = defaultName;
    candidate = classes.get(defaultName);
  }
  if (candidate?.type !== "ClassDeclaration" && candidate?.type !== "ClassExpression") {
    return undefined;
  }
  const parent = candidate.superClass;
  const extendsDurableObject =
    (parent?.type === "Identifier" && direct.has(identifier(parent))) ||
    (parent?.type === "MemberExpression" &&
      parent.object?.type === "Identifier" &&
      namespaces.has(identifier(parent.object)) &&
      !parent.computed &&
      parent.property?.type === "Identifier" &&
      identifier(parent.property) === "DurableObject");
  if (!extendsDurableObject) return undefined;
  return candidate.id ? identifier(candidate.id) : (boundName ?? "default");
}

/**
 * The module that defines what code gets when it imports an app: an
 * object shaped like `ctx.facets`, whose class is named
 * `DurableObjectFacets` as the runtime's is. `get(name)` returns an
 * instance whose method calls run in that app's facet, and `abort`,
 * `delete`, and `clone` act on its instances. The runtime doesn't expose
 * its own class to code, so this one copies its shape.
 *
 * @returns The module's source.
 */
export function facetsModule(): string {
  return `
    import { call } from ${JSON.stringify(`./${CAPABILITIES_MODULE}`)};

    const invoke = (operation, args) => call(${JSON.stringify(`host/${APPS_SPECIFIER}`)}, operation, args);
    const constructing = Symbol("constructing");

    // An app's class runs in its own Durable Object, not here. What code
    // gets when it imports the app is one of these, ctx.facets for that
    // app, with one facet per instance name.
    class DurableObjectFacets {
      #path;
      #label;

      constructor(token, path, label) {
        if (token !== constructing) throw new TypeError("Illegal constructor");
        this.#path = path;
        this.#label = label;
      }

      get(name) {
        DurableObjectFacets.#check(this, "get", name);
        const path = this.#path;
        const label = this.#label + " instance " + JSON.stringify(name);
        return new Proxy(Object.create(null), {
          get(_target, method) {
            // Not a thenable, so awaiting an instance doesn't call it, and
            // printing one doesn't call into the app.
            if (typeof method !== "string" || method === "then" || method === "valueOf") return undefined;
            if (method === "toString" || method === "toJSON") return () => label;
            return (...args) => invoke("call", [path, name, method, args]);
          },
        });
      }

      abort(name, reason) {
        DurableObjectFacets.#check(this, "abort", name);
        return invoke("abort", [this.#path, name, reason === undefined ? null : String(reason)]);
      }

      delete(name) {
        DurableObjectFacets.#check(this, "delete", name);
        return invoke("delete", [this.#path, name]);
      }

      clone(source, destination) {
        DurableObjectFacets.#check(this, "clone", source);
        DurableObjectFacets.#check(this, "clone", destination);
        return invoke("clone", [this.#path, source, destination]);
      }

      get [Symbol.toStringTag]() {
        return "DurableObjectFacets";
      }

      // A method called without its object, such as a destructured get,
      // says what to do rather than failing on a private field.
      static #check(facets, operation, name) {
        if (typeof facets !== "object" || facets === null || !(#path in facets)) {
          throw new TypeError("Call " + operation + "() on an app's import, as in Counter." + operation + "(...).");
        }
        if (typeof name !== "string" || name === "") {
          throw new TypeError(facets.#label + "." + operation + "() takes an instance's name, a non-empty string.");
        }
      }
    }

    export function facetsFor(path, label) {
      return new DurableObjectFacets(constructing, path, label);
    }
  `;
}

/**
 * The module exec code gets in place of an app's file: `ctx.facets` for
 * that app.
 *
 * @param path - The app's absolute Workspace path.
 * @param className - The app class's name, or `"default"` for an
 *   anonymous class, used in messages and printed instances.
 * @param facetsImport - The specifier of the facets module.
 * @returns The stand-in's source.
 */
export function appStandInModule(path: string, className: string, facetsImport: string): string {
  const label = className === "default" ? "App" : className;
  return `
    import { facetsFor } from ${JSON.stringify(facetsImport)};
    export default facetsFor(${JSON.stringify(path)}, ${JSON.stringify(label)});
  `;
}

/**
 * The main module of an app's Dynamic Worker. It exports a subclass of
 * the app's class with one extra method, the dispatcher the host calls.
 * The dispatcher installs the call's bridge, so `node:fs` and host
 * modules work inside the app's methods, checks the method, calls it,
 * and returns its result or error as plain data.
 *
 * @param entryName - The module name of the entry that re-exports the app.
 * @returns The main module's source.
 */
export function appMainModule(entryName: string): string {
  return `
    import { DurableObject } from "cloudflare:workers";
    import { install } from ${JSON.stringify(`./${CAPABILITIES_MODULE}`)};
    import App from ${JSON.stringify(`./${entryName}`)};

    if (typeof App !== "function" || !(App.prototype instanceof DurableObject)) {
      throw new TypeError("The app's default export must be a class that extends DurableObject.");
    }

    // A method the app defines on its class, or a class between it and
    // DurableObject. Fields that hold functions count too. Names that
    // start with an underscore are private by convention, and nothing
    // from DurableObject or Object is callable.
    function findMethod(instance, method) {
      if (typeof method !== "string" || method === "" || method === "constructor" || method.startsWith("_")) {
        return undefined;
      }
      if (Object.hasOwn(instance, method)) {
        return typeof instance[method] === "function" ? instance[method] : undefined;
      }
      for (let prototype = App.prototype; prototype && prototype !== DurableObject.prototype; prototype = Object.getPrototypeOf(prototype)) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
        if (descriptor === undefined) continue;
        return typeof descriptor.value === "function" ? descriptor.value : undefined;
      }
      return undefined;
    }

    export class ${APP_CLASS} extends App {
      async ${DISPATCH_METHOD}(method, args, host) {
        install(host);
        try {
          const fn = findMethod(this, method);
          if (fn === undefined) {
            throw new TypeError(App.name + " has no method " + JSON.stringify(method) + " to call.");
          }
          const result = await fn.apply(this, Array.isArray(args) ? args : []);
          const value = result === undefined ? null : result;
          await host.assertResult(value);
          return { result: value };
        } catch (error) {
          return { error: { message: error instanceof Error ? error.message : String(error) } };
        }
      }
    }
  `;
}

/** The module names of an app's main module and of the facets module. */
export { APP_MODULE, FACETS_MODULE };

interface AstNode {
  type: string;
  id?: AstNode | null;
  name?: string;
  value?: unknown;
  local?: AstNode;
  imported?: AstNode;
  exported?: AstNode;
  source?: AstNode | null;
  specifiers?: AstNode[];
  declaration?: AstNode;
  declarations?: AstNode[];
  init?: AstNode | null;
  superClass?: AstNode | null;
  object?: AstNode;
  property?: AstNode;
  computed?: boolean;
}

function identifier(node: AstNode | null | undefined): string {
  return node?.name ?? "";
}

// `import { "DurableObject" as X }` names the import with a string.
function importedName(node: AstNode | undefined): string {
  if (node === undefined) return "";
  return node.type === "Literal" ? String(node.value) : identifier(node);
}
