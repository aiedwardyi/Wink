import { afterEach, describe, expect, it, vi } from "vitest";

import { CATALOG_TOOLS, createToolCatalog, experimentalAgents, originalCatalogCall, slimStaticText } from "./tool-catalog.ts";

const core = ["update_task_state", "ask_user", "list_bots", "ask_bot", "delegate_bot", "check_delegation", "wait_delegation", "set_keep_going"];
const optional = ["create_bot", "create_channel", "react", "show_image", "generate_image", "call_api", "request_credential", "list_routines", "propose_routine", "propose_routine_action"];
const tools = [...core, ...optional, "report_issue", "verify_site"].map((name) => ({ name, description: `${name} requirements`, inputSchema: { type: "object", properties: {} } }));

afterEach(() => vi.unstubAllEnvs());

describe("tool catalog", () => {
  it("keeps both experimental switches independent and off by default", () => {
    vi.stubEnv("ORBIT_WINK_TOOL_CATALOG", "");
    vi.stubEnv("ORBIT_WINK_STATIC_SLIM", "");
    const integration = { command: "node", args: ["proxy"], env: { OMB_COMMS_TOKEN: "fixture" } };
    const text = "Memory and task instructions. To create a new image, call generate_image.";
    expect(experimentalAgents(integration)).toBe(integration);
    expect(slimStaticText(text, "claudeAgent")).toBe(text);
    vi.stubEnv("ORBIT_WINK_STATIC_SLIM", "1");
    expect(slimStaticText(text, "claudeAgent")).toBe("Memory and task instructions.");
    expect(experimentalAgents(integration)).toBe(integration);
    vi.stubEnv("ORBIT_WINK_STATIC_SLIM", "");
    vi.stubEnv("ORBIT_WINK_TOOL_CATALOG", "1");
    expect(slimStaticText(text, "codex")).toBe(text);
    expect(experimentalAgents(integration).env).toEqual({ ...integration.env, OMB_WINK_TOOL_CATALOG: "1" });
    expect(integration.env).not.toHaveProperty("OMB_WINK_TOOL_CATALOG");
  });

  it.each(["acp", "grokAgent", "museAgent", "boxAgent"])("preserves %s static instructions", (kind) => {
    vi.stubEnv("ORBIT_WINK_STATIC_SLIM", "1");
    const text = " To create a new image, call generate_image.";
    expect(slimStaticText(text, kind)).toBe(text);
  });

  it("keeps core and gated tools eager with their original definitions", () => {
    const catalog = createToolCatalog(tools);
    expect(catalog.tools.map((tool) => tool.name)).toEqual([...core, "report_issue", "verify_site", "find_wink_tool", "call_wink_tool"]);
    for (const tool of tools.filter((tool) => !optional.includes(tool.name))) expect(catalog.tools).toContain(tool);
  });

  it("fits the serialized pair and prefixed names inside 1200 UTF-16 units", () => {
    expect(JSON.stringify(CATALOG_TOOLS).length).toBeLessThanOrEqual(1200);
    expect(JSON.stringify(CATALOG_TOOLS.map((tool) => ({ ...tool, name: `mcp__agents__${tool.name}` }))).length).toBeLessThanOrEqual(1200);
  });

  it.each(optional)("discovers and routes %s with its original arguments", (name) => {
    const catalog = createToolCatalog(tools);
    const discovery = JSON.parse(catalog.find({ query: name }).text);
    expect(discovery.tools).toContainEqual(tools.find((tool) => tool.name === name));
    expect(discovery.requirements).toContain("confirmation requirements");
    const args = { original: "value" };
    expect(catalog.resolve({ name, arguments: args })).toEqual({ name, arguments: args });
  });

  it("does not expose or unlock tools outside the eligible optional set", () => {
    const catalog = createToolCatalog(tools.filter((tool) => tool.name === "list_routines" || core.includes(tool.name)));
    expect(JSON.parse(catalog.find({ query: "create_bot" }).text).tools).toEqual([]);
    expect(catalog.resolve({ name: "create_bot", arguments: {} })).toHaveProperty("error");
    expect(catalog.resolve({ name: "list_routines", arguments: {} })).toEqual({ name: "list_routines", arguments: {} });
    expect(createToolCatalog([]).tools).toEqual([]);
  });

  it.each(["find_wink_tool", "call_wink_tool", "ask_user", "__proto__", "constructor", "missing"])("rejects gateway target %s", (name) => {
    expect(createToolCatalog(tools).resolve({ name, arguments: {} })).toHaveProperty("error");
  });

  it.each([null, [], {}, { name: "react", arguments: [] }, { name: "react", arguments: {}, fromBotId: "other" }])("rejects invalid gateway arguments %j", (args) => {
    expect(createToolCatalog(tools).resolve(args)).toHaveProperty("error");
  });

  it("preserves original-tool audit names and inputs", () => {
    const input = { name: "show_image", arguments: { path: "/fixture/image.png" } };
    expect(originalCatalogCall("mcp__agents__call_wink_tool", input)).toEqual({ name: "mcp__agents__show_image", input: input.arguments });
    expect(originalCatalogCall("call_wink_tool", input, "agents")).toEqual({ name: "show_image", input: input.arguments });
    expect(originalCatalogCall("call_wink_tool", input, "other")).toEqual({ name: "call_wink_tool", input });
    expect(originalCatalogCall("other__call_wink_tool", input)).toEqual({ name: "other__call_wink_tool", input });
  });
});
