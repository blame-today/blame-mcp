// blame.today remote MCP server — Cloudflare Worker.
//
// blame.today is a public, anonymous "who do you blame today" board backed by Nostr. Anyone
// can post a blame TARGET and pile votes onto existing targets; everything is signed with a
// throwaway random key per event, so there is no identity and no account — pure catharsis.
//
// This MCP server exposes that board to AI agents over Streamable HTTP at /mcp. The tools wrap
// the verified Nostr wire protocol (see ./nostr.ts). The McpAgent class is a Durable Object
// (SQLite-backed) per the agents SDK; we keep no app state of our own — each call goes straight
// to the relays.

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  signTarget,
  signVote,
  publishEvent,
  listTargets,
  scoreTarget,
} from "./nostr.ts";

// Soft house rule, surfaced in the write-tool descriptions.
const HOUSE_RULE =
  "House rule: blame ideas, institutions, weather, concepts, public figures; " +
  "try to leave private non-public individuals out of it.";

// Cap leaderboard COUNT work to stay inside Worker subrequest limits (free plan: 50 subrequests
// per invocation). Each COUNT can retry a 2nd relay if the first doesn't answer, so worst case is
// 2x this — keep it at 20 (<=40 outbound) to stay safely under the 50 cap.
const LEADERBOARD_COUNT_CAP = 20;

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

export class MyMCP extends McpAgent<Env, Record<string, never>, Record<string, never>> {
  server = new McpServer(
    { name: "blame-today", version: "1.0.0" },
    {
      instructions:
        "blame.today is a public, anonymous catharsis board — 'who do you blame today?' " +
        "It is backed by the Nostr protocol. Use `blame` to post a new thing to blame, " +
        "`pile_on` to add a vote to an existing target, `list_targets` to see what's on the " +
        "board, `score` to read one target's vote count, and `leaderboard` for the most-blamed " +
        "targets. Every post and vote is an anonymous, throwaway-keyed Nostr event — there are " +
        "no accounts and no identity, so votes are uncapped. " +
        HOUSE_RULE,
    }
  );

  async init(): Promise<void> {
    // 1. blame — create a NEW target (kind 1).
    this.server.tool(
      "blame",
      "Post a new thing to blame onto the blame.today board (creates a new target). Returns " +
        "the created target's id. " +
        HOUSE_RULE,
      { text: z.string().min(1).max(500).describe("The thing to blame.") },
      async ({ text: blameText }) => {
        const ev = signTarget(blameText);
        const ok = await publishEvent(ev);
        if (!ok) {
          return text(
            `Couldn't confirm the blame reached a relay in time. It may still land. ` +
              `Target id (if it did): ${ev.id}`
          );
        }
        return text(
          `Blamed: "${blameText}". Target id: ${ev.id}. ` +
            `Others can now pile_on with this id.`
        );
      }
    );

    // 2. pile_on — add a vote (kind 7) to an existing target.
    this.server.tool(
      "pile_on",
      "Add a vote to an existing blame target (pile on). Takes the target_id from `blame` or " +
        "`list_targets`. " +
        HOUSE_RULE,
      { target_id: z.string().min(1).describe("The id of the target to vote on.") },
      async ({ target_id }) => {
        const ev = signVote(target_id);
        const ok = await publishEvent(ev);
        if (!ok) {
          return text(
            `Couldn't confirm the vote reached a relay in time. It may still land.`
          );
        }
        return text(`Piled on ${target_id}. Your 💥 has been cast.`);
      }
    );

    // 3. list_targets — current targets as [{ id, text }].
    this.server.tool(
      "list_targets",
      "List current blame targets on the board. Returns up to `limit` targets with their ids.",
      {
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Max targets to return (default 50)."),
      },
      async ({ limit }) => {
        const targets = await listTargets(limit ?? 50);
        if (targets.length === 0) {
          return text("No targets found on the board right now.");
        }
        const lines = targets.map((t) => `- ${t.text}  [id: ${t.id}]`).join("\n");
        return text(`Current blame targets (${targets.length}):\n${lines}`);
      }
    );

    // 4. score — vote count for one target.
    this.server.tool(
      "score",
      "Get the vote count for a single blame target by its id.",
      { target_id: z.string().min(1).describe("The id of the target to score.") },
      async ({ target_id }) => {
        const count = await scoreTarget(target_id);
        return text(`Target ${target_id} has ${count} blame vote${count === 1 ? "" : "s"}.`);
      }
    );

    // 5. leaderboard — top N targets by vote count.
    this.server.tool(
      "leaderboard",
      "Get the most-blamed targets: lists targets then counts votes on each, returning the " +
        "top N by count. Work is capped to stay within Worker limits.",
      {
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("How many top targets to return (default 10)."),
      },
      async ({ limit }) => {
        const topN = limit ?? 10;
        // Pull a candidate pool, then cap how many we actually COUNT (subrequest budget).
        const candidates = (await listTargets(LEADERBOARD_COUNT_CAP)).slice(
          0,
          LEADERBOARD_COUNT_CAP
        );
        if (candidates.length === 0) {
          return text("No targets to rank right now.");
        }
        const scored = await Promise.all(
          candidates.map(async (t) => ({ text: t.text, count: await scoreTarget(t.id) }))
        );
        scored.sort((a, b) => b.count - a.count);
        const top = scored.slice(0, topN);
        const lines = top
          .map((t, i) => `${i + 1}. ${t.text} — ${t.count} 💥`)
          .join("\n");
        return text(`Most-blamed (top ${top.length}):\n${lines}`);
      }
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return MyMCP.serve("/mcp", { binding: "MyMCP" }).fetch(request, env, ctx);
    }
    return new Response("blame.today MCP server. Connect an MCP client to /mcp", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
  },
} satisfies ExportedHandler<Env>;
