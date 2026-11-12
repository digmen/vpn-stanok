# VPN Franchise 🛰️

**English** · [Русский](README.ru.md)

> A Telegram-bot platform that turns anyone into a VPN reseller. A "factory" bot provisions a
> DPI-resistant VPN (**VLESS+WS+TLS**, **VLESS+Reality** or **AmneziaWG**, the owner's choice) **and** a ready-to-run sales bot onto a user's own server — fully
> automatically over SSH — monetized through a hosting referral program and Telegram Stars.

<p>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178c6">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-22-339933">
  <img alt="grammY" src="https://img.shields.io/badge/grammY-bot%20framework-009688">
  <img alt="Tests" src="https://img.shields.io/badge/tests-258%20passing-brightgreen">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue">
</p>

---

## What it does

Most people who want a VPN can't set one up — and running a VPN business is even harder. This project
collapses both into a two-minute Telegram flow:

1. A user opens the **factory bot**, buys a cheap VPS through a referral link, and hands the bot SSH access.
2. The factory bot connects over SSH and **provisions everything itself**: installs AmneziaWG, then
   deploys a **sales bot** onto the user's server and starts it under `pm2`.
3. The user now owns a turnkey VPN business — their bot sells access for **Telegram Stars** and invites
   its own customers to become resellers, closing a viral referral loop.

The operator earns a recurring commission on every referred hosting payment; each node operator keeps
their Stars revenue. Real product at every level — an affiliate model, not a pyramid.

## Architecture

```mermaid
flowchart TD
    U["New user"] -->|/start| F["Factory bot (@VPNForge)"]
    F -->|referral link| H[("VPS host")]
    U -->|buys VPS via referral| H
    H -->|recurring commission| OP["Operator"]
    U -->|"SSH access + bot token"| F
    F -->|SSH provisioning| N["User's server"]
    N --> WG["AmneziaWG VPN"]
    N --> S["Sales bot (pm2)"]
    S -->|sells VPN for ⭐ Stars| C["End customers"]
    S -.->|"earn the same way"| F
```

Two independently deployable services, each with a single responsibility:

| Service | Runs on | Responsibility |
|---|---|---|
| **`stanok-bot`** (factory) | operator's server, 24/7 | onboarding, SSH provisioning, deploying sales bots, credential storage |
| **`seller-bot`** (sales) | each node's server | selling VPN for Stars, minting VPN configs, owner analytics |

## Key features

- **Zero-touch provisioning** — the factory bot installs the VPN and deploys the sales bot over SSH; the node operator never touches a terminal.
- **Three protocols** — VLESS+WS+TLS with the node's own domain and certificate (default for new nodes since 2026-09-08: Reality turned out to be fingerprintable by strict carriers), VLESS+Reality and AmneziaWG. Each has its own installer and a **live handshake check**, not just "the script didn't fail".
- **Pre-flight checks** — can the server reach Telegram, is it reachable from Russia; unreachable nodes get a multi-hop relay.
- **Support bot** — @VPNForgeSupport_bot, a separate process on the same database: tickets, admin replies, user context on every ticket.
- **The sales bot does more than sell** — one subscription link with all of a client's keys, owner-defined plans and trials, promo codes, referrals (30% of the friend's term), renewal reminders, monthly traffic caps, card/SBP payments via Tribute, self-update.
- **Node lifecycle** — owner-bot downtime alerts, quiet alerting without repeats, nudges for stuck users, owner broadcasts with rollback, revenue collection.
- **Telegram Stars payments** — native `XTR` invoices, pre-checkout and delivery handled end-to-end.
- **Encrypted at rest** — node root credentials are stored with **AES-256-GCM**; the key never leaves the server.
- **Flexible config delivery** — QR, `.conf` file, or text, chosen by the user.
- **Owner analytics** — sales, revenue and live-peer counts, gated to the bot owner by Telegram ID.
- **Self-cleaning UX** — single evolving messages, no chat clutter.
- **Tested core** — Jest unit tests for validation, crypto and parsing.

## Tech stack

TypeScript · Node.js 22 (ESM) · [grammY](https://grammy.dev) · better-sqlite3 · AmneziaWG / WireGuard ·
Telegram Stars · pm2 · Jest

## Repository structure

```
vpn-franchise/
├── stanok-bot/        # factory bot (src/index.ts) and support bot (src/support/) — one codebase, one DB, two processes
│   └── scripts/       # protocol installers, end-to-end checks, reports, lab probes
├── seller-bot/        # sales bot — deployed by the factory onto every node's server
│   └── scripts/       # issue/revoke keys per protocol, traffic, self-update
├── docs/CODEMAP.ru.md # code map (Russian): every file and what it is for
├── .github/workflows/deploy.yml  # tests and factory deployment
└── deploy-stanok.sh   # manual one-command deployment
```

File-by-file description: **[docs/CODEMAP.ru.md](docs/CODEMAP.ru.md)** (Russian).

## Getting started

**Prerequisites:** Node.js 22+, a Telegram bot token from [@BotFather](https://t.me/BotFather).

```bash
# Factory bot
cd stanok-bot
npm install
cp .env.example .env      # set BOT_TOKEN and ADMIN_IDS
npm run typecheck
npm test
npm run dev
```

```bash
# Sales bot (normally deployed automatically by the factory bot)
cd seller-bot
npm install
cp .env.example .env      # set SELLER_BOT_TOKEN
npm run dev
```

### Configuration

| Variable | Service | Description |
|---|---|---|
| `BOT_TOKEN` | factory | Factory bot token |
| `ADMIN_IDS` | factory | Telegram IDs that receive error alerts |
| `ENCRYPTION_KEY` | factory | 64 hex chars; auto-generated if omitted |
| `REFERRAL_LINK` | factory | Hosting referral link shown to users |
| `SELLER_PRICE_STARS` | factory | Price the deployed sales bots charge |
| `SELLER_BOT_TOKEN` | sales | Sales bot token (injected on deploy) |
| `OWNER_ID` | sales | Owner's Telegram ID (injected on deploy) |

## Deployment

Run the factory bot on an always-on server (outside jurisdictions that block Telegram):

```bash
./deploy-stanok.sh <SERVER_IP>
```

The script packages the code, installs Node + pm2 on the remote host, runs `npm install`, and starts
the bot under `pm2` with restart-on-reboot. Re-run it to ship updates.

### Deployment via GitHub

A push to `main` touching `stanok-bot/**`, `seller-bot/**` or the workflow itself runs the tests and, if they pass, **deploys the factory to production and restarts the bot** (and the support bot). Documentation-only changes (root `*.md`, `docs/`) do not trigger a deploy. So code changes go through a branch and a pull request; tests run on PRs without deploying.

## How provisioning works

The interesting part is `stanok-bot` acting as a remote deployer. On demand it:

1. Connects to the node's server via SSH using decrypted credentials.
2. Runs the installer for the chosen protocol and verifies with a **live handshake** that the server really accepts VPN.
3. Uploads the `seller-bot` source (excluding `node_modules`), installs dependencies, writes an
   `.env`, and starts it under `pm2` — all idempotently.
4. Reports the running bot's link back to the user and alerts admins on any failure.

VPN peers are then created directly through `awg` on the node, so each customer gets a unique,
revocable config without any interactive tooling.

## Security

- Node credentials are encrypted with AES-256-GCM before storage.
- Secrets (`.env`, keys, databases) are git-ignored and never logged.
- Access to owner-only features (analytics, free VPN) is verified by Telegram ID on both the UI and handler level.

## Testing

```bash
cd stanok-bot && npm test
```

Pure logic — input validation, encryption round-trips, and output parsing — is isolated from I/O and
covered by Jest.

## Roadmap

- [x] Subscription expiry and automatic peer revocation
- [x] Node health monitoring with admin alerts
- [x] Owner-configurable pricing
- [ ] Native Amnezia `vpn://` one-line keys
- [ ] Multi-region endpoints

## Disclaimer

Built as an engineering portfolio project. VPN and reselling regulations vary by jurisdiction — use it
where it is lawful to do so.

## License

[MIT](LICENSE)
# vpn-stanok
