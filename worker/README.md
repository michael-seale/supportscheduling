# RV Support Scheduling — ICS feed worker

A tiny Cloudflare Worker that turns the shared JSONBin schedule into a live
iCalendar feed. Drop the deployed URL into `ICS_FEED_BASE_URL` near the top of
`index.html` and the app will hand each user a subscription URL their calendar
keeps in sync automatically.

## What it does

```
GET /ics?u=<username>            ->  text/calendar  (just that user's shifts)
GET /ics?all=1                   ->  text/calendar  (everyone's shifts, admin)
GET /api/schedule?start=&end=    ->  application/json — shift records for the
                                     Support Dashboard (one record per
                                     agent × role × hour). See ../support-dashboard
                                     for the consumer.
GET /healthz                     ->  ok
```

The ICS includes every week currently saved in the bin, hour by hour. The JSON
schedule API filters those same hour slots down to a date range and ships them
in `America/New_York` ISO timestamps with the correct DST offset.

### `/api/schedule` response

```json
{
  "timezone": "America/New_York",
  "range": { "start": "2026-05-06", "end": "2026-05-06" },
  "roles": [{ "id": "phone", "label": "Phone", "isCoverage": true }],
  "shifts": [
    {
      "agent_id": "alex",
      "agent_name": "Alex Doe",
      "role_id": "phone",
      "role_label": "Phone",
      "date": "2026-05-06",
      "start_ts": "2026-05-06T09:00:00-04:00",
      "end_ts":   "2026-05-06T10:00:00-04:00"
    }
  ]
}
```

`agent_id` is the scheduler's `username` — the dashboard maps that to a Zendesk
user via its own `mapping.json`.

## Deploy

You need a Cloudflare account (free) and Wrangler installed.

```bash
npm i -g wrangler
wrangler login
cd worker

# 1. Make sure JSONBIN_BIN_ID in wrangler.toml matches the bin used by index.html.
# 2. Stash the JSONBin master key as a Worker secret (read-only access is fine):
wrangler secret put JSONBIN_API_KEY

# 3. (Optional) Require a bearer token on /api/schedule. Use the same value in
#    the dashboard's SCHEDULING_API_TOKEN env var on Render.
wrangler secret put SCHEDULE_API_TOKEN

# 4. Ship it:
wrangler deploy
```

Wrangler prints the deployed URL, e.g.

```
https://supportscheduling-ics.<your-subdomain>.workers.dev
```

Paste that URL (no trailing slash) into `ICS_FEED_BASE_URL` near the top of
`../index.html`, commit, and the app's Calendar export panels will start
showing live `webcal://` subscription URLs.

## Try it locally

```bash
cd worker
wrangler dev
# in another terminal:
curl 'http://127.0.0.1:8787/ics?u=admin'
```

## Security notes

This MVP gates feeds only by `username`, matching the existing app's trust
model (the JSONBin master key is already embedded in the page for an internal
team). If you want stronger gating, add a `calendarToken` field to each user
record and require it as `&token=<token>` here — see the `TODO` block at the
bottom of `ics-feed.js` for what to wire up.

## Cost

Cloudflare Workers free tier covers 100,000 requests/day. Calendar apps refetch
roughly hourly, so a team of 50 people refreshing every hour is ~1,200 hits/day
— well within the free tier.
