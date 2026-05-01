# Agentic-Collab Known Issues

## HIGH: Anthropic Subscription TOS Risk

**Date identified:** 2026-04-04
**Status:** Monitoring

### Background

As of April 4, 2026, Anthropic is actively blocking third-party agent harnesses from using Claude subscriptions. They started enforcement against OpenClaw and stated they will extend restrictions to all third-party harnesses.

### Agentic-Collab vs OpenClaw — Key Distinction

- **OpenClaw** extracted OAuth tokens from Claude subscriptions and used them programmatically via API-like calls. This is clearly token theft / credential extraction.
- **Agentic-collab** launches real Claude CLI sessions via tmux. Each agent is a genuine `claude` CLI process running in a terminal — no token extraction, no OAuth hijacking, no API spoofing. The user's subscription is used exactly as intended: through the official CLI.

### Risk

Anthropic's language about "third-party harnesses" is broad. Even though agentic-collab operates fundamentally differently from OpenClaw (real CLI sessions vs extracted tokens), the policy could extend to any tool that programmatically spawns Claude Code. If Anthropic decides that orchestrating multiple CLI sessions counts as a "third-party harness," subscriptions could be blocked.

### Mitigation

If subscriptions get blocked, switch to API billing via `ANTHROPIC_API_KEY`. Claude Code supports API keys natively — agents would simply authenticate via key instead of subscription. Cost shifts from flat subscription to per-token billing.

### Known Bug: Extra Usage Persistence After Reset

Sessions that start during extra usage (overage billing) stay in extra usage even after the subscription billing cycle resets. This is a known Anthropic bug.

**Workaround:** Always use fresh Spawn for new agent sessions. Never Resume old sessions after a subscription reset — the resumed session inherits the old billing context and continues accruing extra usage charges.

### Future: Multi-Subscription Failover

Multiple subscriptions could be load-balanced across agents using `CLAUDE_CONFIG_DIR` env var — each agent points to a different config dir with its own subscription credentials. This would distribute usage across subscriptions and provide failover.

**Status:** Hold off building until Anthropic TOS clarifies. No point engineering around subscriptions if the policy shifts to block programmatic spawning entirely.
