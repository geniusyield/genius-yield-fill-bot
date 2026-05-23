# Deploy your GeniusYield arb bot

Pick a host. Each option deploys the same Docker image
(`ghcr.io/geniusyield/arb-bot:latest`) — they differ only in cost, setup
friction, and ops model.

| Option | One-click | Monthly cost (est) | Best for |
|---|---|---|---|
| [Railway](#railway) | ✅ | $5–10 | Most users — best UX, free trial |
| [Fly.io](#flyio) | CLI | $0–5 | Cheapest, requires one-time CLI install |
| [DigitalOcean App Platform](#digitalocean) | ✅ | $5+ | Established + simple UI |
| [Self-hosted Docker](#self-hosted-docker) | manual | bring your own | Power users, home servers |

---

## Required environment variables

Every host needs the same env vars:

| Variable | Example | Description |
|---|---|---|
| `NETWORK` | `Mainnet` | Cardano network |
| `GY_API_URL` | `https://api.prod.geniusyield.co` | GY backend base URL |
| `BASE_ASSET_ID` | `asset1lgultx63fukjlhsncmwp235pcnh4fh988phh7f` | Base asset of pair (e.g. NMKR) |
| `QUOTE_ASSET_ID` | `asset1xdz4yj4ldwlpsz2yjgjtt9evg9uskm8jrzjwhj` | Quote asset (usually ADA) |
| `WALLET_SEED` | `abandon abandon …` | **Your bot's wallet seed phrase** |
| `BLOCKFROST_API_KEY` | `mainnetXXX` | Get free key at [blockfrost.io](https://blockfrost.io) |
| `AMM_SOURCE` | `dexhunter` | Use `mock` only for testing |
| `DEXHUNTER_API_KEY` | `XXX` | Get from [DexHunter Partners](https://dexhunter.gitbook.io/dexhunter-partners) |
| `MIN_PROFIT_BPS` | `50` | Minimum profit in basis points (50 = 0.5%) |
| `MAX_FILL_BASE` | `200000000` | Maximum single-fill size in base asset's indivisible units |
| `POLL_INTERVAL_MS` | `8000` | How often to scan for opportunities |
| `DRY_RUN` | `false` | Set `true` to log without submitting |

**`WALLET_SEED` is sensitive.** Treat it like a password. Most hosts encrypt
env vars at rest. NEVER commit it to a git repo. Use the host's "secret"
input mechanism when available.

---

## Railway

The fastest path. Railway gives every account a $5/mo free trial credit
which covers this bot indefinitely if you're filling a few orders per day.

**1.** Sign up at [railway.app](https://railway.app) (GitHub login OK)

**2.** Click the deploy button:

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https%3A%2F%2Fgithub.com%2Fgeniusyield%2Fgenius-yield-fill-bot&envs=NETWORK,GY_API_URL,BASE_ASSET_ID,QUOTE_ASSET_ID,WALLET_SEED,BLOCKFROST_API_KEY,AMM_SOURCE,DEXHUNTER_API_KEY,MIN_PROFIT_BPS,MAX_FILL_BASE)

**3.** Fill in the env vars in Railway's UI. `WALLET_SEED` is automatically
treated as a secret.

**4.** Click Deploy. Railway builds the Docker image and starts the bot in
~2 min. The "Logs" tab shows the bot's structured JSON output.

**5.** Set up health monitoring: the bot exposes `/healthz` on the port
Railway assigns. Railway pings it every 30s.

To stop the bot: hit Pause in the Railway dashboard. Your wallet seed stays
encrypted; redeploying resumes it with the same wallet.

---

## Fly.io

Cheapest option if you're comfortable with one CLI install. Fly's free tier
covers one always-on machine.

**1.** Install `flyctl`: <https://fly.io/docs/hands-on/install-flyctl>

**2.** Sign in:

```bash
fly auth signup    # or: fly auth login
```

**3.** Create the app (one-time):

```bash
fly launch --image ghcr.io/geniusyield/arb-bot:latest --no-deploy
```

When prompted, accept the defaults but set the **region** close to you
(e.g. `iad` for US-East, `cdg` for EU-West). Pick the smallest VM
(`shared-cpu-1x` / 256MB RAM is plenty).

**4.** Set secrets (the bot's env vars):

```bash
fly secrets set \
  NETWORK=Mainnet \
  GY_API_URL=https://api.prod.geniusyield.co \
  BASE_ASSET_ID=asset1lgultx63fukjlhsncmwp235pcnh4fh988phh7f \
  QUOTE_ASSET_ID=asset1xdz4yj4ldwlpsz2yjgjtt9evg9uskm8jrzjwhj \
  WALLET_SEED="abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" \
  BLOCKFROST_API_KEY=mainnetXXX \
  AMM_SOURCE=dexhunter \
  DEXHUNTER_API_KEY=XXX \
  MIN_PROFIT_BPS=50 \
  MAX_FILL_BASE=200000000
```

**5.** Deploy:

```bash
fly deploy
```

**6.** Tail the logs:

```bash
fly logs
```

To stop: `fly scale count 0`. To resume: `fly scale count 1`. Wallet state
is preserved in your secrets between scale-downs.

---

## DigitalOcean

Use the App Platform UI for a fully-managed deploy. ~$5/mo for the smallest
basic-xxs instance.

**1.** Sign up at [digitalocean.com](https://digitalocean.com)

**2.** Open the [App Platform](https://cloud.digitalocean.com/apps), click
**Create App**, choose **Docker Hub / Container Registry**.

**3.** Image: `ghcr.io/geniusyield/arb-bot:latest`. Click Next.

**4.** Set the environment variables in the "App-Level Environment Variables"
section. Mark `WALLET_SEED` and `BLOCKFROST_API_KEY` as **encrypted**.

**5.** HTTP port: `9100`. Health check: `/healthz`.

**6.** Choose the smallest plan ($5 basic-xxs). Click Create.

DigitalOcean builds and runs the container in ~3 min. Monitor via the App
Platform UI; logs are tail-able from the **Runtime Logs** tab.

---

## Self-hosted Docker

For users running their own server, home lab, or other cloud (AWS EC2,
Hetzner, etc.).

**1.** Copy `.env.example` to `.env` and fill in the values:

```bash
cp ../.env.example .env
$EDITOR .env
```

**2.** Pull and run:

```bash
docker run -d \
  --name gy-arb-bot \
  --restart unless-stopped \
  --env-file .env \
  -p 9100:9100 \
  ghcr.io/geniusyield/arb-bot:latest
```

**3.** Verify it's running:

```bash
curl http://localhost:9100/healthz   # → "ok"
curl http://localhost:9100/metrics   # → Prometheus output
docker logs -f gy-arb-bot
```

Or use the included [`docker-compose.yml`](docker-compose.yml):

```bash
docker compose up -d
docker compose logs -f
```

---

## After deploy: monitor and tune

- **Stats**: open `https://prod.geniusyield.co/bot/leaderboard` to see your
  bot's fills and PnL alongside other operators.
- **Withdraw**: import your `WALLET_SEED` into any Cardano wallet (Eternl,
  Nami, Lace) to access funds at any time. Your bot's wallet is a normal
  Cardano wallet — there's no special unlock procedure.
- **Tune `MIN_PROFIT_BPS`**: start at 50 (0.5%). Lower = more fills but
  thinner margins. Raise if you see lots of 409s (UTxO contention with
  other bots).
- **Scale**: run multiple instances for different pairs by setting
  `BASE_ASSET_ID`/`QUOTE_ASSET_ID` per deployment.

## Security checklist

- [ ] `WALLET_SEED` is in the host's secret store, not committed to git
- [ ] You wrote down your seed phrase OFFLINE before pasting it into the host
- [ ] You started with a small amount (e.g. 100 ADA + 100 ADA of base asset)
      to validate the bot's behavior before scaling capital
- [ ] You set `MAX_FILL_BASE` to a sensible cap (default = 200 ADA equivalent)
- [ ] Your DexHunter API key has rate limits set
- [ ] You have a way to monitor: dashboard, Discord webhook, or logs
