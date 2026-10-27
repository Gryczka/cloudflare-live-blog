# Live Blog guardrails and deployment readiness

## Required existing-blog migration

The additive `v2-directory` migration creates SQLite `BlogDirectory` and requires binding `BLOG_DIRECTORY`. API, reader, author, permalink and RSS share one gated resolver before obtaining a LIVE_BLOG stub. New creation reserves its global allowance before accessing a new actor, and checks for a verified existing legacy name collision first.

`LEGACY_BLOG_OBJECT_IDS` is a JSON array of verified existing namespace Durable Object hash IDs (64 lowercase hexadecimal characters, maximum 1000 entries). The operator supplies this finite control-plane allowlist from the **existing LiveBlog namespace's objects API**, with all pages fetched and only `hasStoredData` actors retained. Hashes must belong to this account/namespace. This needs no enumerable plaintext slugs, post/user-data enumeration, or author-secret reads. The tracked `wrangler.jsonc` keeps both manifests `[]`, which is correct for a fresh deployment. The hosted garden keeps its verified inventory in an untracked production config selected with `GARDEN_PRODUCTION_PREFLIGHT=1`. Staging configurations must also keep both manifests `[]`: production hashes must never be copied into a staging namespace.

For a syntactically valid public blog ID, the shared resolver computes `LIVE_BLOG.idFromName(blogId).toString()` locally (this project calls the namespace binding `LIVE_BLOG`, not `BLOGS`). Before any unknown-name actor dispatch, that hash must match the allowlist. Only then may `get()`/RPC probe the **already-existing** actor. `getPublicMetadata()` reads only public identity/status and expiry bookkeeping, without schema initialization, content, token hashes, or alarm writes. Only matching, real, nonexpired blogs enter the directory; empty actors return 404, expired metadata returns 410 (public lookup returns 404), and mismatches are rejected. Arbitrary names never reach the blog namespace. Approved new creation remains separately budget-gated.

`LEGACY_BLOG_IDS` remains an optional JSON array of at most 50 verified plaintext public names. It authorizes the same read-only metadata validation, not blind directory insertion. An empty name manifest is safe when the hash manifest is populated. Keep the hash manifest while legacy actors remain: import is lazy when an existing public URL is requested, and valid actors can be rediscovered after a stale directory entry expires. Unknown slugs cannot be derived from hashes, so the sitemap gains legacy URLs as they are safely resolved rather than hiding their reader/author/permalink/RSS routes.

Legacy imports do not consume hourly new-creation allowance or get refused by the new-admission active cap. The finite legacy allowance is 1050 directory entries (1000 hashes plus 50 optional names); legacy entries do count against new creation capacity. A configuration exceeding the manifest bounds fails closed rather than being silently truncated. No data is copied between namespaces and no actor is promoted to a new owner.

The operator must also preflight the serialized variable against the Workers **5 KB per-variable deployment limit**. The parser's 1000-entry safety bound does not raise that platform limit. Never truncate a verified inventory to make it fit; a larger inventory needs a supported manifest-delivery change before rollout.

## Budgets and lifecycle

| Variable | Default | Maximum allowed |
| --- | ---: | ---: |
| NEW_BLOGS_PER_HOUR | 5 | 100 |
| MAX_ACTIVE_BLOGS | 50 | 100 |
| MAX_RETAINED_POSTS | 5000 | 5000 |
| MAX_BLOG_SOCKETS | 100 | 1000 |

The singleton serializes admitted new-blog counts across locations; existing per-location CREATE_LIMITER (5/minute) and WRITE_LIMITER (30/minute) remain cheap filters. Missing settings use defaults, malformed/out-of-range settings fail closed. The post cap counts every retained row, including deleted tombstones; deletion also clears markdown and HTML. Shared limits remain 4000 characters/post, 80/byline, 140/title, 280/summary, 12 pins, 50-post pages and 200-post replay. Request JSON is streamed with a 32 KiB byte cap; arrays are rejected.

**New blogs only** receive the `lifetime_policy=absolute-v1` metadata marker and a 30-day absolute lifetime in addition to inactivity expiry. Existing actors have no marker and retain their original 30-day sliding inactivity policy, regardless of creation age or live/ended status. Migration does not change metadata, expiry policy, or the existing actor alarm. Public reads do not extend retention; successful legacy writes refresh the directory deadline to match the actor's inactivity deadline. Ended archives/history/permalinks/RSS remain readable until their original inactivity expiry, even when created over 30 days ago. Ending closes live sockets and refuses archive socket upgrades; readers stop pings/reconnects.

Expiry closes readers and calls `deleteAll()` without recreating schema or scheduling another daily alarm. The unchanged compatibility date `2026-07-01` is later than `2026-02-24`, so `deleteAll()` atomically removes SQLite contents **and the alarm**. Subsequent reads/cleanup see absent tables and return cleanly without allocation. Reader sockets require same Origin and accept only runtime literal ping auto-response. Limits bound admitted state/work, not every inbound request or a dollar spend ceiling.

## Checks and future deployment

After a failed/disconnected reader socket (including an ended blog's 409 upgrade response), the island requests the authoritative public snapshot with no-store rather than retrying from stale HTML indefinitely. It replaces the canonical first page, reconciles edited/deleted posts and the pinned rail, updates metadata/cursor and history controls, then stops pings/retries when ended. A single in-flight recovery and the finite reconnect budget bound failures; missing/expired coverage stops retries. Public archives and Load earlier posts remain available.

```sh
npm run cf-typegen
npm run check
npm test
npm run build
npm run budget
npx --no-install wrangler deploy --dry-run
npm run deploy
```

No new secret or additional DO migration is needed beyond `v2-directory`. Keep `LIVE_BLOG`, `WRITE_LIMITER`, `CREATE_LIMITER` and `ASSETS`; do not rename/recreate the existing namespace. The directory handles its additive SQL column internally. The custom entrypoint is bundled via Astro's generated deployment config; never deploy raw source with framework virtual imports unresolved. The reader JS budget stays 32 KB raw/12 KB gzip. Runtime regressions cover hash-only imports, no unknown dispatch, invalid/empty/expired/mismatched actors, optional names, old archives, stale directory expiry, and cleanup without re-creation.

Canonical site: `https://cloudflare-live-blog.dwarven.workers.dev`. The dynamic sitemap includes public reader/archive IDs, never author or API actions. Real robots excludes those private/action surfaces while allowing readers, archives, permalinks and RSS. Content Signals allow search/AI input and decline training; these are crawler guidance, not authorization.
