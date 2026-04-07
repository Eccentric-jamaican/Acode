import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "./NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("NodeSqliteClient", (it) => {
  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");
    }),
  );

  it.effect("normalizes boolean parameters for sqlite bindings", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE flags(id INTEGER PRIMARY KEY, is_enabled INTEGER NOT NULL)`;
      yield* sql`INSERT INTO flags(is_enabled) VALUES (${true}), (${false})`;

      const rows = yield* sql<{ readonly is_enabled: number }>`
        SELECT is_enabled FROM flags ORDER BY id
      `;
      assert.deepStrictEqual(
        rows.map((row) => row.is_enabled),
        [1, 0],
      );
    }),
  );

  it.effect("keeps original transaction failure when rollback already happened", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const failure = yield* Effect.flip(
        sql.withTransaction(
          Effect.gen(function* () {
            // Simulate user code closing the transaction early before failing.
            yield* sql`ROLLBACK`;
            return yield* Effect.fail(new Error("expected failure"));
          }),
        ),
      );

      assert.equal(failure.message, "expected failure");
    }),
  );
});
