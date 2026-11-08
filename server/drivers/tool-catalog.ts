export type CatalogTool = { name: string; description: string; inputSchema: object };
type Integration = { command: string; args: string[]; env: Record<string, string> };

const OPTIONAL = new Set([
  "create_bot", "create_channel", "react", "show_image", "generate_image",
  "call_api", "request_credential", "list_routines", "propose_routine", "propose_routine_action",
]);

export const CATALOG_TOOLS = [
  {
    name: "find_wink_tool",
    description: "Find Wink tools for bot/channel creation, reactions, images, APIs/credentials, or routines. Read the returned original schema and requirements before calling.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  },
  {
    name: "call_wink_tool",
    description: "Call a discovered Wink tool by its original name and arguments. Its original validation, permissions and confirmation requirements still apply.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, arguments: { type: "object" } }, required: ["name", "arguments"], additionalProperties: false },
  },
] satisfies CatalogTool[];

export function experimentalAgents(integration: Integration): Integration {
  return process.env.ORBIT_WINK_TOOL_CATALOG === "1"
    ? { ...integration, env: { ...integration.env, OMB_WINK_TOOL_CATALOG: "1" } }
    : integration;
}

export function slimStaticText(text: string, driverKind: string): string {
  if (process.env.ORBIT_WINK_STATIC_SLIM !== "1" || !["claudeAgent", "codex"].includes(driverKind)) return text;
  return text.replace(" To create a new image, call generate_image.", "");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createToolCatalog(eligible: readonly CatalogTool[]) {
  const optional = eligible.filter((tool) => OPTIONAL.has(tool.name));
  return {
    tools: [...eligible.filter((tool) => !OPTIONAL.has(tool.name)), ...(optional.length ? CATALOG_TOOLS : [])],
    find(args: unknown) {
      if (!record(args) || typeof args.query !== "string" || !args.query.trim() || Object.keys(args).some((key) => key !== "query")) return { text: "find_wink_tool needs query: a tool name or action.", isError: true };
      const words = args.query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean).map((word) => word.replace(/s$/, ""));
      const tools = words.length ? optional.filter((tool) => words.some((word) => `${tool.name} ${tool.description}`.toLowerCase().includes(word))) : [];
      return { text: JSON.stringify({ tools, requirements: "Follow the original schema, permissions and confirmation requirements." }), isError: false };
    },
    resolve(args: unknown): { name: string; arguments: Record<string, unknown> } | { error: string } {
      if (!record(args) || typeof args.name !== "string" || !record(args.arguments) || Object.keys(args).some((key) => key !== "name" && key !== "arguments")) return { error: "call_wink_tool needs name and an arguments object." };
      const input = args as { name: string; arguments: Record<string, unknown> };
      const tool = optional.find((tool) => tool.name === input.name);
      if (!tool) return { error: `Unavailable Wink tool: ${input.name}` };
      return input;
    },
  };
}

export function originalCatalogCall(name: string, input: unknown, server?: string): { name: string; input: unknown } {
  if (((name === "call_wink_tool" && server === "agents") || name === "mcp__agents__call_wink_tool") && record(input) && typeof input.name === "string" && OPTIONAL.has(input.name) && record(input.arguments)) {
    return { name: name.replace("call_wink_tool", input.name), input: input.arguments };
  }
  return { name, input };
}
