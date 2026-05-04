// =============================================================================
// RV Support Scheduling — live ICS feed (Cloudflare Worker)
//
// Converts the JSONBin shared schedule into an iCalendar (.ics) feed that
// calendar apps can subscribe to. Re-fetched periodically by Google Calendar,
// Apple Calendar, Outlook, etc. — so when the admin updates the schedule, the
// shifts on each person's calendar update automatically.
//
// ENDPOINTS
//   GET /ics?u=<username>     -> just that user's events
//   GET /ics?all=1            -> everyone's events (admin)
//   GET /healthz              -> "ok"
//
// SECURITY
//   The username is the only thing in the URL; anyone who guesses or sees a
//   teammate's URL can read their schedule. That matches the existing app's
//   trust model (the JSONBin master key is already embedded in the page).
//   To harden this later, mint a random `calendarToken` per user, store it on
//   the user record, and require ?token=<token> here. See TODO at bottom.
//
// SETUP (one-time)
//   1) npm i -g wrangler
//   2) wrangler login
//   3) From this folder:
//        wrangler secret put JSONBIN_API_KEY      # paste your X-Master-Key
//        wrangler deploy                          # uses wrangler.toml
//   4) Note the deployed URL (e.g. https://supportscheduling-ics.<you>.workers.dev)
//   5) Paste that URL into ICS_FEED_BASE_URL near the top of index.html.
//
// CONFIG
//   The bin ID is read from wrangler.toml `[vars] JSONBIN_BIN_ID`.
//   The API key is a Worker secret (`JSONBIN_API_KEY`).
// =============================================================================

const JSONBIN_BASE = "https://api.jsonbin.io/v3/b";
const ICS_TZID = "America/New_York";

const DAYS = [
  { id: "mon", label: "Monday" },
  { id: "tue", label: "Tuesday" },
  { id: "wed", label: "Wednesday" },
  { id: "thu", label: "Thursday" },
  { id: "fri", label: "Friday" },
];

const ICS_VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "X-LIC-LOCATION:America/New_York",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "TZNAME:EDT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:EST",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
].join("\r\n");

function pad2(n) { return String(n).padStart(2, "0"); }

function icsEscape(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}
function icsFold(line) {
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  let s = line.slice(75);
  while (s.length > 74) { parts.push(" " + s.slice(0, 74)); s = s.slice(74); }
  if (s.length > 0) parts.push(" " + s);
  return parts.join("\r\n");
}
function safeFilenamePart(s) {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}
function icsLocalStamp(y, m, d, hour) {
  return `${y}${pad2(m)}${pad2(d)}T${pad2(hour)}0000`;
}
function icsUtcStamp(date) {
  return [
    date.getUTCFullYear(),
    pad2(date.getUTCMonth() + 1),
    pad2(date.getUTCDate()),
    "T",
    pad2(date.getUTCHours()),
    pad2(date.getUTCMinutes()),
    pad2(date.getUTCSeconds()),
    "Z",
  ].join("");
}

function parseDateKey(s) {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
}
// Add `days` to a {y,m,d} via the standard Date object (handles month rollover).
function addDays(ymd, days) {
  const dt = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
function ymdToDateKey(ymd) {
  return `${ymd.y}-${pad2(ymd.m)}-${pad2(ymd.d)}`;
}

function formatHourLabel(h) {
  const suffix = h >= 12 ? "pm" : "am";
  const disp = ((h + 11) % 12) + 1;
  return `${disp}${suffix}`;
}

async function fetchBin(env) {
  const res = await fetch(`${JSONBIN_BASE}/${env.JSONBIN_BIN_ID}/latest`, {
    method: "GET",
    headers: { "X-Master-Key": env.JSONBIN_API_KEY },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!res.ok) throw new Error(`JSONBin fetch failed: ${res.status}`);
  const data = await res.json();
  const record = data.record || {};
  return {
    users: Array.isArray(record.users) ? record.users : [],
    roles: Array.isArray(record.roles) ? record.roles : [],
    schedule: (record.schedule && typeof record.schedule === "object") ? record.schedule : {},
  };
}

function buildIcs({ users, roles, schedule, username, calendarName }) {
  const dtstamp = icsUtcStamp(new Date());
  const userByName = {};
  users.forEach(u => { if (u && u.username) userByName[u.username.toLowerCase()] = u; });
  const roleById = {};
  roles.forEach(r => { if (r && r.id) roleById[r.id] = r; });

  const events = [];
  Object.keys(schedule).forEach(weekKey => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekKey)) return;
    const weekStart = parseDateKey(weekKey);
    const week = schedule[weekKey] || {};
    DAYS.forEach((d, dayIndex) => {
      const dayMap = week[d.id] || {};
      Object.keys(dayMap).forEach(hourStr => {
        const hour = Number(hourStr);
        if (!Number.isFinite(hour)) return;
        const assigns = dayMap[hourStr] || [];
        const dayYmd = addDays(weekStart, dayIndex);
        assigns.forEach(a => {
          if (!a || !a.username) return;
          if (username && a.username.toLowerCase() !== username.toLowerCase()) return;
          const u = userByName[a.username.toLowerCase()];
          const r = roleById[a.role];
          const display = u ? (u.displayName || u.username) : a.username;
          const roleLabel = r ? r.label : a.role;
          const uid = `${ymdToDateKey(dayYmd)}-${hour}-${safeFilenamePart(a.username)}-${safeFilenamePart(a.role)}@rv-support-scheduling`;
          const summary = `${roleLabel} — ${display}`;
          const description = `${roleLabel} shift (${formatHourLabel(hour)}–${formatHourLabel(hour + 1)} ET)`;
          events.push([
            "BEGIN:VEVENT",
            `UID:${uid}`,
            `DTSTAMP:${dtstamp}`,
            `DTSTART;TZID=${ICS_TZID}:${icsLocalStamp(dayYmd.y, dayYmd.m, dayYmd.d, hour)}`,
            `DTEND;TZID=${ICS_TZID}:${icsLocalStamp(dayYmd.y, dayYmd.m, dayYmd.d, hour + 1)}`,
            icsFold(`SUMMARY:${icsEscape(summary)}`),
            icsFold(`DESCRIPTION:${icsEscape(description)}`),
            "TRANSP:OPAQUE",
            "END:VEVENT",
          ].join("\r\n"));
        });
      });
    });
  });

  const body = [
    "BEGIN:VCALENDAR",
    "PRODID:-//RenewedVision//Support Scheduling//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    icsFold(`X-WR-CALNAME:${icsEscape(calendarName || "RV Support Schedule")}`),
    `X-WR-TIMEZONE:${ICS_TZID}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    ICS_VTIMEZONE,
  ];
  events.forEach(e => body.push(e));
  body.push("END:VCALENDAR", "");
  return body.join("\r\n");
}

function corsHeaders() {
  // Calendar clients fetch directly; CORS is mostly only relevant if you ever
  // load a feed from a browser fetch. Permissive read-only is fine here.
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (url.pathname === "/healthz") {
      return new Response("ok", { headers: { "content-type": "text/plain", ...corsHeaders() } });
    }
    if (url.pathname !== "/ics" && url.pathname !== "/") {
      return new Response("Not found", { status: 404, headers: corsHeaders() });
    }

    if (!env.JSONBIN_BIN_ID || !env.JSONBIN_API_KEY) {
      return new Response("Missing JSONBIN_BIN_ID or JSONBIN_API_KEY", {
        status: 500,
        headers: { "content-type": "text/plain", ...corsHeaders() },
      });
    }

    const username = url.searchParams.get("u");
    const all = url.searchParams.get("all") === "1";
    if (!username && !all) {
      return new Response("Missing ?u=<username> or ?all=1", {
        status: 400,
        headers: { "content-type": "text/plain", ...corsHeaders() },
      });
    }

    let bin;
    try {
      bin = await fetchBin(env);
    } catch (e) {
      return new Response(`Upstream error: ${e.message}`, {
        status: 502,
        headers: { "content-type": "text/plain", ...corsHeaders() },
      });
    }

    if (username) {
      const exists = bin.users.some(u => u.username && u.username.toLowerCase() === username.toLowerCase());
      if (!exists) {
        return new Response("Unknown user", { status: 404, headers: { "content-type": "text/plain", ...corsHeaders() } });
      }
    }

    const u = username
      ? bin.users.find(x => x.username && x.username.toLowerCase() === username.toLowerCase())
      : null;
    const calendarName = all
      ? "RV Support — Everyone"
      : `RV Support — ${u ? (u.displayName || u.username) : username}`;

    const ics = buildIcs({
      users: bin.users,
      roles: bin.roles,
      schedule: bin.schedule,
      username: all ? undefined : username,
      calendarName,
    });

    const filename = all ? "rv-support-everyone.ics" : `rv-support-${safeFilenamePart(username)}.ics`;
    return new Response(ics, {
      status: 200,
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": `inline; filename="${filename}"`,
        // Calendar clients respect this hint when deciding how often to refetch.
        "cache-control": "public, max-age=300",
        ...corsHeaders(),
      },
    });
  },
};

// TODO (token gating, optional):
//   - Add a `calendarToken` field to each user record (a 16-byte random hex).
//   - In index.html, show subscription URLs as `.../ics?u=<user>&token=<token>`.
//   - Here, look up the user by `u`, compare its `calendarToken` to `token`,
//     and 403 on mismatch. Rotating the token revokes any previously shared URL.
