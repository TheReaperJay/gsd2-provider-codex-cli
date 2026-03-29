/**
 * Codex CLI extension entry point.
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { removeProviderInfo, wireLifecycleHooks, wireProvidersToPI } from "@thereaperjay/gsd-provider-api";

export default async function(pi: ExtensionAPI): Promise<void> {
  removeProviderInfo("codex-reaper");

  await import("./info.ts");
  wireLifecycleHooks(pi);
  await wireProvidersToPI(pi);
}
