# Memory prompt adaptations

Sleep adapts source verification and a final organization pass from the analyzer and organizer prompts at revision `ce8b2629efe8b24048b127b4c79af1e9cbab93d4`:

- https://github.com/anthropics/claude-cookbooks/blob/ce8b2629efe8b24048b127b4c79af1e9cbab93d4/managed_agents/example_data/memory_distill/prompts/analyzer_system.md
- https://github.com/anthropics/claude-cookbooks/blob/ce8b2629efe8b24048b127b4c79af1e9cbab93d4/managed_agents/example_data/memory_distill/prompts/organizer_system.md

The adapted prompts accept user evidence and typed operations. Code renders candidates; the organizer verifies every source and destination without file tools. The upstream MIT license is preserved in LICENSE.

The operation/output split also follows https://github.com/openclaw/openclaw/blob/main/docs/concepts/dreaming.md. No runtime or dependencies are imported.
