import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const LEGACY_RUNTIME_MODE = "auto-accept-edits";
const CURRENT_RUNTIME_MODE = "full-access";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE provider_session_runtime
    SET runtime_mode = ${CURRENT_RUNTIME_MODE}
    WHERE runtime_mode = ${LEGACY_RUNTIME_MODE}
  `;

  yield* sql`
    UPDATE projection_threads
    SET runtime_mode = ${CURRENT_RUNTIME_MODE}
    WHERE runtime_mode = ${LEGACY_RUNTIME_MODE}
  `;

  yield* sql`
    UPDATE projection_thread_sessions
    SET runtime_mode = ${CURRENT_RUNTIME_MODE}
    WHERE runtime_mode = ${LEGACY_RUNTIME_MODE}
  `;

  yield* sql`
    UPDATE projection_project_rules
    SET default_runtime_mode = ${CURRENT_RUNTIME_MODE}
    WHERE default_runtime_mode = ${LEGACY_RUNTIME_MODE}
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.runtimeMode', ${CURRENT_RUNTIME_MODE})
    WHERE json_extract(payload_json, '$.runtimeMode') = ${LEGACY_RUNTIME_MODE}
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.defaultRuntimeMode', ${CURRENT_RUNTIME_MODE})
    WHERE json_extract(payload_json, '$.defaultRuntimeMode') = ${LEGACY_RUNTIME_MODE}
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.session.runtimeMode', ${CURRENT_RUNTIME_MODE})
    WHERE json_extract(payload_json, '$.session.runtimeMode') = ${LEGACY_RUNTIME_MODE}
  `;
});
