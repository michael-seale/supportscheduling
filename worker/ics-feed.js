// =============================================================================
// RV Support Scheduling — live ICS feed + JSON schedule API (Cloudflare Worker)
//
// Two jobs:
//   1) Convert the JSONBin shared schedule into an iCalendar (.ics) feed that
//      calendar apps can subscribe to.
//   2) Expose a JSON `/api/schedule` endpoint that the Support Dashboard
//      (separate Render service) joins against Zendesk activity data.
//
// ENDPOINTS
//   GET /ics?u=<username>            -> just that user's events
//   GET /ics?all=1                   -> everyone's events (admin)
//   GET /api/schedule?start=&end=    -> JSON shift records (see SHIFT SHAPE)
//   GET /healthz                     -> "ok"
//
// SHIFT SHAPE  (`/api/schedule` response)
//   {
//     "timezone": "America/New_York",
//     "range": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
//     "roles": [{ "id": "phone", "label": "Phone", "isCoverage": true }, ...],
//     "shifts": [
//       {
//         "agent_id": "<username>",          // scheduler's stable id
//         "agent_name": "<displayName>",
//         "role_id": "phone",
//         "role_label": "Phone",
//         "date": "2026-05-06",              // date in TIMEZONE
//         "start_ts": "2026-05-06T09:00:00-04:00",
//         "end_ts":   "2026-05-06T10:00:00-04:00"
//       }, ...
//     ]
//   }
//   One record per (agent, role, hour). The dashboard buckets these directly.
//
// SECURITY
//   /ics endpoints: same model as before — username-in-URL, no auth.
//   /api/schedule: if the worker secret SCHEDULE_API_TOKEN is set, callers must
//   send `Authorization: Bearer <token>` (matches the dashboard's
//   SCHEDULING_API_TOKEN env). If unset, the endpoint is open.
//
// SETUP (one-time)
//   1) npm i -g wrangler
//   2) wrangler login
//   3) From this folder:
//        wrangler secret put JSONBIN_API_KEY      # paste your X-Master-Key
//        wrangler secret put SCHEDULE_API_TOKEN   # OPTIONAL bearer token
//        wrangler deploy                          # uses wrangler.toml
//   4) Note the deployed URL (e.g. https://supportscheduling-ics.<you>.workers.dev)
//   5) Paste that URL into ICS_FEED_BASE_URL near the top of index.html
//      AND into SCHEDULING_API_BASE on the Support Dashboard Render service.
//
// CONFIG
//   The bin ID is read from wrangler.toml `[vars] JSONBIN_BIN_ID`.
//   The API key is a Worker secret (`JSONBIN_API_KEY`).
//   The dashboard bearer token is an optional secret (`SCHEDULE_API_TOKEN`).
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

function buildRunEvent({ assignUser, display, dayYmd, startHour, endHour, role, roleLabel, dtstamp }) {
  const uid = `${ymdToDateKey(dayYmd)}-${startHour}-${safeFilenamePart(assignUser)}-${safeFilenamePart(role)}@rv-support-scheduling`;
  const summary = `${roleLabel} — ${display}`;
  const description = `${roleLabel} shift (${formatHourLabel(startHour)}–${formatHourLabel(endHour + 1)} ET)`;
  return [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;TZID=${ICS_TZID}:${icsLocalStamp(dayYmd.y, dayYmd.m, dayYmd.d, startHour)}`,
    `DTEND;TZID=${ICS_TZID}:${icsLocalStamp(dayYmd.y, dayYmd.m, dayYmd.d, endHour + 1)}`,
    icsFold(`SUMMARY:${icsEscape(summary)}`),
    icsFold(`DESCRIPTION:${icsEscape(description)}`),
    "TRANSP:OPAQUE",
    "END:VEVENT",
  ].join("\r\n");
}

// Same-role consecutive hours for the same user collapse into one VEVENT.
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
      const dayYmd = addDays(weekStart, dayIndex);
      const buckets = new Map();
      Object.keys(dayMap).forEach(hourStr => {
        const hour = Number(hourStr);
        if (!Number.isFinite(hour)) return;
        (dayMap[hourStr] || []).forEach(a => {
          if (!a || !a.username) return;
          if (username && a.username.toLowerCase() !== username.toLowerCase()) return;
          const key = `${a.username.toLowerCase()}|${a.role || ""}`;
          let b = buckets.get(key);
          if (!b) { b = { username: a.username, role: a.role || "", hours: new Set() }; buckets.set(key, b); }
          b.hours.add(hour);
        });
      });
      buckets.forEach(b => {
        const sorted = Array.from(b.hours).sort((x, y) => x - y);
        if (sorted.length === 0) return;
        const u = userByName[b.username.toLowerCase()];
        const r = roleById[b.role];
        const display = u ? (u.displayName || u.username) : b.username;
        const roleLabel = r ? r.label : b.role;
        let runStart = sorted[0], runEnd = sorted[0];
        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i] === runEnd + 1) {
            runEnd = sorted[i];
          } else {
            events.push(buildRunEvent({ assignUser: b.username, display, dayYmd, startHour: runStart, endHour: runEnd, role: b.role, roleLabel, dtstamp }));
            runStart = sorted[i]; runEnd = sorted[i];
          }
        }
        events.push(buildRunEvent({ assignUser: b.username, display, dayYmd, startHour: runStart, endHour: runEnd, role: b.role, roleLabel, dtstamp }));
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
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

// ---------------------------------------------------------------------------
// /api/schedule helpers
// ---------------------------------------------------------------------------

// True if `ymd` falls within [start, end] inclusive (both {y,m,d}).
function ymdInRange(ymd, start, end) {
  const cmp = (a, b) => (a.y - b.y) || (a.m - b.m) || (a.d - b.d);
  return cmp(ymd, start) >= 0 && cmp(ymd, end) <= 0;
}

// Returns the offset string ("-04:00" / "-05:00") for America/New_York at the
// given local wall-clock instant. We don't have Intl.DateTimeFormat with
// fractional offsets readily available in Workers, so derive from the standard
// US DST rules: 2nd Sun of March 02:00 -> EDT (-04:00), 1st Sun of November
// 02:00 -> EST (-05:00). Good enough for the support dashboard's hour grid.
function nyOffsetForLocal(y, m, d, hour) {
  // Find DST start (2nd Sunday of March 02:00 local) and end (1st Sunday of
  // November 02:00 local) for this year.
  function nthSunday(year, month, n) {
    // month is 1-based
    const first = new Date(Date.UTC(year, month - 1, 1));
    const firstDow = first.getUTCDay(); // 0..6 (Sun..Sat)
    const offset = (7 - firstDow) % 7; // days to first Sunday
    return 1 + offset + (n - 1) * 7;
  }
  const dstStartDay = nthSunday(y, 3, 2);   // 2nd Sunday of March
  const dstEndDay = nthSunday(y, 11, 1);    // 1st Sunday of November
  // Convert "this local instant" to a comparable tuple.
  const t = (mm, dd, hh) => mm * 10000 + dd * 100 + hh;
  const cur = t(m, d, hour);
  const start = t(3, dstStartDay, 2);
  const end = t(11, dstEndDay, 2);
  const inDst = cur >= start && cur < end;
  return inDst ? "-04:00" : "-05:00";
}

function isoLocalWithOffset(y, m, d, hour) {
  const off = nyOffsetForLocal(y, m, d, hour);
  return `${y}-${pad2(m)}-${pad2(d)}T${pad2(hour)}:00:00${off}`;
}

function buildScheduleResponse({ users, roles, schedule, startKey, endKey }) {
  const userByName = {};
  users.forEach(u => { if (u && u.username) userByName[u.username.toLowerCase()] = u; });
  const roleById = {};
  roles.forEach(r => { if (r && r.id) roleById[r.id] = r; });

  const start = parseDateKey(startKey);
  const end = parseDateKey(endKey);

  const shifts = [];
  Object.keys(schedule).forEach(weekKey => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekKey)) return;
    const weekStart = parseDateKey(weekKey);
    const week = schedule[weekKey] || {};
    DAYS.forEach((d, dayIndex) => {
      const dayMap = week[d.id] || {};
      const dayYmd = addDays(weekStart, dayIndex);
      if (!ymdInRange(dayYmd, start, end)) return;
      const dateKey = ymdToDateKey(dayYmd);
      Object.keys(dayMap).forEach(hourStr => {
        const hour = Number(hourStr);
        if (!Number.isFinite(hour) || hour < 0 || hour > 23) return;
        (dayMap[hourStr] || []).forEach(a => {
          if (!a || !a.username || !a.role) return;
          const u = userByName[a.username.toLowerCase()];
          const r = roleById[a.role];
          shifts.push({
            agent_id: a.username,
            agent_name: u ? (u.displayName || u.username) : a.username,
            role_id: a.role,
            role_label: r ? r.label : a.role,
            date: dateKey,
            start_ts: isoLocalWithOffset(dayYmd.y, dayYmd.m, dayYmd.d, hour),
            end_ts: isoLocalWithOffset(dayYmd.y, dayYmd.m, dayYmd.d, hour + 1),
          });
        });
      });
    });
  });

  // Stable ordering: by start_ts, then agent, then role.
  shifts.sort((a, b) => {
    if (a.start_ts !== b.start_ts) return a.start_ts < b.start_ts ? -1 : 1;
    if (a.agent_id !== b.agent_id) return a.agent_id < b.agent_id ? -1 : 1;
    return a.role_id < b.role_id ? -1 : a.role_id > b.role_id ? 1 : 0;
  });

  return {
    timezone: ICS_TZID,
    range: { start: startKey, end: endKey },
    roles: roles.map(r => ({
      id: r.id,
      label: r.label,
      isCoverage: !!r.isCoverage,
    })),
    shifts,
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

    // ---- /api/schedule (JSON) ---------------------------------------------
    if (url.pathname === "/api/schedule") {
      if (!env.JSONBIN_BIN_ID || !env.JSONBIN_API_KEY) {
        return jsonError(500, "Missing JSONBIN_BIN_ID or JSONBIN_API_KEY");
      }
      // Optional bearer auth.
      if (env.SCHEDULE_API_TOKEN) {
        const authz = request.headers.get("authorization") || "";
        const expected = `Bearer ${env.SCHEDULE_API_TOKEN}`;
        if (authz !== expected) return jsonError(401, "Unauthorized");
      }
      const startKey = url.searchParams.get("start");
      const endKey = url.searchParams.get("end") || startKey;
      if (!startKey || !/^\d{4}-\d{2}-\d{2}$/.test(startKey) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(endKey)) {
        return jsonError(400, "start (YYYY-MM-DD) is required; end is optional and must also be YYYY-MM-DD");
      }
      let bin;
      try {
        bin = await fetchBin(env);
      } catch (e) {
        return jsonError(502, `Upstream error: ${e.message}`);
      }
      const body = buildScheduleResponse({
        users: bin.users,
        roles: bin.roles,
        schedule: bin.schedule,
        startKey,
        endKey,
      });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          ...corsHeaders(),
        },
      });
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

    // No Content-Disposition: subscription clients (Apple Calendar especially)
    // can mistake a `filename` hint for a one-shot download and refuse to
    // subscribe. text/calendar alone is the standard signal.
    return new Response(ics, {
      status: 200,
      headers: {
        "content-type": "text/calendar; charset=utf-8",
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
