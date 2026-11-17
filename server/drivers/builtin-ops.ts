// Ask preallows only "read" and "chat" ops; the rest go through the Ask card native writes use.
// "chat" stays in Wink's own chats or opens a card the user answers; a peer keeps its own approval.
export type OpEffect = "read" | "chat" | "mutation" | "billing" | "device" | "key";

const OPS = {
  agents: {
    list_bots: "read",
    check_delegation: "read",
    wait_delegation: "read",
    usage_status: "read",
    list_routines: "read",
    board_search: "read",
    search_my_chats: "read",
    verify_site: "read",
    find_wink_tool: "read",
    ask_user: "chat",
    react: "chat",
    show_image: "chat",
    update_task_state: "chat",
    no_reply_needed: "chat",
    hand_off: "chat",
    ask_bot: "chat",
    delegate_bot: "chat",
    request_credential: "chat",
    propose_routine: "chat",
    propose_routine_action: "chat",
    wake_me: "chat",
    board_post: "chat",
    link_room_fix: "chat",
    create_bot: "mutation",
    create_channel: "mutation",
    set_keep_going: "mutation",
    report_issue: "mutation",
    // dispatches any optional tool by name, so it is gated as its riskiest target
    call_wink_tool: "mutation",
    generate_image: "billing",
    call_api: "key",
  },
  phone: {
    status: "read",
    read_screen: "read",
    screenshot: "read",
    list_apps: "read",
    open_app: "device",
    tap_text: "device",
    tap: "device",
    swipe: "device",
    type_text: "device",
    press: "device",
  },
  // no Wink server ships these tools, so none is known to be read-only
  browser: {},
  terminal: {
    terminal_read: "read",
    terminal_playbook: "read",
    terminal_send: "device",
    terminal_spawn: "device",
    terminal_close: "device",
  },
} satisfies Record<string, Record<string, OpEffect>>;

export type BuiltinServer = keyof typeof OPS;

// Codex mounts the phone server under its older name.
const MOUNTS = { agents: "agents", phone: "phone", openmausbot_phone: "phone", browser: "browser", terminal: "terminal" } as const satisfies Record<string, BuiltinServer>;

/** The op table for a Claude server key or Codex mount name; undefined for any other server. */
export function builtinOps(server: string): Readonly<Record<string, OpEffect>> | undefined {
  const mount = Object.entries(MOUNTS).find(([name]) => name === server)?.[1];
  return mount && OPS[mount];
}

/** An op this table does not list, or a server it does not know, counts as a side effect. */
export function opEffect(server: string, tool: string | undefined): OpEffect {
  return Object.entries(builtinOps(server) ?? {}).find(([name]) => name === tool)?.[1] ?? "mutation";
}

export function isSideEffectOp(server: string, tool: string | undefined): boolean {
  const effect = opEffect(server, tool);
  return effect !== "read" && effect !== "chat";
}

/** The ops of one built-in server an Ask turn runs without a card. */
export function askPreallowedOps(server: BuiltinServer): string[] {
  return Object.keys(OPS[server]).filter((tool) => !isSideEffectOp(server, tool));
}
