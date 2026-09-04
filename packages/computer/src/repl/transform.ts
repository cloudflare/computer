// REPL cell transform.
//
// A cell is one piece of agent-written JavaScript. Cells execute inside an
// async function in a fresh module graph, so their top-level lexical
// declarations would otherwise die with the function scope. To make bindings
// persist across cells (and across isolate reloads), top-level declarations
// are rewritten onto `globalThis`:
//
//   const a = 1, { b } = obj;   →   (globalThis.a = 1), ({ b: globalThis.b } = obj);
//   function f() {}             →   function f() {} globalThis.f = f;
//   class C {}                  →   class C {} globalThis.C = C;
//
// Later cells read those names through ordinary global lookup. The cell's
// value is an explicit top-level `return` if present, otherwise the trailing
// expression statement (rewritten to `return (expr)`), otherwise undefined.
//
// Only Program-level statements are rewritten. Loop heads, block-nested
// declarations, and function bodies keep normal scoping.
// Known ceiling: `var` inside a top-level block is not persisted — fine
// for model-written cells; the upgrade path is a scope-aware walk.

import { parse } from "acorn";
import type { Pattern, Program, Statement } from "acorn";

interface Edit {
  start: number;
  end: number;
  text: string;
}

export function transformCell(source: string): string {
  const program: Program = parse(source, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
  });
  const edits: Edit[] = [];

  for (const statement of program.body) {
    collectStatementEdits(statement as Statement, source, edits);
  }

  const last = program.body[program.body.length - 1];
  if (last !== undefined && last.type === "ExpressionStatement") {
    const expression = source.slice(last.expression.start, last.expression.end);
    edits.push({ start: last.start, end: last.end, text: `return (${expression});` });
  }

  return applyEdits(source, edits);
}

function collectStatementEdits(statement: Statement, source: string, edits: Edit[]): void {
  if (statement.type === "VariableDeclaration") {
    const parts = statement.declarations.map((declarator) => {
      if (declarator.init === null || declarator.init === undefined) {
        // Destructuring requires an initializer, so this is a plain name.
        const name = source.slice(declarator.id.start, declarator.id.end);
        return `(globalThis.${name} = undefined)`;
      }
      const pattern = rewritePattern(declarator.id, source);
      const init = source.slice(declarator.init.start, declarator.init.end);
      return `(${pattern} = ${init})`;
    });
    edits.push({ start: statement.start, end: statement.end, text: `${parts.join(", ")};` });
    return;
  }
  if (
    (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") &&
    statement.id !== null
  ) {
    const name = statement.id.name;
    edits.push({ start: statement.end, end: statement.end, text: ` globalThis.${name} = ${name};` });
  }
}

// Rewrite a binding pattern into an assignment-pattern targeting globalThis:
// bound identifiers become `globalThis.<name>`, and object-pattern shorthand
// is expanded (`{ a }` → `{ a: globalThis.a }`) so the property key survives.
function rewritePattern(pattern: Pattern, source: string): string {
  const edits: Edit[] = [];
  collectPatternEdits(pattern, source, edits);
  const applied = applyEdits(source.slice(pattern.start, pattern.end), shift(edits, pattern.start));
  return applied;
}

function collectPatternEdits(pattern: Pattern, source: string, edits: Edit[]): void {
  switch (pattern.type) {
    case "Identifier":
      edits.push({ start: pattern.start, end: pattern.end, text: `globalThis.${pattern.name}` });
      return;
    case "ObjectPattern":
      for (const property of pattern.properties) {
        if (property.type === "RestElement") {
          collectPatternEdits(property.argument, source, edits);
          continue;
        }
        if (property.shorthand) {
          // `{ a }` or `{ a = default }`: keep the key, retarget the value.
          const key = source.slice(property.key.start, property.key.end);
          const valueEdits: Edit[] = [];
          collectPatternEdits(property.value as Pattern, source, valueEdits);
          const value = applyEdits(
            source.slice(property.value.start, property.value.end),
            shift(valueEdits, property.value.start),
          );
          edits.push({ start: property.start, end: property.end, text: `${key}: ${value}` });
          continue;
        }
        collectPatternEdits(property.value as Pattern, source, edits);
      }
      return;
    case "ArrayPattern":
      for (const element of pattern.elements) {
        if (element !== null) collectPatternEdits(element, source, edits);
      }
      return;
    case "AssignmentPattern":
      collectPatternEdits(pattern.left, source, edits);
      return;
    case "RestElement":
      collectPatternEdits(pattern.argument, source, edits);
      return;
    default:
      // MemberExpression cannot appear in a declaration pattern.
      return;
  }
}

function shift(edits: Edit[], offset: number): Edit[] {
  return edits.map((edit) => ({ ...edit, start: edit.start - offset, end: edit.end - offset }));
}

function applyEdits(source: string, edits: Edit[]): string {
  let result = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}
