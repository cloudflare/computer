import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const justBashEntry = fileURLToPath(import.meta.resolve("just-bash"));
const sqliteWorker = resolve(dirname(justBashEntry), "../commands/sqlite3/worker.js");
const sqlJsEntry = fileURLToPath(import.meta.resolve("sql.js"));

export const SQLITE_WASM_PATH = resolve(dirname(sqlJsEntry), "sql-wasm.wasm");

const SQLITE_WORKER_ERROR =
  "sqlite3 worker not found. Run 'pnpm build' to compile the worker.";
const FIND_WORKER =
  'for(let r of t)if(ce(r))return r;throw new Error("' + SQLITE_WORKER_ERROR + '")';
const CREATE_WORKER =
  "return new he(e,{workerData:t,resourceLimits:{maxOldGenerationSizeMb:be,maxYoungGenerationSizeMb:we}})";

function replaceExactlyOnce(source, search, replacement, label) {
  const first = source.indexOf(search);
  if (first === -1 || source.indexOf(search, first + search.length) !== -1) {
    throw new Error(`sqlite bundle: expected exactly one ${label}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + search.length);
}

export function sqliteWorkerPlugin() {
  let commandAdapted = false;
  let queryWorkerLoaded = false;
  let sqlJsLoaded = false;

  return {
    name: "adapt-sqlite-worker",
    setup(build) {
      // just-bash's generated command chunk looks for a worker file with
      // node:fs and constructs node:worker_threads.Worker. Neither mechanism
      // can reach a Dynamic Worker Loader module, so route both through a lazy
      // adapter that implements the same small event protocol in this isolate.
      build.onLoad(
        { filter: /[\\/]just-bash[\\/]dist[\\/]bundle[\\/]chunks[\\/]chunk-[^/\\]+\.js$/ },
        async (args) => {
          let source = await readFile(args.path, "utf8");
          if (!source.includes(SQLITE_WORKER_ERROR)) return undefined;

          source = replaceExactlyOnce(
            source,
            FIND_WORKER,
            'return "inline:sqlite3"',
            "sqlite worker lookup"
          );
          source = replaceExactlyOnce(
            source,
            CREATE_WORKER,
            "return __createInlineSqliteWorker(t)",
            "sqlite Worker constructor"
          );
          source =
            `import { createInlineSqliteWorker as __createInlineSqliteWorker } from ${JSON.stringify(
              resolve(here, "sqlite-command-adapter.mjs")
            )};\n` + source;
          // Wrap the exported command so WorkspaceFsAdapter gets a stable
          // database-lock identity without changing the always-on adapter.
          source = replaceExactlyOnce(
            source,
            "export{$e as a,_e as b,Fe as c};",
            "const __sqliteCommand=__adaptSqliteCommand(_e);export{$e as a,__sqliteCommand as b,Fe as c};",
            "sqlite command export"
          );
          source =
            `import { adaptSqliteCommand as __adaptSqliteCommand } from ${JSON.stringify(
              resolve(here, "sqlite-command-adapter.mjs")
            )};\n` + source;
          commandAdapted = true;
          return { contents: source, loader: "js", resolveDir: dirname(args.path) };
        }
      );

      // Pull the worker's query implementation into the sqlite feature graph.
      // Its Node worker entrypoint is guarded by parentPort, which is null here;
      // exporting executeQuery lets the adapter call the same implementation.
      build.onResolve({ filter: /^computer:sqlite-query-worker$/ }, () => ({
        path: "query-worker",
        namespace: "computer-sqlite",
      }));
      build.onLoad({ filter: /^query-worker$/, namespace: "computer-sqlite" }, async () => {
        let source = await readFile(sqliteWorker, "utf8");
        // WorkerDefenseInDepth belongs around a dedicated thread. Running it
        // in the shell's isolate would harden the shell itself after a query.
        source = replaceExactlyOnce(
          source,
          "    activateDefense();\n",
          "",
          "worker defense activation"
        );
        queryWorkerLoaded = true;
        return {
          contents: `${source}\nexport { executeQuery };\n`,
          loader: "js",
          resolveDir: dirname(sqliteWorker),
        };
      });

      // sql.js normally fetches sql-wasm.wasm from a package filesystem. The
      // Dynamic Worker instead imports a precompiled module supplied in its
      // Loader module table, then hands that module to Emscripten explicitly.
      build.onResolve({ filter: /^sql\.js$/ }, () => ({
        path: "sql.js",
        namespace: "computer-sqlite",
      }));
      build.onLoad({ filter: /^sql\.js$/, namespace: "computer-sqlite" }, () => ({
        contents: `
          import initSqlJs from ${JSON.stringify(sqlJsEntry)};
          import sqliteWasm from "./sql-wasm.wasm";
          export default function init(options = {}) {
            return initSqlJs({
              ...options,
              instantiateWasm(imports, receiveInstance) {
                const instance = new WebAssembly.Instance(sqliteWasm, imports);
                receiveInstance(instance, sqliteWasm);
                return instance.exports;
              },
            });
          }
        `,
        loader: "js",
        resolveDir: dirname(sqlJsEntry),
      }));
      build.onResolve({ filter: /^\.\/sql-wasm\.wasm$/ }, () => ({
        path: "./sql-wasm.wasm",
        external: true,
      }));

      // sql.js sees WorkerGlobalScope and process shims in workerd and otherwise
      // chooses loading branches that require self.location or node:fs. Neither
      // branch is needed when instantiateWasm is supplied by the wrapper above.
      build.onLoad({ filter: /[\\/]sql\.js[\\/]dist[\\/]sql-wasm\.js$/ }, async (args) => {
        let source = await readFile(args.path, "utf8");
        source = replaceExactlyOnce(
          source,
          "globalThis.WorkerGlobalScope",
          "undefined",
          "sql.js WorkerGlobalScope probe"
        );
        source = replaceExactlyOnce(
          source,
          "globalThis.process?.versions?.node",
          "undefined",
          "sql.js Node probe"
        );
        sqlJsLoaded = true;
        return { contents: source, loader: "js", resolveDir: dirname(args.path) };
      });

      build.onEnd((result) => {
        if (result.errors.length > 0) return;
        if (!commandAdapted || !queryWorkerLoaded || !sqlJsLoaded) {
          throw new Error(
            `sqlite bundle: incomplete adaptation (${JSON.stringify({
              commandAdapted,
              queryWorkerLoaded,
              sqlJsLoaded,
            })})`
          );
        }
      });
    },
  };
}
