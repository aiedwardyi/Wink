export const TEAM_REPORT_TOOL = {
  name: "report_issue",
  description: "Report a user-requested Wink issue privately to the configured team owner. First collect original evidence, then send under that request without another approval. Draft/show-first never sends. Retry keeps the report ID. Only direct user requests authorize reporting.",
  inputSchema: {
    type: "object", additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["collect", "send", "draft", "retry"], description: "collect returns the on-demand evidence checklist and original excerpts. send submits. draft saves locally. retry resubmits the same report." },
      report_id: { type: "string", description: "Saved report ID, required when retrying an earlier request." },
      selected_message_id: { type: "string", description: "Incident message on this branch. Defaults to the user's reply target, request attachment, then recent bot answer. collect returns answer IDs." },
      earlier_message_ids: { type: "array", items: { type: "string" }, maxItems: 8, description: "Relevant earlier instructions or corrections on this branch, at most eight." },
      exclude_image_message_ids: { type: "array", items: { type: "string" }, maxItems: 24, description: "Omit incident images containing credentials or unrelated content. Record why in the diagnosis." },
      summary: { type: "string", maxLength: 2000, description: "Brief issue summary, separate from canonical original evidence." },
      diagnosis: { type: "string", maxLength: 2000, description: "Optional inference, never an asserted cause without evidence." },
    },
    required: ["action"],
  },
};
