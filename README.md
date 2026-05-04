# supportscheduling

App for RV Support Scheduling.

## Calendar export

Each signed-in user has a **Send to calendar** button that downloads a `.ics`
file of all of their assigned shifts. Admins get a dedicated **Calendar** tab
that can download per-user, per-everyone, or hand out live subscription URLs.

Live `webcal://` subscription URLs need a small server endpoint (a free
Cloudflare Worker) — see [`worker/README.md`](worker/README.md) for one-time
setup. Once deployed, paste the worker URL into `ICS_FEED_BASE_URL` near the
top of `index.html` and the subscription URLs become available throughout the
app.

Without the worker the `.ics` download still works.
