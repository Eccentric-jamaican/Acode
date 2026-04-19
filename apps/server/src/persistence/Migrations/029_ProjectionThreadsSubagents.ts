import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN parent_thread_id TEXT
  `;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN subagent_agent_id TEXT
  `;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN subagent_nickname TEXT
  `;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN subagent_role TEXT
  `;
});
