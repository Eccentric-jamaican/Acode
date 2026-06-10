import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { PROVIDER_UPDATE_CONFIG, type ProviderUpdateConfig } from "@t3tools/contracts";

import { determineTrustedPublisher, extractGitHubOwner } from "./ProviderUpdate";

const codexConfig: ProviderUpdateConfig = PROVIDER_UPDATE_CONFIG.codex;
const opencodeConfig: ProviderUpdateConfig = PROVIDER_UPDATE_CONFIG.opencode;
const claudeConfig: ProviderUpdateConfig = PROVIDER_UPDATE_CONFIG.claudeAgent;

it("extractGitHubOwner", () => {
  assert.equal(extractGitHubOwner("https://github.com/openai/codex#readme"), "openai");
  assert.equal(extractGitHubOwner("git+https://github.com/sst/opencode.git"), "sst");
  assert.equal(extractGitHubOwner("git@github.com:anthropics/claude-code.git"), "anthropics");
  assert.equal(extractGitHubOwner("github:openai/codex"), "openai");
  assert.equal(extractGitHubOwner(undefined), null);
  assert.equal(extractGitHubOwner(""), null);
  assert.equal(extractGitHubOwner("https://example.com/owner/repo"), null);
});

it("determineTrustedPublisher: codex homepage", () => {
  const result = determineTrustedPublisher(
    { version: "0.137.0", homepage: "https://github.com/openai/codex#readme" },
    codexConfig,
  );
  assert.equal(result.trusted, true);
  assert.equal(result.publisher, "openai");
});

it("determineTrustedPublisher: codex maintainer email domain", () => {
  const result = determineTrustedPublisher(
    {
      version: "0.137.0",
      maintainers: [{ name: "dylan-hurd-openai", email: "dylan.hurd@openai.com" }],
    },
    codexConfig,
  );
  assert.equal(result.trusted, true);
  assert.equal(result.publisher, "openai.com");
});

it("determineTrustedPublisher: claude homepage", () => {
  const result = determineTrustedPublisher(
    { version: "2.1.168", homepage: "https://github.com/anthropics/claude-code" },
    claudeConfig,
  );
  assert.equal(result.trusted, true);
  assert.equal(result.publisher, "anthropics");
});

it("determineTrustedPublisher: opencode trusted maintainer", () => {
  const result = determineTrustedPublisher(
    {
      version: "1.16.2",
      maintainers: [{ name: "thdxr", email: "d@ironbay.co" }],
    },
    opencodeConfig,
  );
  assert.equal(result.trusted, true);
  assert.equal(result.publisher, "thdxr");
});

it("determineTrustedPublisher: rejects untrusted repo owner", () => {
  const result = determineTrustedPublisher(
    { version: "1.0.0", homepage: "https://github.com/evil-actor/codex" },
    codexConfig,
  );
  assert.equal(result.trusted, false);
  assert.equal(result.publisher, "evil-actor");
  assert.match(result.reason ?? "", /evil-actor/);
});

it("determineTrustedPublisher: rejects untrusted maintainers when no repo info", () => {
  const result = determineTrustedPublisher(
    {
      version: "1.0.0",
      maintainers: [
        { name: "sketchy-maintainer", email: "evil@example.com" },
        { name: "another-suspect", email: "sus@example.com" },
      ],
    },
    codexConfig,
  );
  assert.equal(result.trusted, false);
  assert.equal(result.publisher, null);
  assert.match(result.reason ?? "", /sketchy-maintainer/);
});

it("determineTrustedPublisher: no signals at all", () => {
  const result = determineTrustedPublisher({ version: "1.0.0" }, codexConfig);
  assert.equal(result.trusted, false);
  assert.equal(result.publisher, null);
  assert.match(result.reason ?? "", /No repository, homepage, or maintainer/);
});
