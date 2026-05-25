import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      payload_json,
      '$.defaultModel',
      json_extract(payload_json, '$.defaultModelSelection.model')
    )
    WHERE event_type = 'project.created'
      AND json_type(payload_json, '$.defaultModel') IS NULL
      AND json_type(payload_json, '$.defaultModelSelection.model') IS NOT NULL
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      payload_json,
      '$.defaultModel',
      NULL
    )
    WHERE event_type = 'project.created'
      AND json_type(payload_json, '$.defaultModel') IS NULL
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      payload_json,
      '$.model',
      json_extract(payload_json, '$.modelSelection.model')
    )
    WHERE event_type = 'thread.created'
      AND json_type(payload_json, '$.model') IS NULL
      AND json_type(payload_json, '$.modelSelection.model') IS NOT NULL
  `;
});
