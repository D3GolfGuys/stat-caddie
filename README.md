# Stat Caddie — Web App

Full-stack golf statistics platform with user authentication, Stripe subscriptions (Individual & Team), and server-side round storage.

---

## Tech Stack

- **Backend:** Node.js + Express
- **Database:** PostgreSQL (hosted on Railway)
- **Auth:** JWT in httpOnly cookies + bcrypt
- **Payments:** Stripe Subscriptions + Webhook
- **Frontend:** Vanilla HTML/CSS/JS
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
| `STRIPE_INDIVIDUAL_PRICE_ID` | Price ID for Individual plan |
| `STRIPE_TEAM_PRICE_ID` | Price ID for Team plan |
| `APP_URL` | `http://localhost:3000` for dev |

### 4. Set up Stripe

1. Log in to [dashboard.stripe.com](https://dashboard.stripe.com)
2. Go to **Products** → Create two products:
   - **Stat Caddie Individual** — $9.99/month recurring → copy the Price ID
   - **Stat Caddie Team** — $39.99/month recurring → copy the Price ID
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
5. Set `APP_URL` to your Railway public URL (e.g. `https://statcaddie.up.railway.app`)
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
│   └── teams.js               # Team management API
├── middleware/
│   ├── requireAuth.js         # JWT verification
│   └── requireSubscription.js # Active subscription check
└── public/                    # Static frontend
    ├── index.html             # Marketing landing page
    ├── login.html
    ├── register.html
    ├── accept-invite.html     # Team invitation acceptance
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
        ├── reports.html       # Stats reports & charts
        ├── team.html          # Team management (admin only)
        └── account.html       # Account & billing settings
```

---

## Subscription Plans

| Plan | Price | Players | Features |
|---|---|---|---|
| Individual | $9.99/mo | 1 | All capture & reporting tools |
| Team | $39.99/mo | Up to 15 | Individual features + team roster, aggregate reports, player invitations |

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
| GET | `/api/teams/me` | ✓ | Team info + members |
| PUT | `/api/teams/me` | ✓ Admin | Update team name |
| POST | `/api/teams/invite` | ✓ Admin | Invite player by email |
| DELETE | `/api/teams/members/:id` | ✓ Admin | Remove player |
| GET | `/api/teams/rounds` | ✓ Admin | All team rounds |
