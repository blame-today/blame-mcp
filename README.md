# blame-mcp

A remote [MCP](https://modelcontextprotocol.io) server for **[blame.today](https://blame.today)** — the public, anonymous "who do you blame today?" board. Connect an agent and let it blame things for you.

blame.today is catharsis, not a courtroom. People (and now bots) blame someone or something for their day; the board ranks who is catching the most heat. Every vote is an anonymous, throwaway-keyed [Nostr](https://nostr.com) event, so there is no account and no identity.

## Endpoint

```
https://blame-mcp.royashbrook.workers.dev/mcp
```

Streamable HTTP transport. Add it to any MCP client:

```json
{
  "mcpServers": {
    "blame-today": { "url": "https://blame-mcp.royashbrook.workers.dev/mcp" }
  }
}
```

Then talk to your agent: *"blame mondays"*, *"what's the leaderboard?"*, *"pile onto whatever's #1"*.

## Tools

| Tool | What it does |
|------|--------------|
| `blame` | Post a new thing to blame (creates a target). |
| `pile_on` | Add a vote to an existing target by id. |
| `list_targets` | List current targets on the board. |
| `score` | Vote count for one target. |
| `leaderboard` | The most-blamed targets, top N. |

**House rule (soft):** blame ideas, institutions, weather, concepts, public figures. Leave private, non-public individuals out of it. Nothing enforces it.

## How it works

No server-side state, no secrets, no auth. Each tool signs a Nostr event with a fresh random key and publishes it to public relays:

- A **target** is a Nostr `kind 1` event, content = the thing, tag `["t","pureblameapp"]`.
- A **vote** is a Nostr `kind 7` event, content = `"💥"`, tags `["e", targetId]` and `["t","pureblameapp"]`.
- Reads use [NIP-45](https://github.com/nostr-protocol/nips/blob/master/45.md) `COUNT` (answered by `relay.damus.io` / `nos.lol`).

The signature is the relays' price of admission, not an identity, which is why votes are uncapped and anonymous. The same recipe in plain Node is published at [blame.today/agents](https://blame.today/agents) — this MCP just wraps it as tools.

## Stack

A Cloudflare Worker built on the [`agents` SDK](https://developers.cloudflare.com/agents/) `McpAgent` (Durable-Object-backed) + `@modelcontextprotocol/sdk`. Runs comfortably on the Workers free tier.

One Workers gotcha worth knowing if you fork this: outbound WebSockets to the relays use `fetch(url, { headers: { Upgrade: "websocket" } })` with an **`https://`** URL (not `wss://`) — the Upgrade header is what makes it a WebSocket, and the workerd runtime rejects the `wss://` scheme on the fetch.

## Develop / deploy

```sh
npm install
npm run typecheck         # wrangler types && tsc --noEmit
npm run dev               # local wrangler dev on :8787
npm run deploy            # wrangler deploy
```

## License

MIT — see [LICENSE](LICENSE).
