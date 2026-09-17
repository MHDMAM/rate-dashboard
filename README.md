# Rate Dashboard

A static dashboard tracking gold/silver/platinum spot prices and Malaysian
currency exchange rates from several free, keyless sources, refreshed
automatically every 5 minutes.

## How it works

- `scripts/fetch-data.mjs` — a Node script that pulls data from each source
  below and writes `data/latest.json` + `data/history.json`.
- `.github/workflows/update-data.yml` — a GitHub Actions cron job that runs
  the script every 5 minutes and commits the updated JSON back to the repo.
- `index.html` / `assets/` — a plain static page (no build step) that fetches
  those JSON files and renders the dashboard. Deployable as-is to GitHub
  Pages, Netlify, Vercel, or Cloudflare Pages.

This split means the browser never talks to the source websites directly —
it only reads a same-origin JSON file — so there are no CORS issues and no
server to keep running.

## Data sources

| Data | Source | Notes |
|---|---|---|
| Gold / Silver / Platinum spot (USD/oz) | [gold-api.com](https://gold-api.com/) | Free, no key |
| Gold / Silver spot (cross-check) | [goldprice.org](https://goldprice.org/) | Free, no key; blocked from some cloud IP ranges (Cloudflare bot protection) — dashboard falls back gracefully if it fails |
| General FX mid-market rates | [open.er-api.com](https://www.exchangerate-api.com/) | Free, no key |
| General FX mid-market rates (ECB) | [frankfurter.app](https://www.frankfurter.app/) | Free, no key |
| Malaysian money-changer cash rates | [Merchantrade Asia rateboard](https://rateboard.mtradeasia.com/MY0100141) | Public JSON endpoint used by their own display board |
| Malaysian money-changer cash rates | [My Money Master](http://www.mymoneymaster.com.my/Home/full_rate_board) | HTML table scrape |
| Official MYR exchange rates | [Bank Negara Malaysia](https://www.bnm.gov.my/exchange-rates) | HTML scrape of today's spot rate (`SR`), tried at sessions 1700 → 1200 → 1130 → 0900 (latest published session wins) |
| Retail gold/silver bar prices (MY) | [Aston & Sons](https://www.astonandsons.com.my/product-category/gold-bars/) | HTML scrape of product listings |

`xe.com` was left out: it has no free public API and actively blocks
scraping, so nothing there is reliably automatable without a paid plan.

## Local development

```bash
npm install
npm run fetch-data   # writes data/latest.json and data/history.json
```

Then open `index.html` with any static file server (opening it directly via
`file://` will fail the `fetch()` calls due to browser security).

## Deploying for free — GitHub Pages

1. Create a new GitHub repository and push this project to it.
2. In the repo, go to **Settings → Pages** and set:
   - Source: **Deploy from a branch**
   - Branch: **main**, folder **/ (root)**
3. Go to **Settings → Actions → General → Workflow permissions** and select
   **Read and write permissions** (the scheduled job needs to commit the
   refreshed data files back to the repo).
4. Go to the **Actions** tab and manually run **Update rate data** once, so
   `data/latest.json` is fresh before anyone visits the site.
5. Your dashboard will be live at
   `https://<your-username>.github.io/<repo-name>/` within a minute or two,
   and will keep refreshing itself every 5 minutes via the scheduled
   workflow — no server, no hosting cost.

### Alternatives

The same static `index.html` + `assets/` + `data/` folder also deploys as-is
to **Netlify** or **Vercel** (drag-and-drop or connect the repo) if you'd
rather use those instead of GitHub Pages — you'd just keep using the GitHub
Actions workflow to refresh `data/*.json`, since both platforms build from
the same git repo.

## Changing the refresh schedule

The refresh cadence is set by the `cron` line in
`.github/workflows/update-data.yml`:

```yaml
on:
  schedule:
    - cron: "*/5 0-15 * * *"
```

GitHub Actions cron is five fields — `minute hour day month weekday` — and
**always in UTC**, never your local time. The current schedule runs every 5
minutes (`*/5`), only during UTC hours 0–15 (`0-15`), which is 08:00–23:59
in Malaysia (UTC+8) — i.e. it's paused from 00:00 to 08:00 MYR time to skip
the overnight hours when rates barely move.

To change it:
- Every 15 minutes instead of 5 → `*/15 0-15 * * *`
- Every hour → `0 0-15 * * *`
- Resume the overnight pause (run all day again) → `*/5 * * * *`
- Shift the pause window → convert your desired MYR hours to UTC by
  subtracting 8 (e.g. pause 01:00–09:00 MYR = 17:00–00:59 UTC =
  `*/5 1-16 * * *` for the hours it *should* run).

Note: GitHub caps scheduled workflows at a 5-minute minimum interval, and
during high load across GitHub's infrastructure a schedule can run later
than requested (GitHub's own disclaimer) — so `*/5` is as fast as this gets
and won't always land exactly on the minute.

After editing, commit and push — no need to re-enable anything, GitHub picks
up the new schedule from the file automatically. You can also trigger a run
manually any time from the **Actions** tab → **Update rate data** → **Run
workflow**.

## Notes / limitations

- Rates are **cached snapshots** refreshed on a schedule, not live streaming
  quotes — always confirm with the dealer before transacting.
- Money-changer cash rates (Merchantrade, My Money Master) are quoted by
  denomination in different units (per 1, per 100, per 1,000, per 1,000,000);
  the raw source unit is preserved in the table rather than silently
  rescaled, to avoid misrepresenting a rate.
- If a source's page structure changes, that source's `sourceStatus` entry
  in `data/latest.json` will flip to `ok: false` with an error message, and
  the dashboard keeps showing the last good value for that source instead of
  going blank.
