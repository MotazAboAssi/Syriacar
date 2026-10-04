import assert from "node:assert/strict";
import { is, SQL, sql } from "drizzle-orm";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { getDatabase } from "./client.ts";
import * as schema from "./schema.ts";
import { securityRateLimits } from "./security-rate-limits.ts";

export const tableConfigs = Object.values(schema)
  .filter((value) => is(value, PgTable))
  .map((table) => ({ table, ...getTableConfig(table) }))
  .sort((a, b) => a.name.localeCompare(b.name));

const dialect = new PgDialect();

function parseDefault(expression: string) {
  const literal = expression.replace(/::[\w\s"]+$/, "");
  if (literal.startsWith("'") && literal.endsWith("'")) {
    return literal.slice(1, -1).replaceAll("''", "'");
  }
  if (literal === "true" || literal === "false") return literal === "true";
  return Number(literal);
}

function expectedType(type: string) {
  return type.replace(/^varchar/, "character varying")
    .replace(/^timestamp$/, "timestamp without time zone")
    .replaceAll('"', "");
}

/** Read PostgreSQL's own catalogs, not just the migration snapshot. */
export async function verifyCatalog() {
  const db = getDatabase();
  const [tableResult, columnResult, constraintResult, indexResult, enumResult] = await Promise.all([
    db.execute<{ schema_name: string; table_name: string }>(sql`
      SELECT n.nspname AS schema_name, c.relname AS table_name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
      ORDER BY n.nspname, c.relname
    `),
    db.execute<{
      table_name: string; column_name: string; data_type: string; not_null: boolean; default_value: string | null;
    }>(sql`
      SELECT c.relname AS table_name, a.attname AS column_name,
        format_type(a.atttypid, a.atttypmod) AS data_type, a.attnotnull AS not_null,
        pg_get_expr(d.adbin, d.adrelid) AS default_value
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum
    `),
    db.execute<{
      table_name: string; name: string; kind: string; validated: boolean;
      columns: string[]; foreign_table: string | null; foreign_columns: string[];
      delete_action: string; update_action: string; definition: string;
    }>(sql`
      SELECT rel.relname AS table_name, con.conname AS name, con.contype AS kind,
        con.convalidated AS validated, frel.relname AS foreign_table,
        con.confdeltype AS delete_action, con.confupdtype AS update_action,
        pg_get_constraintdef(con.oid) AS definition,
        ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
          ORDER BY k.ord) AS columns,
        ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
          ORDER BY k.ord) AS foreign_columns
      FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
      LEFT JOIN pg_class frel ON frel.oid = con.confrelid
      WHERE n.nspname = 'public' AND con.contype IN ('p', 'u', 'f', 'c')
    `),
    db.execute<{
      table_name: string; name: string; is_unique: boolean; is_primary: boolean;
      valid: boolean; method: string; columns: string[];
    }>(sql`
      SELECT t.relname AS table_name, i.relname AS name,
        x.indisunique AS is_unique, x.indisprimary AS is_primary, x.indisvalid AS valid,
        am.amname AS method,
        ARRAY(SELECT a.attname::text FROM unnest(x.indkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
          WHERE k.ord <= x.indnkeyatts ORDER BY k.ord) AS columns
      FROM pg_index x JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_am am ON am.oid = i.relam
      WHERE n.nspname = 'public'
    `),
    db.execute<{ name: string; values: string[] }>(sql`
      SELECT t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname = 'public' GROUP BY t.typname
    `),
  ]);

  assert.deepEqual(tableResult.rows, [
    { schema_name: "drizzle", table_name: "__drizzle_migrations" },
    ...[...tableConfigs.map(t => t.name), "security_rate_limits"].sort()
      .map(name => ({ schema_name: "public", table_name: name })),
  ], "Exactly 24 business tables, one infrastructure table and the migration ledger must exist");

  let foreignKeys = 0;
  let primaryKeys = 0;
  let uniqueConstraints = 0;
  let checks = 0;
  let indexes = 0;
  let columns = 0;

  const infra = { table: securityRateLimits, ...getTableConfig(securityRateLimits) };
  for (const table of [...tableConfigs, infra]) {
    const actualColumns = columnResult.rows.filter((c) => c.table_name === table.name);
    assert.deepEqual(actualColumns.map((c) => c.column_name), table.columns.map((c) => c.name));
    for (const column of table.columns) {
      const actual = actualColumns.find((c) => c.column_name === column.name)!;
      const label = `${table.name}.${column.name}`;
      assert.equal(actual.data_type, expectedType(column.getSQLType()), `${label} type`);
      assert.equal(actual.not_null, column.notNull, `${label} nullability`);
      if (column.default === undefined) {
        assert.equal(actual.default_value, null, `${label} must not acquire an invented default`);
      } else {
        assert.notEqual(actual.default_value, null, `${label} default`);
        const actualDefault = parseDefault(actual.default_value!);
        const expected = column.default instanceof SQL
          ? parseDefault(dialect.sqlToQuery(column.default).sql)
          : column.default;
        if (column.getSQLType() === "json") {
          assert.deepEqual(JSON.parse(String(actualDefault)), typeof expected === "string" ? JSON.parse(expected) : expected);
        } else {
          assert.deepEqual(actualDefault, expected, `${label} default value`);
        }
      }
      if (table.name !== infra.name) columns++;
    }

    const expectedConstraints: { name: string; kind: string; columns: string[] }[] = [];
    const inlinePrimary = table.columns.filter((c) => c.primary);
    if (inlinePrimary.length) {
      expectedConstraints.push({ name: `${table.name}_pkey`, kind: "p", columns: inlinePrimary.map((c) => c.name) });
    }
    for (const key of table.primaryKeys) {
      expectedConstraints.push({ name: key.getName(), kind: "p", columns: key.columns.map((c) => c.name) });
    }
    for (const column of table.columns.filter((c) => c.isUnique)) {
      expectedConstraints.push({ name: column.uniqueName!, kind: "u", columns: [column.name] });
    }
    for (const key of table.uniqueConstraints) {
      expectedConstraints.push({ name: key.getName()!, kind: "u", columns: key.columns.map((c) => c.name) });
    }
    for (const key of table.foreignKeys) {
      const reference = key.reference();
      expectedConstraints.push({ name: key.getName(), kind: "f", columns: reference.columns.map((c) => c.name) });
      const actual = constraintResult.rows.find((c) => c.name === key.getName() && c.table_name === table.name)!;
      assert.ok(actual, `${key.getName()} exists`);
      assert.equal(actual.foreign_table, getTableConfig(reference.foreignTable).name);
      assert.deepEqual(actual.foreign_columns, reference.foreignColumns.map((c) => c.name));
      assert.equal(actual.delete_action, "a", "Frozen specification does not authorize cascading deletion");
      assert.equal(actual.update_action, "a");
      foreignKeys++;
    }
    for (const check of table.checks) {
      const actual = constraintResult.rows.find((c) => c.name === check.name && c.table_name === table.name)!;
      assert.ok(actual, `${check.name} exists`);
      // Column sets in CHECKs are normalized by PostgreSQL. Behavioral tests
      // separately exercise every required CHECK with accepted/rejected rows.
      expectedConstraints.push({ name: check.name, kind: "c", columns: actual.columns });
      if (table.name !== infra.name) checks++;
    }
    const actualConstraints = constraintResult.rows.filter((c) => c.table_name === table.name);
    assert.deepEqual(
      actualConstraints.map(({ name, kind, columns }) => ({ name, kind, columns })).sort((a, b) => a.name.localeCompare(b.name)),
      expectedConstraints.sort((a, b) => a.name.localeCompare(b.name)),
      `${table.name} constraints`,
    );
    assert.ok(actualConstraints.every((c) => c.validated), `${table.name}: no unvalidated constraints`);
    if (table.name !== infra.name) primaryKeys += expectedConstraints.filter((c) => c.kind === "p").length;
    uniqueConstraints += expectedConstraints.filter((c) => c.kind === "u").length;

    const expectedIndexes = [
      ...table.indexes.map(({ config }) => ({
        name: config.name!, columns: config.columns.map((c) => {
          assert.ok("name" in c, "No expression indexes are specified");
          return c.name;
        }), is_unique: config.unique, is_primary: false, method: config.method,
      })),
      ...expectedConstraints.filter((c) => c.kind === "p" || c.kind === "u").map((c) => ({
        name: c.name, columns: c.columns, is_unique: true, is_primary: c.kind === "p", method: "btree",
      })),
    ];
    const actualIndexes = indexResult.rows.filter((c) => c.table_name === table.name);
    assert.deepEqual(
      actualIndexes.map(({ name, columns, is_unique, is_primary, method }) => ({ name, columns, is_unique, is_primary, method })).sort((a, b) => a.name.localeCompare(b.name)),
      expectedIndexes.sort((a, b) => a.name.localeCompare(b.name)),
      `${table.name} index definitions`,
    );
    assert.ok(actualIndexes.every((i) => i.valid), `${table.name}: no invalid indexes`);
    for (const key of table.foreignKeys) {
      const foreignColumns = key.reference().columns.map((c) => c.name);
      assert.ok(actualIndexes.some((i) => foreignColumns.every((c, n) => i.columns[n] === c)),
        `${key.getName()} needs a leading-column FK index`);
    }
    if (table.name !== infra.name) indexes += actualIndexes.length;
  }

  const enums = Object.values(schema).filter((value) => typeof value === "function" && "enumName" in value);
  assert.deepEqual(
    enumResult.rows.sort((a, b) => a.name.localeCompare(b.name)),
    enums.map((e) => ({ name: e.enumName, values: [...e.enumValues] })).sort((a, b) => a.name.localeCompare(b.name)),
  );
  const ledger = await db.execute<{ hash: string; created_at: string }>(sql`
    SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at
  `);
  const approvedMigrations = readMigrationFiles({ migrationsFolder: "./drizzle" });
  assert.equal(approvedMigrations.length, 2, "Only two migrations are approved");
  assert.deepEqual(ledger.rows.map(row => ({ hash: row.hash, when: Number(row.created_at) })),
    approvedMigrations.map(m => ({ hash: m.hash, when: m.folderMillis })),
    "Ledger must exactly match foundation and security rate limits migrations");
  const timezone = await db.execute<{ TimeZone: string }>(sql`SHOW timezone`);
  assert.equal(timezone.rows[0].TimeZone, "UTC");
  return { tables: tableConfigs.length, columns, enums: enums.length, primaryKeys, foreignKeys, uniqueConstraints, checks, indexes };
}

export async function applicationRowCounts() {
  return (await getDatabase().execute<{ table_name: string; row_count: number }>(
    sql.join(tableConfigs.map((t) => sql`
      SELECT ${t.name}::text AS table_name, count(*)::int AS row_count FROM ${t.table}
    `), sql` UNION ALL `),
  )).rows;
}