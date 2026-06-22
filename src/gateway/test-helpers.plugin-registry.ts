import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createDefaultGatewayTestChannels } from "./test-helpers.channels.js";
import { createDefaultGatewayTestSpeechProviders } from "./test-helpers.speech.js";

function createStubPluginRegistry(): PluginRegistry {
  const registry = createEmptyPluginRegistry();
  registry.channels = createDefaultGatewayTestChannels();
  registry.speechProviders = createDefaultGatewayTestSpeechProviders();
  return registry;
}

const GATEWAY_TEST_PLUGIN_REGISTRY_STATE_KEY = Symbol.for(
  "openclaw.gatewayTestHelpers.pluginRegistryState",
);

const pluginRegistryState = resolveGlobalSingleton(GATEWAY_TEST_PLUGIN_REGISTRY_STATE_KEY, () => ({
  registry: createStubPluginRegistry(),
}));

setActivePluginRegistry(pluginRegistryState.registry);

export function setTestPluginRegistry(registry: PluginRegistry): void {
  pluginRegistryState.registry = registry;
  setActivePluginRegistry(registry);
}

export function resetTestPluginRegistry(): void {
  pluginRegistryState.registry = createStubPluginRegistry();
  setActivePluginRegistry(pluginRegistryState.registry);
}

export function getTestPluginRegistry(): PluginRegistry {
  return pluginRegistryState.registry;
}
