// Vercel/Node Stripe webhook additions for Alygnn employer monetization.
// Route suggestion: /api/stripe-webhook
//
// Required environment variables:
//   STRIPE_WEBHOOK_SECRET
//   STRIPE_SECRET_KEY
//   SUPABASE_URL=https://auth.alygnn.com
//   SUPABASE_SERVICE_ROLE_KEY
//
// In Stripe Dashboard, point the webhook at this route and subscribe at least to:
//   checkout.session.completed
//   customer.subscription.updated
//   customer.subscription.deleted
//   invoice.paid
//
// If you ALREADY have a Stripe webhook, merge the fulfillment branches below into
// your existing verified webhook instead of running two handlers for the same event.

const crypto = require('crypto');

function rawBody(req) {
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (typeof req.body === 'string') return Promise.resolve(Buffer.from(req.body));
  // Signature verification needs the exact raw bytes. If a framework parsed the
  // body first, disable its body parser for this route.
  if (req.body && typeof req.body === 'object') {
    throw new Error('Webhook body was parsed before signature verification. Disable body parsing for this route.');
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyStripeSignature(buffer, header, secret) {
  const parts = String(header || '').split(',').map(v => v.trim());
  const timestamp = parts.find(v => v.startsWith('t='))?.slice(2);
  const signatures = parts.filter(v => v.startsWith('v1=')).map(v => v.slice(3));
  if (!timestamp || !signatures.length) throw new Error('Missing Stripe signature.');

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) throw new Error('Stripe webhook timestamp is outside the tolerance window.');

  const expected = crypto
    .createHmac('sha256', secret)
    .update(timestamp + '.' + buffer.toString('utf8'), 'utf8')
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const valid = signatures.some(sig => {
    try {
      const received = Buffer.from(sig, 'hex');
      return received.length === expectedBuf.length && crypto.timingSafeEqual(received, expectedBuf);
    } catch (_) { return false; }
  });
  if (!valid) throw new Error('Invalid Stripe webhook signature.');
}

async function stripeGet(path) {
  const response = await fetch('https://api.stripe.com/v1/' + path.replace(/^\//, ''), {
    headers: { Authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || 'Stripe lookup failed.');
  return data;
}

function serviceHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured.');
  return {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
    ...extra
  };
}

function supabaseBase() {
  return (process.env.SUPABASE_URL || 'https://auth.alygnn.com').replace(/\/$/, '');
}

async function rpc(name, body) {
  const response = await fetch(`${supabaseBase()}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: serviceHeaders(),
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error((data && (data.message || data.error)) || `Supabase RPC ${name} failed.`);
  return data;
}

function planInfo(plan) {
  const key = String(plan || '').toLowerCase();
  return {
    launch: { legacyPlan: 'business', slots: 3, urgent: false },
    growth: { legacyPlan: 'enterprise', slots: 5, urgent: true },
    scale: { legacyPlan: 'enterprise', slots: 8, urgent: true },
    weekly_slot: { legacyPlan: 'business', slots: 1, urgent: false }
  }[key] || null;
}

async function upsertPlan({ employerId, plan, billing, status, periodEnd }) {
  const info = planInfo(plan);
  if (!employerId || !info) return;

  // test_plan stores the exact Launch/Growth/Scale/Weekly code for compatibility
  // with Alygnn's existing entitlement schema; test_mode remains false.
  const row = {
    employer_id: employerId,
    plan: info.legacyPlan,
    subscription_status: status || 'active',
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    slot_limit: info.slots,
    billing_period: billing || null,
    test_mode: false,
    test_plan: plan,
    urgently_hiring: info.urgent,
    updated_at: new Date().toISOString()
  };

  const response = await fetch(`${supabaseBase()}/rest/v1/employer_entitlements?on_conflict=employer_id`, {
    method: 'POST',
    headers: serviceHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(row)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error('Could not update employer plan entitlement: ' + text);
  }

  // Keep the job-level badge state consistent with the current plan.
  await fetch(`${supabaseBase()}/rest/v1/jobs?employer_id=eq.${encodeURIComponent(employerId)}&status=eq.active&posting_access_type=eq.plan`, {
    method: 'PATCH',
    headers: serviceHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ urgently_hiring: info.urgent })
  });
}

function plusDaysUnix(days) {
  return Math.floor(Date.now() / 1000) + days * 86400;
}

function plusMonthsUnix(months) {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() + months);
  return Math.floor(date.getTime() / 1000);
}

async function fulfillCheckout(session) {
  const meta = session.metadata || {};
  const employerId = meta.employer_id;
  const product = String(meta.product || '').toLowerCase();
  if (!employerId || !product) return;

  if (product === 'additional_slot' || product === 'single_job') {
    // Standalone $150/month Second Job Slot. The included free slot remains,
    // so this subscription gives the employer 2 total reusable active slots.
    if (session.mode === 'subscription' && session.subscription) {
      const subscription = await stripeGet(`subscriptions/${encodeURIComponent(session.subscription)}`);
      await rpc('sync_second_job_slot_subscription', {
        p_employer_id: employerId,
        p_status: subscription.status === 'trialing' ? 'trialing' : 'active',
        p_expires_at: new Date(subscription.current_period_end * 1000).toISOString(),
        p_payment_reference: session.id,
        p_amount_cents: session.amount_total || 15000
      });
      return;
    }

    // Legacy one-time checkout compatibility.
    await rpc('grant_additional_reusable_slot', {
      p_employer_id: employerId,
      p_quantity: 1,
      p_payment_reference: session.id,
      p_amount_cents: session.amount_total || 15000
    });
    return;
  }

  if (product === 'job_boost') {
    await rpc('activate_paid_job_boost', {
      p_employer_id: employerId,
      p_job_id: meta.job_id,
      p_days: Math.max(1, Number.parseInt(meta.days || '1', 10) || 1),
      p_payment_reference: session.id,
      p_amount_cents: session.amount_total || null
    });
    return;
  }

  if (product === 'job_plan') {
    const plan = meta.plan;
    const billing = meta.billing;

    if (session.mode === 'subscription' && session.subscription) {
      const subscription = await stripeGet(`subscriptions/${encodeURIComponent(session.subscription)}`);
      await upsertPlan({
        employerId,
        plan,
        billing,
        status: subscription.status === 'trialing' ? 'trialing' : 'active',
        periodEnd: subscription.current_period_end
      });
      return;
    }

    const expires = billing === 'weekly' ? plusDaysUnix(7) : plusMonthsUnix(3);
    await upsertPlan({ employerId, plan, billing, status: 'active', periodEnd: expires });
  }
}

async function fulfillSubscription(subscription, forceStatus) {
  const meta = subscription.metadata || {};
  const product = String(meta.product || '').toLowerCase();
  if (!meta.employer_id) return;

  if (product === 'additional_slot' || product === 'single_job') {
    const status = forceStatus || (subscription.status === 'trialing' ? 'trialing' : subscription.status);
    await rpc('sync_second_job_slot_subscription', {
      p_employer_id: meta.employer_id,
      p_status: status,
      p_expires_at: subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000).toISOString()
        : null,
      p_payment_reference: null,
      p_amount_cents: 15000
    });
    return;
  }

  if (product !== 'job_plan') return;
  await upsertPlan({
    employerId: meta.employer_id,
    plan: meta.plan,
    billing: meta.billing || 'monthly',
    status: forceStatus || (subscription.status === 'trialing' ? 'trialing' : 'active'),
    periodEnd: subscription.current_period_end
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end('Method not allowed');
  }

  try {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured.');
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not configured.');

    const buffer = await rawBody(req);
    verifyStripeSignature(buffer, req.headers['stripe-signature'], secret);
    const event = JSON.parse(buffer.toString('utf8'));

    switch (event.type) {
      case 'checkout.session.completed':
        if (event.data.object.payment_status === 'paid' || event.data.object.mode === 'subscription') {
          await fulfillCheckout(event.data.object);
        }
        break;

      case 'customer.subscription.updated':
        await fulfillSubscription(event.data.object);
        break;

      case 'customer.subscription.deleted':
        await fulfillSubscription(event.data.object, 'canceled');
        break;

      case 'invoice.paid': {
        const subscriptionId = event.data.object.subscription;
        if (subscriptionId) {
          const subscription = await stripeGet(`subscriptions/${encodeURIComponent(subscriptionId)}`);
          await fulfillSubscription(subscription);
        }
        break;
      }

      default:
        break;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ received: true }));
  } catch (error) {
    console.error('Alygnn Stripe webhook error:', error);
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: error?.message || 'Webhook failed.' }));
  }
};

// If this route is hosted through a framework that auto-parses request bodies,
// disable body parsing. In Next.js this export/config must be translated to the
// framework's expected form. Plain Vercel Node Functions generally expose the raw stream.
module.exports.config = { api: { bodyParser: false } };
