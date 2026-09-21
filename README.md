# proof-of-greed-site

Public deploy mirror of the private repo `proof-of-greed`: a fan-made on-chain receipt tracker for Maze of Gains (Abstract chain). Not affiliated with Onchain Heroes; not financial advice.

- **Primary deploy:** Cloudflare Pages — https://proofofgreed.pages.dev (`.github/workflows/deploy.yml`, Direct Upload via wrangler-action; does not consume CF git-integration build quota).
- **RU fallback:** GitHub Pages — https://debelyy.github.io/proof-of-greed-site/ (`*.pages.dev` is DNS-blocked by RKN since 05.2024).
- **Data:** `.github/workflows/data.yml` rebuilds `data/*.json` from raw chain logs + playmog public API on a 10-min cron; GitHub throttles schedules, so real cadence is ~4-6 updates/day — freshness timestamps are shown on the site itself.
- **Content source of truth:** `greed.html`; `index.html` is a byte-identical copy kept in sync by the data workflow.
