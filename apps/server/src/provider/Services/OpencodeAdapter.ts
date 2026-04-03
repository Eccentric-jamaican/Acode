/**
 * OpencodeAdapter - OpenCode implementation of the generic provider adapter contract.
 *
 * This service owns the OpenCode local server runtime and HTTP/SSE semantics.
 * It does not perform cross-provider routing, shared event fan-out, or
 * checkpoint orchestration.
 *
 * @module OpencodeAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * OpencodeAdapterShape - Service API for the OpenCode provider adapter.
 */
export interface OpencodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "opencode";
}

/**
 * OpencodeAdapter - Service tag for OpenCode provider adapter operations.
 */
export class OpencodeAdapter extends ServiceMap.Service<OpencodeAdapter, OpencodeAdapterShape>()(
  "t3/provider/Services/OpencodeAdapter",
) {}

