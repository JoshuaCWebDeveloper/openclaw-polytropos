import { beforeEach, describe, expect, it } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addStaticTestHooks } from "./hooks.test-helpers.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type {
  PluginHookBeforeModelResolveResult,
  PluginHookBeforePromptBuildResult,
  PluginHookBeforeTurnDeveloperInstructionsResult,
} from "./types.js";

describe("phase hooks merger", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  async function runPhaseHook(params: {
    hookName: "before_model_resolve" | "before_prompt_build" | "before_turn_developer_instructions";
    hooks: ReadonlyArray<{
      pluginId: string;
      result:
        | PluginHookBeforeModelResolveResult
        | PluginHookBeforePromptBuildResult
        | PluginHookBeforeTurnDeveloperInstructionsResult;
      priority?: number;
    }>;
  }) {
    addStaticTestHooks(registry, {
      hookName: params.hookName,
      hooks: [...params.hooks],
    });
    const runner = createHookRunner(registry);
    if (params.hookName === "before_model_resolve") {
      return await runner.runBeforeModelResolve({ prompt: "test" }, {});
    }
    if (params.hookName === "before_turn_developer_instructions") {
      return await runner.runBeforeTurnDeveloperInstructions(
        { developerInstructions: "test instructions" },
        {},
      );
    }
    return await runner.runBeforePromptBuild({ prompt: "test", messages: [] }, {});
  }

  async function expectPhaseHookMerge(params: {
    hookName: "before_model_resolve" | "before_prompt_build" | "before_turn_developer_instructions";
    hooks: ReadonlyArray<{
      pluginId: string;
      result:
        | PluginHookBeforeModelResolveResult
        | PluginHookBeforePromptBuildResult
        | PluginHookBeforeTurnDeveloperInstructionsResult;
      priority?: number;
    }>;
    expected:
      | PluginHookBeforeModelResolveResult
      | PluginHookBeforePromptBuildResult
      | PluginHookBeforeTurnDeveloperInstructionsResult;
  }) {
    const result = await runPhaseHook(params);
    expect(result).toStrictEqual(params.expected);
  }

  it.each([
    {
      name: "before_model_resolve keeps higher-priority override values",
      hookName: "before_model_resolve" as const,
      hooks: [
        { pluginId: "low", result: { modelOverride: "demo-low-priority-model" }, priority: 1 },
        {
          pluginId: "high",
          result: {
            modelOverride: "demo-high-priority-model",
            providerOverride: "demo-provider",
          },
          priority: 10,
        },
      ],
      expected: {
        modelOverride: "demo-high-priority-model",
        providerOverride: "demo-provider",
      },
    },
    {
      name: "before_prompt_build concatenates prependContext and preserves systemPrompt precedence",
      hookName: "before_prompt_build" as const,
      hooks: [
        {
          pluginId: "high",
          result: { prependContext: "context A", systemPrompt: "system A" },
          priority: 10,
        },
        {
          pluginId: "low",
          result: { prependContext: "context B", systemPrompt: "system B" },
          priority: 1,
        },
      ],
      expected: {
        prependContext: "context A\n\ncontext B",
        appendContext: undefined,
        prependSystemContext: undefined,
        appendSystemContext: undefined,
        systemPrompt: "system A",
      },
    },
    {
      name: "before_prompt_build concatenates prependSystemContext and appendSystemContext",
      hookName: "before_prompt_build" as const,
      hooks: [
        {
          pluginId: "first",
          result: {
            prependSystemContext: "prepend A",
            appendSystemContext: "append A",
          },
          priority: 10,
        },
        {
          pluginId: "second",
          result: {
            prependSystemContext: "prepend B",
            appendSystemContext: "append B",
          },
          priority: 1,
        },
      ],
      expected: {
        systemPrompt: undefined,
        prependContext: undefined,
        appendContext: undefined,
        prependSystemContext: "prepend A\n\nprepend B",
        appendSystemContext: "append A\n\nappend B",
      },
    },
    {
      name: "before_turn_developer_instructions can replace and concatenate developer instructions",
      hookName: "before_turn_developer_instructions" as const,
      hooks: [
        {
          pluginId: "high",
          result: {
            developerInstructions: "override A",
            prependDeveloperInstructions: "prepend A",
            appendDeveloperInstructions: "append A",
          },
          priority: 10,
        },
        {
          pluginId: "low",
          result: {
            developerInstructions: "override B",
            prependDeveloperInstructions: "prepend B",
            appendDeveloperInstructions: "append B",
          },
          priority: 1,
        },
      ],
      expected: {
        developerInstructions: "override A",
        prependDeveloperInstructions: "prepend A\n\nprepend B",
        appendDeveloperInstructions: "append A\n\nappend B",
      },
    },
  ] as const)("$name", async ({ hookName, hooks, expected }) => {
    await expectPhaseHookMerge({ hookName, hooks, expected });
  });
});
