/**
 * MigrationsLive - Migration runner with inline loader
 *
 * Uses Migrator.make with fromRecord to define migrations inline.
 * All migrations are statically imported - no dynamic file system loading.
 *
 * Migrations run automatically when the MigrationLayer is provided,
 * ensuring the database schema is always up-to-date before the application starts.
 */

import * as Migrator from "effect/unstable/sql/Migrator";
import * as Layer from "effect/Layer";

// Import all migrations statically
import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionTurnsInteractionMode.ts";
import Migration0015 from "./Migrations/015_ProjectionThreadsPinned.ts";
import Migration0016 from "./Migrations/016_OrchestrationTasks.ts";
import Migration0017 from "./Migrations/017_ProjectionTaskAttachments.ts";
import Migration0018 from "./Migrations/018_ErrorInbox.ts";
import Migration0019 from "./Migrations/019_ProjectionThreadsHandoff.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadsSubagents.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadsPinnedAt.ts";
import Migration0031 from "./Migrations/031_ProjectionThreadsArchivedAt.ts";
import Migration0032 from "./Migrations/032_CanonicalChatsProject.ts";
import Migration0033 from "./Migrations/033_LegacyModelSelectionEvents.ts";
import Migration0034 from "./Migrations/034_LegacyProjectionSchemaRepair.ts";
import { Effect } from "effect";

/**
 * Migration loader with all migrations defined inline.
 *
 * Key format: "{id}_{name}" where:
 * - id: numeric migration ID (determines execution order)
 * - name: descriptive name for the migration
 *
 * Uses Migrator.fromRecord which parses the key format and
 * returns migrations sorted by ID.
 */
const loader = Migrator.fromRecord({
  "1_OrchestrationEvents": Migration0001,
  "2_OrchestrationCommandReceipts": Migration0002,
  "3_CheckpointDiffBlobs": Migration0003,
  "4_ProviderSessionRuntime": Migration0004,
  "5_Projections": Migration0005,
  "6_ProjectionThreadSessionRuntimeModeColumns": Migration0006,
  "7_ProjectionThreadMessageAttachments": Migration0007,
  "8_ProjectionThreadActivitySequence": Migration0008,
  "9_ProviderSessionRuntimeMode": Migration0009,
  "10_ProjectionThreadsRuntimeMode": Migration0010,
  "11_OrchestrationThreadCreatedRuntimeMode": Migration0011,
  "12_ProjectionThreadsInteractionMode": Migration0012,
  "13_ProjectionThreadProposedPlans": Migration0013,
  "14_ProjectionTurnsInteractionMode": Migration0014,
  "15_ProjectionThreadsPinned": Migration0015,
  "16_OrchestrationTasks": Migration0016,
  "17_ProjectionTaskAttachments": Migration0017,
  "18_ErrorInbox": Migration0018,
  "19_ProjectionThreadsHandoff": Migration0019,
  "29_ProjectionThreadsSubagents": Migration0029,
  "30_ProjectionThreadsPinnedAt": Migration0030,
  "31_ProjectionThreadsArchivedAt": Migration0031,
  "32_CanonicalChatsProject": Migration0032,
  "33_LegacyModelSelectionEvents": Migration0033,
  "34_LegacyProjectionSchemaRepair": Migration0034,
});

/**
 * Migrator run function - no schema dumping needed
 * Uses the base Migrator.make without platform dependencies
 */
const run = Migrator.make({});

/**
 * Run all pending migrations.
 *
 * Creates the migrations tracking table (effect_sql_migrations) if it doesn't exist,
 * then runs any migrations with ID greater than the latest recorded migration.
 *
 * Returns array of [id, name] tuples for migrations that were run.
 *
 * @returns Effect containing array of executed migrations
 */
export const runMigrations = Effect.gen(function* () {
  yield* Effect.log("Running migrations...");
  yield* run({ loader });
  yield* Effect.log("Migrations ran successfully");
});

/**
 * Layer that runs migrations when the layer is built.
 *
 * Use this to ensure migrations run before your application starts.
 * Migrations are run automatically - no separate script is needed.
 *
 * @example
 * ```typescript
 * import { MigrationsLive } from "@acme/db/Migrations"
 * import * as SqliteClient from "@acme/db/SqliteClient"
 *
 * // Migrations run automatically when SqliteClient is provided
 * const AppLayer = MigrationsLive.pipe(
 *   Layer.provideMerge(SqliteClient.layer({ filename: "database.sqlite" }))
 * )
 * ```
 */
export const MigrationsLive = Layer.effectDiscard(runMigrations);
