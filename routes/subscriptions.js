const router = require('express').Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { pool } = require('../db');
const requireAuth = require('../middleware/requireAuth');

const PLANS = {
  individual: { priceId: process.env.STRIPE_INDIVIDUAL_PRICE_ID, name: 'Individual' },
  team:       { priceId: process.env.STRIPE_TEAM_PRICE_ID,       name: 'Team'       },
};

// POST /api/subscriptions/checkout  — create Stripe Checkout session
router.post('/checkout', requireAuth, async (req, res) => {
  const { plan } = req.body;
  if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });

  const user = req.user;
  const appUrl = process.env.APP_URL || 'http://localhost:3000';

  try {
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, name: user.name, metadata: { userId: user.id } });
      customerId = customer.id;
      await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, user.id]);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: PLANS[plan].priceId, quantity: 1 }],
      success_url: `${appUrl}/app/index.html?subscription=success`,
      cancel_url:  `${appUrl}/pricing.html?subscription=canceled`,
      metadata: { userId: user.id, plan },
      subscription_data: { metadata: { userId: user.id, plan } },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// POST /api/subscriptions/webhook  — Stripe sends events here
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = parseInt(session.metadata.userId);
        const plan = session.metadata.plan;
        const subId = session.subscription;

        if (plan === 'team') {
          // Create a team for this user
          const { rows: teamRows } = await pool.query(
            'INSERT INTO teams (name, admin_user_id, stripe_customer_id, subscription_status, subscription_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [`Team (user ${userId})`, userId, session.customer, 'active', subId]
          );
          const teamId = teamRows[0].id;
          await pool.query(
            'UPDATE users SET subscription_status=$1, subscription_plan=$2, subscription_id=$3, role=$4, team_id=$5 WHERE id=$6',
            ['active', 'team', subId, 'team_admin', teamId, userId]
          );
        } else {
          await pool.query(
            'UPDATE users SET subscription_status=$1, subscription_plan=$2, subscription_id=$3 WHERE id=$4',
            ['active', 'individual', subId, userId]
          );
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const status = sub.status === 'active' || sub.status === 'trialing' ? 'active' : sub.status;
        const userId = parseInt(sub.metadata.userId);
        await pool.query('UPDATE users SET subscription_status=$1 WHERE id=$2', [status, userId]);
        // Also update team if applicable
        await pool.query('UPDATE teams SET subscription_status=$1 WHERE admin_user_id=$2', [status, userId]);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const userId = parseInt(sub.metadata.userId);
        await pool.query('UPDATE users SET subscription_status=$1 WHERE id=$2', ['canceled', userId]);
        await pool.query('UPDATE teams SET subscription_status=$1 WHERE admin_user_id=$2', ['canceled', userId]);
        break;
      }

      case 'invoice.payment_failed': {
        const inv = event.data.object;
        const { rows } = await pool.query('SELECT id FROM users WHERE stripe_customer_id=$1', [inv.customer]);
        if (rows.length) {
          await pool.query('UPDATE users SET subscription_status=$1 WHERE id=$2', ['past_due', rows[0].id]);
          await pool.query('UPDATE teams SET subscription_status=$1 WHERE admin_user_id=$2', ['past_due', rows[0].id]);
        }
        break;
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// GET /api/subscriptions/portal  — redirect to Stripe billing portal
router.get('/portal', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT stripe_customer_id FROM users WHERE id=$1', [req.user.id]);
  if (!rows[0]?.stripe_customer_id) return res.status(400).json({ error: 'No billing account found' });

  const session = await stripe.billingPortal.sessions.create({
    customer: rows[0].stripe_customer_id,
    return_url: `${process.env.APP_URL}/app/account.html`,
  });
  res.json({ url: session.url });
});

// GET /api/subscriptions/status
router.get('/status', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT subscription_status, subscription_plan, subscription_end_date FROM users WHERE id=$1',
    [req.user.id]
  );
  res.json(rows[0] || {});
});

module.exports = router;
