import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type ColumnRow = {
  readonly name: string;
};

function hasColumn(columns: ReadonlyArray<ColumnRow>, name: string): boolean {
  return columns.some((column) => column.name === name);
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  let projectColumns = yield* sql<ColumnRow>`
    PRAGMA table_info(projection_projects)
  `;
  if (!hasColumn(projectColumns, "default_model")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN default_model TEXT
    `;
  }
  projectColumns = yield* sql<ColumnRow>`
    PRAGMA table_info(projection_projects)
  `;
  if (hasColumn(projectColumns, "default_model_selection_json")) {
    yield* sql`
      UPDATE projection_projects
      SET default_model = COALESCE(
        default_model,
        json_extract(default_model_selection_json, '$.model')
      )
    `;
  }

  const threadColumns = yield* sql<ColumnRow>`
    PRAGMA table_info(projection_threads)
  `;
  if (!hasColumn(threadColumns, "runtime_mode")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'full-access'
    `;
  }
  if (!hasColumn(threadColumns, "interaction_mode")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT 'default'
    `;
  }
  if (!hasColumn(threadColumns, "origin")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'
    `;
  }
  if (!hasColumn(threadColumns, "task_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN task_id TEXT
    `;
  }
  if (!hasColumn(threadColumns, "parent_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN parent_thread_id TEXT
    `;
  }
  if (!hasColumn(threadColumns, "subagent_agent_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN subagent_agent_id TEXT
    `;
  }
  if (!hasColumn(threadColumns, "subagent_nickname")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN subagent_nickname TEXT
    `;
  }
  if (!hasColumn(threadColumns, "subagent_role")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN subagent_role TEXT
    `;
  }
  const addedThreadModelColumn = !hasColumn(threadColumns, "model");
  if (addedThreadModelColumn) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN model TEXT NOT NULL DEFAULT 'gpt-5'
    `;
  }
  if (!hasColumn(threadColumns, "is_pinned")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0
    `;
  }
  if (!hasColumn(threadColumns, "pinned_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pinned_at TEXT
    `;
  }
  if (!hasColumn(threadColumns, "archived_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN archived_at TEXT
    `;
  }
  if (!hasColumn(threadColumns, "handoff_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN handoff_json TEXT
    `;
  }
  if (!hasColumn(threadColumns, "latest_user_message_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN latest_user_message_at TEXT
    `;
  }
  if (!hasColumn(threadColumns, "pending_approval_count")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pending_approval_count INTEGER NOT NULL DEFAULT 0
    `;
  }
  if (!hasColumn(threadColumns, "pending_user_input_count")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pending_user_input_count INTEGER NOT NULL DEFAULT 0
    `;
  }
  if (!hasColumn(threadColumns, "has_actionable_proposed_plan")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0
    `;
  }

  const repairedThreadColumns = yield* sql<ColumnRow>`
    PRAGMA table_info(projection_threads)
  `;
  if (hasColumn(repairedThreadColumns, "model_selection_json")) {
    if (addedThreadModelColumn) {
      yield* sql`
        UPDATE projection_threads
        SET model = COALESCE(json_extract(model_selection_json, '$.model'), model, 'gpt-5')
      `;
    } else {
      yield* sql`
        UPDATE projection_threads
        SET model = COALESCE(model, json_extract(model_selection_json, '$.model'), 'gpt-5')
      `;
    }
  } else {
    yield* sql`
      UPDATE projection_threads
      SET model = COALESCE(model, 'gpt-5')
    `;
  }

  const turnColumns = yield* sql<ColumnRow>`
    PRAGMA table_info(projection_turns)
  `;
  if (!hasColumn(turnColumns, "interaction_mode")) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT 'default'
    `;
  }
  if (!hasColumn(turnColumns, "source_proposed_plan_thread_id")) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN source_proposed_plan_thread_id TEXT
    `;
  }
  if (!hasColumn(turnColumns, "source_proposed_plan_id")) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN source_proposed_plan_id TEXT
    `;
  }

  yield* sql`
    UPDATE projection_turns
    SET interaction_mode = COALESCE(
      (
        SELECT json_extract(orchestration_events.payload_json, '$.interactionMode')
        FROM orchestration_events
        WHERE orchestration_events.stream_id = projection_turns.thread_id
          AND orchestration_events.event_type = 'thread.turn-start-requested'
          AND json_extract(orchestration_events.payload_json, '$.messageId') = projection_turns.pending_message_id
        ORDER BY orchestration_events.sequence DESC
        LIMIT 1
      ),
      interaction_mode,
      'default'
    )
  `;

  const messageColumns = yield* sql<ColumnRow>`
    PRAGMA table_info(projection_thread_messages)
  `;
  if (!hasColumn(messageColumns, "attachments_json")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN attachments_json TEXT
    `;
  }

  const activityColumns = yield* sql<ColumnRow>`
    PRAGMA table_info(projection_thread_activities)
  `;
  if (!hasColumn(activityColumns, "sequence")) {
    yield* sql`
      ALTER TABLE projection_thread_activities
      ADD COLUMN sequence INTEGER
    `;
  }

  const sessionColumns = yield* sql<ColumnRow>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (!hasColumn(sessionColumns, "runtime_mode")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'full-access'
    `;
  }
  if (!hasColumn(sessionColumns, "provider_instance_id")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN provider_instance_id TEXT
    `;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_proposed_plans (
      plan_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      plan_markdown TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  const proposedPlanColumns = yield* sql<ColumnRow>`
    PRAGMA table_info(projection_thread_proposed_plans)
  `;
  if (!hasColumn(proposedPlanColumns, "implemented_at")) {
    yield* sql`
      ALTER TABLE projection_thread_proposed_plans
      ADD COLUMN implemented_at TEXT
    `;
  }
  if (!hasColumn(proposedPlanColumns, "implementation_thread_id")) {
    yield* sql`
      ALTER TABLE projection_thread_proposed_plans
      ADD COLUMN implementation_thread_id TEXT
    `;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_tasks (
      task_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      brief TEXT NOT NULL,
      acceptance_criteria TEXT NOT NULL,
      state TEXT NOT NULL,
      priority INTEGER,
      thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      attachments TEXT NOT NULL DEFAULT '[]'
    )
  `;
  const taskColumns = yield* sql<ColumnRow>`
    PRAGMA table_info(projection_tasks)
  `;
  if (!hasColumn(taskColumns, "attachments")) {
    yield* sql`
      ALTER TABLE projection_tasks
      ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'
    `;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_project_rules (
      project_id TEXT PRIMARY KEY,
      prompt_template TEXT NOT NULL,
      default_model TEXT,
      default_runtime_mode TEXT NOT NULL,
      on_success_move_to TEXT NOT NULL,
      on_failure_move_to TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_proposed_plans_thread_created
    ON projection_thread_proposed_plans(thread_id, created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_tasks_project_id
    ON projection_tasks(project_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_tasks_thread_id
    ON projection_tasks(thread_id)
  `;
});
