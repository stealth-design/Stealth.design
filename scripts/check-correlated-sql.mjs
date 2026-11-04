#!/usr/bin/env node
/**
 * Static check: correlated subqueries in select-list projections.
 *
 * Run with `--fix` to rewrite the offending references in place.
 *
 * ## The bug this exists to prevent
 *
 * Drizzle qualifies interpolated columns with their table name **only when the
 * outer query has a join**. A single-table select needs no qualifiers, so it
 * emits none — and that omission propagates into raw `sql` fragments in the
 * select list. Same fragment, two renderings:
 *
 *     .select({ n: sql`(select count(*) from ${contentItems} ci
 *                       where ci.source_id = ${sources.id})` })
 *     .from(sources)
 *     // -> where ci.source_id = "id"
 *
 *     .select({ ...same... })
 *     .from(sources).leftJoin(users, …)
 *     // -> where ci.source_id = "sources"."id"
 *
 * The first is wrong. Postgres resolves an unqualified name against the
 * innermost FROM first, `content_items` has an `id` column, so the predicate
 * becomes `ci.source_id = ci.id` — never true, count silently always 0. If two
 * of the subquery's tables carry the name it is an outright "column reference
 * is ambiguous" error instead; if none of them do, the outer reference resolves
 * correctly by luck.
 *
 * So whether a correlated subquery is correct depends on whether the *outer*
 * query happens to have a join. Removing a join — a change with no visible
 * relationship to the subquery — silently turns a right answer into a wrong
 * one. That is the real hazard, and it is why this check does not merely look
 * for currently-broken sites.
 *
 * ## The rule
 *
 * In a select-list `sql` fragment, an outer-row reference is written by
 * interpolating the *table* and naming the column in the SQL text:
 *
 *     where ci.source_id = ${sources}.id     // -> "sources".id, always
 *
 * That renders identically with or without a join. `${sources.id}` is correct
 * inside `.where()` — where Drizzle always qualifies — and only unsafe in a
 * projection, which is the one place this check looks.
 *
 * ## What this check does
 *
 * Parses every `key: sql\`…\`` projection in the repo and resolves table and
 * column names through Drizzle's own metadata rather than a guessed snake_case
 * conversion. It reports:
 *
 *   - any `${table.column}` naming a table that is *not* in the subquery's own
 *     FROM, i.e. an outer reference that should be qualified; and
 *   - any inner reference that is genuinely ambiguous because two of the
 *     subquery's own tables share the column name.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { glob } from "node:fs/promises";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "@uxd/database";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIX = process.argv.includes("--fix");

// --- Schema metadata, from Drizzle rather than guessed ---------------------

/** Drizzle table variable name -> { sqlName, columns: Map<jsProp, sqlName> } */
const tables = new Map();
/** SQL table name -> Set<sql column name> */
const columnsByTable = new Map();

for (const [exportName, value] of Object.entries(schema)) {
  // `is()` reads the prototype chain, which throws on a null-prototype object
  // (Drizzle exports a few). A non-table is simply skipped.
  let isTable = false;
  try {
    isTable = value !== null && typeof value === "object" && is(value, PgTable);
  } catch {
    isTable = false;
  }
  if (!isTable) continue;
  const sqlName = getTableName(value);
  const columns = new Map();
  const sqlColumns = new Set();
  for (const [prop, column] of Object.entries(getTableColumns(value))) {
    columns.set(prop, column.name);
    sqlColumns.add(column.name);
  }
  tables.set(exportName, { sqlName, columns });
  columnsByTable.set(sqlName, sqlColumns);
}

// --- Source scanning -------------------------------------------------------

/**
 * Walk a template literal from just after its opening backtick to the matching
 * close, tracking `${…}` nesting so an interpolated expression containing a
 * brace or backtick does not end the scan early.
 */
function readTemplate(src, start) {
  let index = start;
  let depth = 0;
  while (index < src.length) {
    if (src[index] === "\\") {
      index += 2;
      continue;
    }
    if (src.startsWith("${", index)) {
      depth += 1;
      index += 2;
      continue;
    }
    if (src[index] === "}" && depth > 0) {
      depth -= 1;
      index += 1;
      continue;
    }
    if (src[index] === "`" && depth === 0) return { body: src.slice(start, index), end: index };
    index += 1;
  }
  return { body: src.slice(start), end: src.length };
}

/**
 * Words that can follow a table in FROM/JOIN and are not an alias.
 *
 * Without this list `from ${users} where …` would read "where" as the alias.
 */
const NOT_AN_ALIAS = new Set([
  "where", "on", "using", "join", "inner", "left", "right", "full", "cross",
  "natural", "lateral", "group", "order", "limit", "offset", "having", "and",
  "or", "union", "except", "intersect", "as", "set", "returning", "for",
]);

/**
 * The tables a fragment's own FROM/JOIN clauses bring into scope.
 *
 * Aliasing matters, and it is the subtle half of this check. `from ${terms} c`
 * binds the table *only* as `c`: inside that subquery the name `taxonomy_terms`
 * is no longer available, so an interpolated `${taxonomyTerms.id}` there is a
 * reference to the **outer** row, not an inner one — even though the same table
 * appears in the FROM. Its bare rendering is still captured by `c`, which has an
 * `id` column, so `c.parent_id = "id"` quietly becomes `c.parent_id = c.id` and
 * counts nothing.
 *
 * Returns both: every table present (for collision checks) and the subset bound
 * under its own name (where an interpolated reference really is inner).
 */
function subqueryTables(body) {
  const present = new Set();
  const unaliased = new Set();

  const consider = (sqlName, next) => {
    present.add(sqlName);
    const alias = next?.trim().split(/\s|\)/)[0]?.toLowerCase();
    if (!alias || NOT_AN_ALIAS.has(alias)) unaliased.add(sqlName);
  };

  // `from ${contentItems} ci` / `join ${users} u on …`
  for (const match of body.matchAll(/\b(?:from|join)\s+\$\{(\w+)\}([^\n]*)/gi)) {
    const table = tables.get(match[1]);
    if (table) consider(table.sqlName, match[2]);
  }
  // `from content_items ci` — a literal name, which some fragments use.
  for (const match of body.matchAll(/\b(?:from|join)\s+"?([a-z_][a-z0-9_]*)"?([^\n]*)/gi)) {
    if (columnsByTable.has(match[1])) consider(match[1], match[2]);
  }

  return { present, unaliased };
}

const findings = [];
let projections = 0;

for await (const entry of glob("{packages,apps,scripts}/**/*.ts", { cwd: ROOT })) {
  if (entry.includes("node_modules") || entry.includes("/dist/")) continue;
  const path = `${ROOT}${entry}`;
  const src = readFileSync(path, "utf8");

  for (const match of src.matchAll(/(\w+)\s*:\s*sql(?:<[^>]*>)?`/g)) {
    const bodyStart = match.index + match[0].length;
    const { body } = readTemplate(src, bodyStart);
    if (!/\bselect\b/i.test(body)) continue;

    const { present: from, unaliased } = subqueryTables(body);
    if (from.size === 0) continue;
    projections += 1;

    for (const reference of body.matchAll(/\$\{(\w+)\.(\w+)\}/g)) {
      const [text, tableVar, prop] = reference;
      const table = tables.get(tableVar);
      if (!table) continue; // A JS value, not a schema column.
      const columnName = table.columns.get(prop);
      if (!columnName) continue;

      // An interpolation of a table bound in the subquery's FROM *under its own
      // name* is an ordinary inner reference, correct as written — unless two of
      // the subquery's tables share the column name, which Postgres rejects. A
      // table bound only under an alias does not count: see `subqueryTables`.
      const isInnerReference = unaliased.has(table.sqlName);
      const carriers = [...from].filter((name) => columnsByTable.get(name)?.has(columnName));
      if (isInnerReference && carriers.length < 2) continue;

      findings.push({
        path,
        file: relative(ROOT, path),
        offset: bodyStart + reference.index,
        length: text.length,
        line: src.slice(0, bodyStart + reference.index).split("\n").length,
        key: match[1],
        tableVar,
        reference: `${tableVar}.${prop}`,
        column: columnName,
        replacement: `\${${tableVar}}.${columnName}`,
        carriers,
        isInnerReference,
      });
    }
  }
}

// --- Fix -------------------------------------------------------------------

if (FIX && findings.length > 0) {
  const byFile = new Map();
  for (const finding of findings) {
    byFile.set(finding.path, [...(byFile.get(finding.path) ?? []), finding]);
  }
  for (const [path, items] of byFile) {
    let src = readFileSync(path, "utf8");
    // Back to front, so earlier offsets stay valid.
    for (const finding of items.sort((a, b) => b.offset - a.offset)) {
      src = src.slice(0, finding.offset) + finding.replacement + src.slice(finding.offset + finding.length);
    }
    writeFileSync(path, src);
    console.log(`fixed  ${relative(ROOT, path)}  (${items.length})`);
  }
  console.log(`\n${findings.length} reference(s) qualified. Re-run without --fix to verify.`);
  process.exit(0);
}

// --- Report ----------------------------------------------------------------

if (findings.length === 0) {
  console.log(
    `ok  correlated-sql: ${projections} projection subqueries, all outer references qualified`,
  );
  process.exit(0);
}

console.error(`FAIL  correlated-sql: ${findings.length} unqualified reference(s)\n`);
for (const finding of findings) {
  const list = finding.carriers.map((name) => `"${name}"`).join(" and ");
  const reason = finding.isInnerReference
    ? `ambiguous: ${list} both have a "${finding.column}" column, so Postgres rejects the query`
    : finding.carriers.length > 0
      ? `broken unless the outer query has a join: "${finding.column}" binds to ${list} instead`
      : `correct only because no subquery table has a "${finding.column}" column`;
  console.error(`  ${finding.file}:${finding.line}  ${finding.key}`);
  console.error(`    \${${finding.reference}} renders unqualified in a projection`);
  console.error(`    ${reason}`);
  console.error(`    fix: ${finding.replacement}\n`);
}
console.error("Run `node scripts/check-correlated-sql.mjs --fix` to qualify them all.");
process.exit(1);
