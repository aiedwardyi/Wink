// Tool names of Wink's own MCP servers, keyed by the server name the engines mount them under.
// Each proxy's TOOLS array `satisfies` its list (dweb, phone: their tests check), so a new tool fails until it is named here.
export const MCP_TOOL_NAMES = {
  agents: [
    "report_issue", "verify_site", "find_wink_tool", "call_wink_tool",
    "list_bots", "update_task_state", "ask_bot", "delegate_bot", "check_delegation", "wait_delegation",
    "create_bot", "create_channel", "react", "ask_user", "show_image", "generate_image", "call_api",
    "request_credential", "list_routines", "propose_routine", "propose_routine_action", "set_keep_going",
  ],
  computer: [
    "screenshot", "browser_state", "browser_snapshot", "browser_click", "browser_fill", "wait_for_navigation",
    "observation_metrics", "computer_status", "computer_request_help", "click", "type_text", "press_key",
    "scroll", "computer_batch", "computer_exec", "open_url",
  ],
  dweb: ["dweb_status", "dweb_repo_status", "dweb_opencode_models", "dweb_opencode_run"],
  phone: ["status", "read_screen", "screenshot", "list_apps", "open_app", "tap_text", "tap", "swipe", "type_text", "press"],
  terminal: ["terminal_read", "terminal_send", "terminal_spawn", "terminal_close"],
} as const;

export type McpTool<Server extends keyof typeof MCP_TOOL_NAMES> = { name: (typeof MCP_TOOL_NAMES)[Server][number]; [key: string]: unknown };

// The Claude CLI's default built-ins (its init tool list).
const CLAUDE_BUILT_INS = [
  "Task", "Bash", "CronCreate", "CronDelete", "CronList", "DesignSync", "Edit", "EnterWorktree", "ExitWorktree", "Glob",
  "Grep", "ListAgents", "Monitor", "NotebookEdit", "PowerShell", "PushNotification", "Read", "RemoteTrigger",
  "ReportFindings", "ScheduleWakeup", "SendMessage", "Skill", "TaskStop", "ToolSearch", "WebFetch", "WebSearch",
  "Workflow", "Write",
];

/** CLAUDE_CODE_TERMINAL_MCP_TOOLS: the CLI skips its "no visible output" nudge when a turn's last tool is listed. */
export function claudeTerminalTools(servers: readonly string[], builtIns: readonly string[] = CLAUDE_BUILT_INS): string {
  const mcp = servers.flatMap((server) => server in MCP_TOOL_NAMES ? MCP_TOOL_NAMES[server as keyof typeof MCP_TOOL_NAMES].map((name) => `mcp__${server}__${name}`) : []);
  return [...builtIns, ...mcp].join(",");
}
