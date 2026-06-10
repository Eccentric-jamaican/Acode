import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;

  if (!sessionColumns.some((column) => column.name === "proof_key_thumbprint")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN proof_key_thumbprint TEXT
    `;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS auth_dpop_proofs (
      replay_key TEXT PRIMARY KEY,
      thumbprint TEXT NOT NULL,
      jti TEXT NOT NULL,
      consumed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_auth_dpop_proofs_expires_at
    ON auth_dpop_proofs(expires_at)
  `;
});
