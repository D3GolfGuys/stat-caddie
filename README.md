# College Golf Metrics — Web App

Full-stack college golf statistics platform: tournament-style round capture, team dashboards, national statistical rankings & leaderboards, and one-click PDF reports. Includes user authentication, Stripe Team subscriptions, and server-side round storage.

> Formerly "Stat Caddie." Part of the D3 Golf Guys brand — **CollegeGolfMetrics.com**.

---

## Tech Stack

- **Backend:** Node.js + Express
- **Database:** PostgreSQL (hosted on Railway)
- **Auth:** JWT in httpOnly cookies + bcrypt
- **Payments:** Stripe Subscriptions + Webhook
- **Frontend:** Vanilla HTML/CSS/JS (client-side jsPDF for reports)
- **Hosting:** Railway (recommended)

---

## Local Development

### 1. Prerequisites
- Node.js 18+
- A PostgreSQL database (local or cloud)
- A Stripe account (test mode is fine to start)

### 2. Install dependencies
```bash
cd webapp
npm install
```

### 3. Configure environment variables
```bash
cp .env.example .env
```
Edit `.env` with your values:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Long random string (64+ chars) |
| `STRIPE_SECRET_KEY` | From Stripe Dashboard → API keys |
| `STRIPE_PUBLISHABLE_KEY` | From Stripe Dashboard → API keys |
| `STRIPE_WEBHOOK_SECRET` | From Stripe → Webhooks (see step 4) |
| `STRIPE_TEAM_PRICE_ID` | Price ID for the Team plan |
| `GOLF_COURSE_API_KEY` | GolfCourseAPI key — pre-fills par/HCP/yardage on capture |
| `APP_URL` | `http://localhost:3000` for dev |

### 4. Set up Stripe

1. Log in to [dashboard.stripe.com](https://dashboard.stripe.com)
2. Go to **Products** → Create the product:
   - **College Golf Metrics Team** — $29.99/month recurring → copy the Price ID into `STRIPE_TEAM_PRICE_ID`
3. Go to **Webhooks** → Add endpoint: `https://your-domain.com/api/subscriptions/webhook`
   - Events to listen for:
     - `checkout.session.completed`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`
     - `invoice.payment_failed`
4. Copy the **Signing secret** into `STRIPE_WEBHOOK_SECRET`

For local webhook testing, use the [Stripe CLI](https://stripe.com/docs/stripe-cli):
```bash
stripe listen --forward-to localhost:3000/api/subscriptions/webhook
```

### 5. Run the server
```bash
npm run dev    # development (auto-restart)
npm start      # production
```

Open [http://localhost:3000](http://localhost:3000)

---

## Deploying to Railway

Railway is the recommended host — it provides Node.js hosting + PostgreSQL in one place.

### Steps:
1. Push this `webapp/` folder to a GitHub repository
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Add a **PostgreSQL** plugin to your project (Railway does this in one click)
4. Set all environment variables in Railway's **Variables** tab
5. Set `APP_URL` to your Railway public URL (e.g. `https://collegegolfmetrics.up.railway.app`)
6. Railway auto-detects Node.js and runs `npm start`

The database schema is created automatically on first boot.

---

## Project Structure

```
webapp/
├── server.js                  # Express app entry point
├── package.json
├── .env.example               # Environment variable template
├── db/
│   └── index.js               # PostgreSQL connection + schema init
├── routes/
│   ├── auth.js                # Register, login, logout, me, accept-invite
│   ├── subscriptions.js       # Stripe checkout, webhook, billing portal
│   ├── rounds.js              # Round CRUD API
│   ├── teams.js               # Team management + team rounds/scoring
│   ├── courses.js             # Course lookup + par/HCP/yardage pre-fill
│   ├── rankings.js            # Metric registry + national/division leaderboards
│   ├── schools.js             # Schools reference (division/conference/region)
│   ├── scoreboard.js          # Clippd Scoreboard catalog ingest
│   └── admin.js               # Owner-only platform stats + demo seeding
├── services/
│   ├── stats.js               # Season stat computation + metric values
│   ├── rankings.js            # Ranking engine (players & teams, percentiles)
│   ├── metrics.js             # Canonical metric registry
│   ├── catalog.js             # Scoreboard catalog ingester
│   ├── scoreboard.js          # Scoreboard API client
│   ├── courses.js             # GolfCourseAPI client
│   ├── schools.js             # Schools reference loader
│   ├── demoSeed.js            # Demo team / league seeder
│   └── reconcile.js           # Data reconciliation helpers
├── middleware/
│   ├── requireAuth.js         # JWT verification
│   └── requireSubscription.js # Active subscription check
└── public/                    # Static frontend
    ├── index.html             # Marketing landing page
    ├── login.html
    ├── register.html          # Team (coach) signup
    ├── accept-invite.html     # Team invitation acceptance
    ├── leaderboard.html       # Public national leaderboards
    ├── css/
    │   ├── main.css           # Shared styles
    │   └── app.css            # App shell styles
    ├── js/
    │   ├── api.js             # Fetch helpers + auth redirect
    │   └── appshell.js        # Shared app nav/sidebar init
    └── app/
        ├── index.html         # App home dashboard
        ├── capture.html       # Desktop round capture
        ├── mobile.html        # Mobile round capture
        ├── reports.html       # Stats reports, charts & PDF export
        ├── course-history.html# Per-course hole-by-hole history
        ├── leaderboard.html   # In-app rankings & leaderboards
        ├── team.html          # Team dashboard (coach only)
        ├── admin.html         # Owner-only platform stats / seeding
        └── account.html       # Account & billing settings
```

---

## Subscription Plan

| Plan | Price | Players | Features |
|---|---|---|---|
| Team | $29.99/mo | Up to 15 | Full player capture & reporting, team dashboard with drop-the-high scoring, course history, national rankings & leaderboards, roster management & invites, one-click player & team PDF reports |

Signup is team-only: coaches create the account and invite players to join their roster.

---

## Rankings & Leaderboards

Rankings are computed **only from rounds entered in College Golf Metrics** — this is the platform's moat. The engine provisions one canonical player per app user (segmented by their team's division/conference/region/gender), computes each player's season stat profile, and ranks players and teams per metric within national and division cohorts. Standings are available for the current season and career, split by men's and women's golf, with percentile badges. Rankings refresh nightly and are exposed both publicly (`/leaderboard.html`) and in-app.

---

## API Reference

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/register` | — | Create account |
| POST | `/api/auth/login` | — | Log in |
| POST | `/api/auth/logout` | — | Log out |
| GET | `/api/auth/me` | ✓ | Current user |
| POST | `/api/auth/accept-invite` | — | Join team via invite token |
| POST | `/api/subscriptions/checkout` | ✓ | Create Stripe Checkout session |
| POST | `/api/subscriptions/webhook` | — | Stripe webhook handler |
| GET | `/api/subscriptions/portal` | ✓ | Stripe billing portal URL |
| GET | `/api/rounds` | ✓ Sub | List user's rounds |
| POST | `/api/rounds` | ✓ Sub | Create round |
| GET | `/api/rounds/:id` | ✓ Sub | Get round + holes |
| DELETE | `/api/rounds/:id` | ✓ Sub | Delete round |
| GET | `/api/courses/search` | ✓ | Course lookup (par/HCP/yardage pre-fill) |
| GET | `/api/teams/me` | ✓ | Team info + members |
| PUT | `/api/teams/me` | ✓ Admin | Update team name |
| POST | `/api/teams/invite` | ✓ Admin | Invite player by email |
| DELETE | `/api/teams/members/:id` | ✓ Admin | Remove player |
| GET | `/api/teams/rounds` | ✓ Admin | All team rounds + team scoring |
| GET | `/api/rankings/metrics` | — | Metric registry for leaderboards |
| GET | `/api/rankings/leaderboard` | — | Player/team rankings by metric, segment & gender |
| GET | `/api/schools` | — | Schools reference (division/conference/region) |
