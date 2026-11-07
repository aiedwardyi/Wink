export const AUTO_RULE_TOOL = {
  name: "auto_rule",
  description: "Keep a worker pick or edit Auto rules from this user's live typed instruction. quote must cite their own words naming every model/effort. Invalid requests are hints. Chat picks are deferred. Undo restores the newest change; inspect only when asked.",
  inputSchema: {
    type: "object", additionalProperties: false,
    properties: {
      op: { type: "string", enum: ["pick", "setPreference", "remove", "reset", "forgetHabits", "revert", "inspect", "undo"] },
      target: { type: "string", enum: ["worker", "chat"] },
      taskClass: { type: "string", enum: ["quick", "chat", "writing", "creative", "research", "edit", "build", "bug", "architecture", "design", "audit", "protected", "unknown"] },
      model: { type: "string" }, effort: { type: "string", enum: ["minimal", "low", "medium", "high", "xhigh", "max"] },
      max: { type: "boolean" }, requireSecondFamily: { type: "boolean" }, version: { type: "integer" }, quote: { type: "string" },
    },
    required: ["op", "quote"],
  },
} as const;
