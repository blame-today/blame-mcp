// The blame.today Nostr layer for the Workers runtime.
//
// This mirrors the wire protocol the live web app speaks (see ../../src/lib/nostr.ts and
// crypto.ts in the parent repo), but adapted for Cloudflare Workers: the browser `WebSocket`
// global cannot make OUTBOUND connections in Workers, so we open relay sockets via
// `fetch(url, { headers: { Upgrade: "websocket" } })` then `resp.webSocket.accept()`.
//
// VERIFIED protocol shape (do not change): TAG = "pureblameapp", kind 1 = a blame target
// (content = the thing being blamed), kind 7 = a vote (content = "💥", e-tag = target id).
// Every event is signed with a throwaway random key — the signature is the relays' price of
// admission, not identity. Reads use NIP-45 COUNT, which only damus + nos.lol answer reliably.

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.snort.social",
  "wss://nostr.mom",
  "wss://relay.nostr.net",
] as const;

// All our relays answer NIP-45 COUNT, but their counts DIVERGE: relay.damus.io is often a
// degraded/partial view (e.g. 66 votes for a target the other four all report ~1319). The web
// board reconciles this by MAX-merging COUNT across every relay (store.svelte.ts onCount), so a
// single target's score is the highest count any relay reports. We mirror that here.
//
// For a single score() we COUNT all relays and take the max (accurate, 5 subrequests). For the
// leaderboard we can't afford 5x per target under the 50-subrequest/invocation free-tier cap, so
// we COUNT each candidate on the "rich" relays only (damus excluded as the known laggard) and
// take the first answer — which matches the board because those four agree closely.
export const RANK_RELAYS = [
  "wss://nos.lol",
  "wss://nostr.mom",
  "wss://relay.nostr.net",
  "wss://relay.snort.social",
] as const;

export const TAG = "pureblameapp";

export type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
  tags: string[][];
  sig: string;
};

export type Target = { id: string; text: string };

const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// VERIFIED signing — ported exactly. Serialize the NIP-01 array, sha256 it, then sign the RAW
// 32 hash BYTES (not the hex string). @noble/curves v2 schnorr.sign wants bytes.
export function signEvent(
  kind: number,
  content: string,
  tags: string[][]
): NostrEvent {
  const sk = schnorr.utils.randomSecretKey();
  const pubkey = toHex(schnorr.getPublicKey(sk));
  const created_at = Math.floor(Date.now() / 1000);
  const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
  const hash = sha256(new TextEncoder().encode(serialized));
  const id = toHex(hash);
  const sig = toHex(schnorr.sign(hash, sk)); // sign the raw hash BYTES
  return { id, pubkey, created_at, kind, content, tags, sig };
}

export const signTarget = (text: string): NostrEvent =>
  signEvent(1, text, [["t", TAG]]);

export const signVote = (targetId: string): NostrEvent =>
  signEvent(7, "💥", [["e", targetId], ["t", TAG]]);

// Open an outbound WebSocket to a relay using the Workers runtime upgrade pattern.
// Returns the accepted, ready-to-use WebSocket or throws.
async function openRelay(url: string): Promise<WebSocket> {
  // Workers requires fetch() with an Upgrade header for outbound WS, and the fetch URL must use
  // the http(s) scheme (NOT ws/wss) — the Upgrade header is what makes it a WebSocket.
  const httpUrl = url.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
  const resp = await fetch(httpUrl, { headers: { Upgrade: "websocket" } });
  const ws = resp.webSocket;
  if (!ws) {
    throw new Error(`relay ${url} did not return a WebSocket (status ${resp.status})`);
  }
  ws.accept();
  return ws;
}

const parse = (data: unknown): unknown[] | null => {
  try {
    const p = JSON.parse(typeof data === "string" ? data : String(data));
    return Array.isArray(p) ? p : null;
  } catch {
    return null;
  }
};

const safeClose = (ws: WebSocket): void => {
  try {
    ws.close();
  } catch {
    /* already closed */
  }
};

// Publish a signed event to one relay; resolve true on ["OK", id, true], false on timeout/reject.
function publishToRelay(
  url: string,
  ev: NostrEvent,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean, ws?: WebSocket) => {
      if (done) return;
      done = true;
      if (ws) safeClose(ws);
      resolve(v);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    openRelay(url)
      .then((ws) => {
        ws.addEventListener("message", (m: MessageEvent) => {
          const p = parse(m.data);
          if (p && p[0] === "OK" && p[1] === ev.id) {
            clearTimeout(timer);
            finish(p[2] === true, ws);
          }
        });
        ws.addEventListener("close", () => {
          clearTimeout(timer);
          finish(false);
        });
        ws.addEventListener("error", () => {
          clearTimeout(timer);
          finish(false, ws);
        });
        try {
          ws.send(JSON.stringify(["EVENT", ev]));
        } catch {
          clearTimeout(timer);
          finish(false, ws);
        }
      })
      .catch(() => {
        clearTimeout(timer);
        finish(false);
      });
  });
}

// Fan a signed event out to all relays best-effort; resolve true as soon as ANY relay returns
// OK true, or false after the overall timeout. Stragglers keep going but are ignored.
export async function publishEvent(
  ev: NostrEvent,
  timeoutMs = 4000
): Promise<boolean> {
  const attempts = RELAYS.map((url) => publishToRelay(url, ev, timeoutMs));
  return new Promise((resolve) => {
    let remaining = attempts.length;
    let settled = false;
    const overall = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, timeoutMs + 250);
    for (const a of attempts) {
      a.then((ok) => {
        remaining--;
        if (ok && !settled) {
          settled = true;
          clearTimeout(overall);
          resolve(true);
        } else if (remaining === 0 && !settled) {
          settled = true;
          clearTimeout(overall);
          resolve(false);
        }
      });
    }
  });
}

// List current blame targets from one relay via REQ, collecting EVENT frames until EOSE.
// Returns deduped targets (newest-relay-wins by id). One relay is enough for a listing.
async function listFromRelay(
  url: string,
  limit: number,
  timeoutMs: number
): Promise<Target[]> {
  return new Promise((resolve) => {
    const subId = "ls";
    const out: Target[] = [];
    const seen = new Set<string>();
    let done = false;
    const finish = (ws?: WebSocket) => {
      if (done) return;
      done = true;
      if (ws) safeClose(ws);
      resolve(out);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    openRelay(url)
      .then((ws) => {
        ws.addEventListener("message", (m: MessageEvent) => {
          const p = parse(m.data);
          if (!p) return;
          if (p[0] === "EVENT" && p[1] === subId) {
            const e = p[2] as NostrEvent | undefined;
            if (e && e.id && !seen.has(e.id)) {
              seen.add(e.id);
              out.push({ id: e.id, text: e.content || "" });
            }
          } else if (p[0] === "EOSE" && p[1] === subId) {
            clearTimeout(timer);
            finish(ws);
          }
        });
        ws.addEventListener("close", () => {
          clearTimeout(timer);
          finish();
        });
        ws.addEventListener("error", () => {
          clearTimeout(timer);
          finish(ws);
        });
        try {
          ws.send(
            JSON.stringify(["REQ", subId, { kinds: [1], "#t": [TAG], limit }])
          );
        } catch {
          clearTimeout(timer);
          finish(ws);
        }
      })
      .catch(() => {
        clearTimeout(timer);
        finish();
      });
  });
}

// List targets as the UNION across all relays, deduped by id — no single relay (especially the
// degraded damus) has the full set, so we merge them. Each relay is capped at `limit`; the merged
// result is sliced to `limit`.
export async function listTargets(limit = 50, timeoutMs = 4000): Promise<Target[]> {
  const perRelay = await Promise.all(
    RELAYS.map((url) => listFromRelay(url, limit, timeoutMs))
  );
  const seen = new Set<string>();
  const merged: Target[] = [];
  for (const list of perRelay) {
    for (const t of list) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        merged.push(t);
      }
    }
  }
  return merged.slice(0, limit);
}

// COUNT votes (kind 7) on a target via NIP-45, trying COUNT-capable relays until one answers.
async function countFromRelay(
  url: string,
  targetId: string,
  timeoutMs: number
): Promise<number | null> {
  return new Promise((resolve) => {
    const subId = "ct";
    let done = false;
    const finish = (v: number | null, ws?: WebSocket) => {
      if (done) return;
      done = true;
      if (ws) safeClose(ws);
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    openRelay(url)
      .then((ws) => {
        ws.addEventListener("message", (m: MessageEvent) => {
          const p = parse(m.data);
          if (!p) return;
          if (p[0] === "COUNT" && p[1] === subId) {
            const meta = p[2] as { count?: number } | undefined;
            clearTimeout(timer);
            finish(meta && typeof meta.count === "number" ? meta.count : null, ws);
          }
        });
        ws.addEventListener("close", () => {
          clearTimeout(timer);
          finish(null);
        });
        ws.addEventListener("error", () => {
          clearTimeout(timer);
          finish(null, ws);
        });
        try {
          ws.send(
            JSON.stringify([
              "COUNT",
              subId,
              { kinds: [7], "#e": [targetId], "#t": [TAG] },
            ])
          );
        } catch {
          clearTimeout(timer);
          finish(null, ws);
        }
      })
      .catch(() => {
        clearTimeout(timer);
        finish(null);
      });
  });
}

// Vote count for ONE target — the accurate path. COUNT every relay in parallel and take the
// max, mirroring the web board's max-merge (relays diverge; the highest is the truth). 5
// subrequests; only used for single score() lookups, not the leaderboard.
export async function scoreTarget(targetId: string, timeoutMs = 4000): Promise<number> {
  const counts = await Promise.all(
    RELAYS.map((url) => countFromRelay(url, targetId, timeoutMs))
  );
  return counts.reduce<number>((max, n) => (n !== null && n > max ? n : max), 0);
}

// Cheaper count for the leaderboard: ONE COUNT against a single rich relay (the first RANK relay,
// nos.lol — damus excluded as the laggard). Exactly one subrequest per target and NO retry, so
// the leaderboard's budget is hard-bounded (list-union ~5 + N candidates). The rich relays agree,
// so this matches the board; if that one relay is briefly down a leaderboard run just reads low.
export async function scoreForRank(targetId: string, timeoutMs = 4000): Promise<number> {
  const n = await countFromRelay(RANK_RELAYS[0], targetId, timeoutMs);
  return n ?? 0;
}
