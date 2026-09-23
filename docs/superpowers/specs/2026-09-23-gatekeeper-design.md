# Gatekeeper: Design Spec

Date: 2026-09-23
Status: Draft, pending review

## Problem

An agent host that connects to many MCP servers ends up with a huge flat
tool catalog. Every tool's name and schema gets stuffed into the model's
context on every turn, which is expensive and drowns relevant tools in
irrelevant ones. There's also no uniform safety check before a tool with
real-world side effects (delete, send, pay, etc.) actually executes —
whatever gating exists is whatever each individual server chose to build,
inconsistently.

## Goals

- Cut context cost: the host sees two tools, not the union of every
  upstream server's tools.
- Surface only the tools relevant to the task at hand, ranked, cheaply.
- Gate risky invocations behind explicit confirmation, uniformly, across
  every upstream server, without each server having to implement its own
  check.

## Non-goals

- Not a general-purpose MCP proxy/router for arbitrary traffic shaping.
- Not responsible for authenticating the human — `confirmed: true` is a
  protocol-level flag the calling agent sets; enforcing that a *human*
  (not the agent itself) supplied that confirmation is a host UI concern,
  out of scope here (see Open Questions).
- Not attempting perfect risk classification. The Jev judgment is a
  probabilistic best-effort signal, backstopped by static rules for the
  cases that must never slip through.

## Architecture

Gatekeeper is a standalone MCP server, speaking stdio, that sits between
the agent host and the real upstream MCP servers.

```
 Agent Host  <--stdio-->  Gatekeeper  <--(stdio/http, per upstream)-->  Upstream MCP Server A
                                       <---------------------------->  Upstream MCP Server B
                                       <---------------------------->  Upstream MCP Server C
```

Gatekeeper exposes exactly two tools to the host:

- `find_tools(task: string, top_k?: number)`
- `call_tool(name: string, arguments: object, task?: string, confirmed?: boolean)`

Everything else — the real tools on servers A, B, C — is aggregated
internally and never exposed directly to the host.

## Components

### 1. Config

A static config (file or env) lists the upstream MCP servers Gatekeeper
should connect to at startup: command/args (stdio) or URL (http), one
entry per server. Optionally, a list of risk backstop patterns (see
Risk Gate below).

### 2. Catalog aggregation

On startup, Gatekeeper connects to every configured upstream server and
calls `tools/list` on each. Every tool is namespaced as
`<server_name>.<tool_name>` and stored in an in-memory catalog:
`{ namespaced_name, server_name, original_name, description, input_schema }`.

This catalog is the source of truth for both `find_tools` and `call_tool`.
It is built once at startup; this spec doesn't cover live upstream
tool-list changes (see Open Questions).

### 3. `find_tools(task, top_k?)` — relevance only

Purpose: given a natural-language task description, return the tools
most likely to be useful, ranked.

Implementation: one Jev **Choice** call per search. `criteria` is the
namespaced tool catalog (name → description), `state` is the task. Jev
returns a `probabilities` distribution over the criteria; that
distribution *is* the relevance score per tool. If the catalog exceeds
255 entries (Jev Choice's per-call cap), shard into multiple Choice
calls and merge the resulting distributions before ranking.

Filtering: drop tools below a relevance threshold, then cap at
`top_k` (default e.g. 10). Return each surviving tool's namespaced name,
description, input schema, and relevance score. No risk information is
returned here — risk is evaluated at call time, not discovery time (see
below).

### 4. `call_tool(name, arguments, task?, confirmed?)` — execution + risk gate

Purpose: execute a specific tool call, but gate it behind a risk check
first.

Why the risk check happens here, not in `find_tools`: risk is a property
of a *concrete invocation*, not of a tool in the abstract.
`delete_branch(branch: "release-2.3")` and
`delete_branch(branch: "throwaway-experiment")` carry very different
stakes, and that distinction only exists once the agent has picked
actual argument values. Evaluating risk at discovery time, using only
the tool's abstract description, would be a weaker and sometimes
misleading signal.

Steps:

1. Look up `name` in the catalog. Unknown name → error.
2. Validate `arguments` against the tool's `input_schema`. Invalid →
   error, tool is not invoked.
3. **Static backstop check**: if `name` or `server_name` matches any
   configured backstop pattern (e.g. `delete_*`, `*_transfer`,
   `*.send_email`), the call is flagged risky unconditionally — skip
   straight to step 5. This is a deterministic safety net independent of
   the model call in step 4, for the cases that must never depend on a
   probabilistic judgment.
4. **Jev risk judgment** (only if step 3 didn't already flag it): one
   Jev **Noul** call with `state = { task, tool_name: name, description,
   arguments }` and instructions asking whether executing this exact
   call, in this context, would be high-stakes or hard to reverse.
   Rubric given to Jev: irreversible or hard-to-reverse state changes
   (deletion, overwrites with no undo), anything that moves money or
   payment instruments, anything that sends a message or publishes
   content visible to someone other than the caller, and anything that
   changes account/security/access settings. A returned score above a
   configured threshold marks the call risky.
5. If risky and `confirmed !== true` → **do not execute**. Return a
   structured result (not a thrown error) so the agent can parse and
   relay it:
   ```json
   {
     "status": "confirmation_required",
     "tool": "<namespaced name>",
     "reason": "<short human-readable explanation of why this was flagged>",
     "message": "This action requires human confirmation. Ask the user, then retry this call with confirmed: true."
   }
   ```
6. If safe, or risky-but-`confirmed === true` → forward the call to the
   owning upstream server's `tools/call` with the original (un-namespaced)
   tool name and the given arguments, and return its result unmodified.

Cost shape: exactly one Jev call per `call_tool` invocation that isn't
already caught by a static pattern — not per candidate tool, not per
catalog entry. Cost scales with how many tools actually get *invoked*,
not with catalog size or how many were merely surfaced.

## Data flow (typical turn)

1. Agent calls `find_tools("delete the stale feature-branch merges")`.
2. Gatekeeper runs one Jev Choice call over the catalog, returns ranked
   candidates including `git_server.delete_branch`.
3. Agent picks a tool and arguments, calls
   `call_tool("git_server.delete_branch", { branch: "old-experiment" }, task: "...")`.
4. Gatekeeper checks backstop patterns (`delete_*` matches) → flags
   risky without needing the Jev call.
5. `confirmed` not set → Gatekeeper returns `confirmation_required`.
6. Agent surfaces the reason to the human, gets a yes, calls again with
   `confirmed: true`.
7. Gatekeeper forwards to `git_server`, returns the real result.

## Error handling

- Unknown tool name, schema validation failure, upstream connection
  failure, upstream tool-call error: each returned as a distinct
  structured error (not conflated with `confirmation_required`, which is
  a deliberate non-error control-flow result, not a failure).
  Distinguishing this matters because an agent should retry
  `confirmation_required` after getting a human yes, but should not
  blindly retry a genuine failure the same way.
- If the Jev risk-judgment call itself fails (timeout, API error): fail
  closed — treat the call as risky and require confirmation, rather than
  silently executing an unassessed action.

## Configuration

- `servers`: list of upstream MCP server connection configs.
- `relevance_threshold`, `top_k_default`: tune `find_tools` filtering.
- `risk_threshold`: tune the Jev Noul risk cutoff.
- `risk_backstop_patterns`: list of glob patterns matched against
  namespaced tool names, always risky regardless of Jev's judgment.

## Testing strategy

- Unit: catalog aggregation/namespacing against a mock upstream server.
- Unit: `find_tools` sharding logic for catalogs > 255 tools (mock Jev
  Choice responses).
- Unit: `call_tool` gate logic — backstop pattern match, Jev-flagged
  risky without `confirmed`, Jev-flagged risky with `confirmed: true`,
  safe path, Jev-call-failure fail-closed behavior — all with a mocked
  Jev client so tests don't depend on live model calls.
- Integration: one real lightweight upstream MCP server (e.g. a
  filesystem server) end-to-end through `find_tools` → `call_tool` →
  confirmation → retry, against the real Jev primitives.

## Open questions (non-blocking, for future iteration)

- **Confirmation authenticity**: `confirmed: true` is presently just a
  flag the calling agent sets on its own next call. Nothing here
  verifies that a human actually approved it rather than the agent
  deciding on its own to retry with `confirmed: true`. Closing this gap
  needs host-side support (e.g. the host itself intercepts
  `confirmation_required` results and only forwards a retry after real
  human input) that MCP doesn't standardize today. Documented as a known
  limitation, not solved by this spec.
- **Live catalog updates**: this spec builds the catalog once at
  startup. Upstream servers whose tool lists change at runtime
  (`notifications/tools/list_changed`) aren't handled yet.
