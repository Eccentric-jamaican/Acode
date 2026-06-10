import {
  PROVIDER_UPDATE_CONFIG,
  type ProviderKind,
  type ProviderUpdateConfig,
  type ServerProviderUpdateInfo,
} from "@t3tools/contracts";
import { Duration, Effect, Layer, Ref } from "effect";

import { ProviderUpdate, type ProviderUpdateShape } from "../Services/ProviderUpdate";

const CACHE_TTL_MS = Duration.toMillis(Duration.hours(1));
const FETCH_TIMEOUT_MS = 5_000;

interface NpmLatestResponse {
  readonly version: string;
  readonly maintainers?: ReadonlyArray<{
    readonly name?: string;
    readonly email?: string;
  }>;
  readonly publisher?: { readonly username?: string };
  readonly homepage?: string;
  readonly repository?: { readonly url?: string; readonly directory?: string };
  readonly dist?: { readonly unpackedSize?: number };
  readonly deprecated?: string;
  readonly _npmUser?: { readonly name?: string; readonly trustedPublisher?: { readonly id?: string } };
}

interface CachedEntry {
  readonly info: ServerProviderUpdateInfo;
  readonly fetchedAtMs: number;
}

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((s) => Number.parseInt(s, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((s) => Number.parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

export function extractGitHubOwner(value: string | undefined): string | null {
  if (!value) return null;
  const patterns = [
    /github\.com[:/]([A-Za-z0-9_.-]+)/i,
    /^github:([A-Za-z0-9_.-]+)\//i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) {
      return match[1].toLowerCase();
    }
  }
  return null;
}

export function determineTrustedPublisher(
  body: NpmLatestResponse,
  config: ProviderUpdateConfig,
): { trusted: boolean; publisher: string | null; reason?: string } {
  const trustedOwners = new Set(config.trustedRepositoryOwners.map((o) => o.toLowerCase()));
  const trustedEmailDomains = config.trustedNpmEmailDomains.map((d) => d.toLowerCase());
  const trustedMaintainers = new Set(
    config.trustedNpmMaintainers.map((m) => m.toLowerCase()),
  );

  const homepageOwner = extractGitHubOwner(body.homepage);
  if (homepageOwner && trustedOwners.has(homepageOwner)) {
    return {
      trusted: true,
      publisher: homepageOwner,
      reason: `GitHub repository owner "${homepageOwner}" is in the trusted allowlist.`,
    };
  }
  const repoUrlOwner = extractGitHubOwner(body.repository?.url);
  if (repoUrlOwner && trustedOwners.has(repoUrlOwner)) {
    return {
      trusted: true,
      publisher: repoUrlOwner,
      reason: `GitHub repository owner "${repoUrlOwner}" is in the trusted allowlist.`,
    };
  }
  if (repoUrlOwner) {
    return {
      trusted: false,
      publisher: repoUrlOwner,
      reason: `Repository owner "${repoUrlOwner}" is not in the trusted allowlist.`,
    };
  }
  if (homepageOwner) {
    return {
      trusted: false,
      publisher: homepageOwner,
      reason: `Homepage GitHub owner "${homepageOwner}" is not in the trusted allowlist.`,
    };
  }

  for (const maintainer of body.maintainers ?? []) {
    const email = maintainer.email?.trim().toLowerCase();
    if (email) {
      const domain = email.split("@")[1] ?? "";
      if (trustedEmailDomains.some((trusted) => domain === trusted || domain.endsWith(`.${trusted}`))) {
        return {
          trusted: true,
          publisher: domain,
          reason: `Maintainer email domain "${domain}" is in the trusted allowlist.`,
        };
      }
    }
  }
  for (const maintainer of body.maintainers ?? []) {
    const name = maintainer.name?.trim().toLowerCase();
    if (name && trustedMaintainers.has(name)) {
      return {
        trusted: true,
        publisher: name,
        reason: `Trusted npm maintainer "${name}".`,
      };
    }
  }

  const observedMaintainers = (body.maintainers ?? [])
    .map((m) => m.name?.trim().toLowerCase())
    .filter((n): n is string => Boolean(n));
  if (observedMaintainers.length > 0) {
    const sample = observedMaintainers.slice(0, 5).join(", ");
    const more = observedMaintainers.length > 5 ? ` (+${observedMaintainers.length - 5} more)` : "";
    return {
      trusted: false,
      publisher: null,
      reason: `Maintainer(s) "${sample}${more}" are not in the trusted allowlist.`,
    };
  }
  return {
    trusted: false,
    publisher: null,
    reason: "No repository, homepage, or maintainer information was returned by the npm registry.",
  };
}

function buildBaseInfo(
  config: ProviderUpdateConfig,
  currentVersion: string | null,
): ServerProviderUpdateInfo {
  return {
    packageName: config.packageName,
    homepageUrl: config.homepageUrl,
    repositoryUrl: config.repositoryUrl,
    latestVersion: null,
    currentVersion,
    updateAvailable: false,
    fetchedAt: new Date(0).toISOString(),
    verification: {
      trusted: false,
      publisher: null,
      reason: "Update check has not completed yet.",
    },
    commands: config.commands,
  };
}

function buildErrorInfo(
  config: ProviderUpdateConfig,
  currentVersion: string | null,
  error: string,
): ServerProviderUpdateInfo {
  return {
    ...buildBaseInfo(config, currentVersion),
    fetchedAt: new Date().toISOString(),
    error,
  };
}

async function fetchNpmLatest(packageName: string): Promise<NpmLatestResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(packageName).replace(/%2F/g, "/")}/latest`;
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "t3-code-provider-update",
      },
    });
    if (!response.ok) {
      throw new Error(`npm registry returned HTTP ${response.status}.`);
    }
    return (await response.json()) as NpmLatestResponse;
  } finally {
    clearTimeout(timer);
  }
}

const buildInfoForProvider = (
  provider: ProviderKind,
  body: NpmLatestResponse,
  currentVersion: string | null,
  fetchedAtMs: number,
): ServerProviderUpdateInfo => {
  const config = PROVIDER_UPDATE_CONFIG[provider];
  const verification = determineTrustedPublisher(body, config);
  const latestVersion = body.version ?? null;
  const updateAvailable =
    verification.trusted && latestVersion !== null && currentVersion !== null
      ? compareSemver(latestVersion, currentVersion) > 0
      : false;
  return {
    packageName: config.packageName,
    homepageUrl: config.homepageUrl,
    repositoryUrl: config.repositoryUrl,
    latestVersion,
    currentVersion,
    updateAvailable,
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    verification,
    commands: config.commands,
  };
};

export const ProviderUpdateLive = Layer.effect(
  ProviderUpdate,
  Effect.gen(function* () {
    const cacheRef = yield* Ref.make<ReadonlyMap<ProviderKind, CachedEntry>>(new Map());

    const providers: ReadonlyArray<ProviderKind> = ["codex", "opencode", "claudeAgent"];

    const fetchProviderUpdate = (
      provider: ProviderKind,
      currentVersion: string | null,
    ): Effect.Effect<ServerProviderUpdateInfo, never, never> =>
      Effect.gen(function* () {
        const config = PROVIDER_UPDATE_CONFIG[provider];
        const result = yield* Effect.tryPromise(() => fetchNpmLatest(config.packageName)).pipe(
          Effect.map((body) =>
            buildInfoForProvider(provider, body, currentVersion, Date.now()),
          ),
          Effect.catch((error) =>
            Effect.succeed(
              buildErrorInfo(
                config,
                currentVersion,
                error instanceof Error ? error.message : String(error),
              ),
            ),
          ),
        );
        yield* Ref.update(cacheRef, (map) => {
          const next = new Map(map);
          next.set(provider, { info: result, fetchedAtMs: Date.now() });
          return next;
        });
        return result;
      });

    yield* Effect.forEach(
      providers,
      (provider) => fetchProviderUpdate(provider, null).pipe(Effect.asVoid),
      { concurrency: "unbounded", discard: true },
    );

    const readCache = (provider: ProviderKind): Effect.Effect<ServerProviderUpdateInfo, never, never> =>
      Effect.gen(function* () {
        const cached = (yield* Ref.get(cacheRef)).get(provider);
        if (cached && Date.now() - cached.fetchedAtMs < CACHE_TTL_MS) {
          return cached.info;
        }
        return yield* fetchProviderUpdate(
          provider,
          cached?.info.currentVersion ?? null,
        );
      });

    return {
      getUpdates: Effect.gen(function* () {
        const updates = new Map<ProviderKind, ServerProviderUpdateInfo>();
        yield* Effect.forEach(
          providers,
          (provider) =>
            Effect.gen(function* () {
              const info = yield* readCache(provider);
              updates.set(provider, info);
            }),
          { concurrency: "unbounded" },
        );
        return updates;
      }),
      refresh: (provider) =>
        Effect.gen(function* () {
          const cached = (yield* Ref.get(cacheRef)).get(provider);
          return yield* fetchProviderUpdate(
            provider,
            cached?.info.currentVersion ?? null,
          );
        }),
    } satisfies ProviderUpdateShape;
  }),
);
