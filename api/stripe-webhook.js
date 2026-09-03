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
//   invoice.payment_failed
//   invoice.payment_action_required
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

async function stripeRequest(method, path, params = {}) {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error('STRIPE_SECRET_KEY is not configured.');

  let url = 'https://api.stripe.com/v1/' + String(path || '').replace(/^\//, '');
  const options = { method, headers: { Authorization: 'Bearer ' + secret } };

  if (method === 'GET') {
    const u = new URL(url);
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') u.searchParams.append(key, String(value));
    });
    url = u.toString();
  } else {
    const form = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') form.append(key, String(value));
    });
    options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    options.body = form;
  }

  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message || 'Stripe request failed.');
    error.status = response.status;
    error.stripe = data?.error || null;
    throw error;
  }
  return data;
}

function stripeGet(path, params) {
  return stripeRequest('GET', path, params);
}

function stripePost(path, params) {
  return stripeRequest('POST', path, params);
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

function planAmountCents(plan, billing) {
  const key = String(plan || '').toLowerCase();
  const period = String(billing || '').toLowerCase();
  if (period === 'monthly') {
    return { launch: 29900, growth: 44900, scale: 64900 }[key] || null;
  }
  if (period === 'quarterly') {
    return { launch: 75000, growth: 114000, scale: 170000 }[key] || null;
  }
  if (period === 'weekly') return key === 'weekly_slot' ? 9900 : null;
  return null;
}

async function upsertPlan({
  employerId,
  plan,
  billing,
  status,
  periodEnd,
  subscriptionId,
  customerId,
  scheduleId,
  candidateAccessLocked,
  candidateAccessLockReason,
  paymentFailedAt
}) {
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
    alygnn_recommended: info.urgent,
    plan_amount_cents: planAmountCents(plan, billing),
    stripe_plan_subscription_id: subscriptionId || null,
    stripe_plan_customer_id: customerId || null,
    stripe_plan_schedule_id: scheduleId || null,
    updated_at: new Date().toISOString()
  };

  if (typeof candidateAccessLocked === 'boolean') {
    row.candidate_access_locked = candidateAccessLocked;
    row.candidate_access_lock_reason = candidateAccessLocked
      ? (candidateAccessLockReason || 'payment_failed')
      : null;
    row.candidate_access_locked_at = candidateAccessLocked ? new Date().toISOString() : null;
  }
  if (paymentFailedAt) row.last_payment_failed_at = paymentFailedAt;

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
    body: JSON.stringify({ urgently_hiring: info.urgent, alygnn_recommended: info.urgent })
  });
}

async function clearPendingIfApplied(employerId, activePlan) {
  if (!employerId || !activePlan) return;
  const url = new URL(`${supabaseBase()}/rest/v1/employer_entitlements`);
  url.searchParams.set('employer_id', 'eq.' + employerId);
  url.searchParams.set('select', 'pending_plan');
  url.searchParams.set('limit', '1');

  const read = await fetch(url, { headers: serviceHeaders() });
  const rows = await read.json().catch(() => []);
  if (!read.ok || !Array.isArray(rows) || !rows[0]) return;

  if (String(rows[0].pending_plan || '').toLowerCase() !== String(activePlan).toLowerCase()) return;

  const patchUrl = new URL(`${supabaseBase()}/rest/v1/employer_entitlements`);
  patchUrl.searchParams.set('employer_id', 'eq.' + employerId);
  await fetch(patchUrl, {
    method: 'PATCH',
    headers: serviceHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({
      pending_plan: null,
      pending_billing_period: null,
      pending_plan_effective_at: null,
      stripe_plan_schedule_id: null,
      plan_change_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
  });
}

async function findSecondSlotSubscriptions(employerId) {
  const found = [];
  for (const product of ['additional_slot', 'single_job']) {
    try {
      const query = `metadata["employer_id"]:"${employerId}" AND metadata["product"]:"${product}"`;
      const result = await stripeGet('subscriptions/search', { query, limit: 20 });
      for (const sub of result?.data || []) {
        if (!['canceled', 'incomplete_expired'].includes(String(sub.status || '').toLowerCase())) {
          found.push(sub);
        }
      }
    } catch (error) {
      console.warn('Could not search Second Job Slot subscriptions:', error?.message || error);
    }
  }
  const unique = new Map(found.map(sub => [sub.id, sub]));
  return [...unique.values()];
}

async function stopSecondSlotRenewalForPaidPlan(employerId) {
  const subscriptions = await findSecondSlotSubscriptions(employerId);
  for (const sub of subscriptions) {
    if (sub.cancel_at_period_end === true) continue;
    try {
      await stripePost(`subscriptions/${encodeURIComponent(sub.id)}`, {
        cancel_at_period_end: 'true'
      });
    } catch (error) {
      console.warn('Could not stop Second Job Slot renewal after paid plan activation:', error?.message || error);
    }
  }
}

async function syncSecondSlotSubscription(subscription, forceStatus) {
  const meta = subscription?.metadata || {};
  if (!meta.employer_id) return;
  const status = forceStatus || String(subscription.status || 'inactive').toLowerCase();
  await rpc('sync_additional_job_slot_subscription', {
    p_employer_id: meta.employer_id,
    p_subscription_id: subscription.id,
    p_status: status,
    p_expires_at: subscription.current_period_end
      ? new Date(Number(subscription.current_period_end) * 1000).toISOString()
      : null,
    p_checkout_session_id: null,
    p_amount_cents: 15000
  });
  if (['canceled','unpaid','incomplete_expired'].includes(String(status).toLowerCase())) {
    await rpc('alygnn_apply_second_slot_end', { p_employer_id: meta.employer_id });
  }
}

async function ensureWebhookRecurringPrice(plan, billing) {
  const lookup = `alygnn_${plan}_${billing}`;
  const envKey = `STRIPE_PRICE_${String(plan).toUpperCase()}_${String(billing).toUpperCase()}`;
  if (process.env[envKey]) return process.env[envKey];

  const listed = await stripeGet('prices', {
    'lookup_keys[]': lookup,
    active: 'true',
    limit: 1
  });
  if (listed?.data?.[0]?.id) return listed.data[0].id;

  const cents = planAmountCents(plan, billing);
  if (!cents) throw new Error('Unknown Alygnn upgrade price.');
  const intervalCount = billing === 'quarterly' ? 3 : 1;
  const name = `Alygnn ${String(plan).charAt(0).toUpperCase() + String(plan).slice(1)}${billing === 'quarterly' ? ' — 3 months' : ''}`;

  const created = await stripePost('prices', {
    currency: 'usd',
    unit_amount: cents,
    lookup_key: lookup,
    'recurring[interval]': 'month',
    'recurring[interval_count]': intervalCount,
    'product_data[name]': name,
    'metadata[alygnn_plan]': plan,
    'metadata[billing]': billing
  });
  return created.id;
}

async function applyPaidUpgradeInvoice(invoice) {
  const meta = invoice?.metadata || {};
  if (String(meta.product || '').toLowerCase() !== 'plan_upgrade') return false;

  const employerId = meta.employer_id;
  const targetPlan = String(meta.target_plan || '').toLowerCase();
  const billing = String(meta.billing || '').toLowerCase();
  const subscriptionId = meta.subscription_id;
  if (!employerId || !['launch','growth','scale'].includes(targetPlan) ||
      !['monthly','quarterly'].includes(billing) || !subscriptionId) {
    throw new Error('Paid upgrade invoice is missing required Alygnn metadata.');
  }

  let subscription = await stripeGet(`subscriptions/${encodeURIComponent(subscriptionId)}`);
  const item = subscription?.items?.data?.[0];
  if (!item?.id) throw new Error('Upgrade subscription item could not be identified.');

  const targetPrice = meta.target_price_id || await ensureWebhookRecurringPrice(targetPlan, billing);
  subscription = await stripePost(`subscriptions/${encodeURIComponent(subscriptionId)}`, {
    cancel_at_period_end: 'false',
    'items[0][id]': item.id,
    'items[0][price]': targetPrice,
    'items[0][quantity]': 1,
    proration_behavior: 'none',
    'metadata[employer_id]': employerId,
    'metadata[product]': 'job_plan',
    'metadata[plan]': targetPlan,
    'metadata[billing]': billing
  });

  await upsertPlan({
    employerId,
    plan: targetPlan,
    billing,
    status: String(subscription.status || 'active').toLowerCase(),
    periodEnd: subscription.current_period_end,
    subscriptionId: subscription.id,
    customerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id,
    scheduleId: typeof subscription.schedule === 'string' ? subscription.schedule : subscription.schedule?.id,
    candidateAccessLocked: false
  });
  await clearPendingIfApplied(employerId, targetPlan);
  await stopSecondSlotRenewalForPaidPlan(employerId);
  return true;
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
    // Free-account-only $150/month Second Job Slot.
    if (session.mode === 'subscription' && session.subscription) {
      const subscription = await stripeGet(`subscriptions/${encodeURIComponent(session.subscription)}`);
      await rpc('sync_additional_job_slot_subscription', {
        p_employer_id: employerId,
        p_subscription_id: subscription.id,
        p_status: subscription.status === 'trialing' ? 'trialing' : String(subscription.status || 'active').toLowerCase(),
        p_expires_at: subscription.current_period_end
          ? new Date(Number(subscription.current_period_end) * 1000).toISOString()
          : null,
        p_checkout_session_id: session.id,
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
    const plan = String(meta.plan || '').toLowerCase();
    const billing = String(meta.billing || '').toLowerCase();

    // $99 Weekly is a TEMPORARY ADD-ON ROW. It must never replace the employer's
    // Launch/Growth/Scale entitlement.
    if (plan === 'weekly_slot' || billing === 'weekly') {
      await rpc('grant_weekly_job_slot', {
        p_employer_id: employerId,
        p_payment_reference: session.id,
        p_amount_cents: session.amount_total || 9900,
        p_days: 7
      });
      return;
    }

    if (session.mode === 'subscription' && session.subscription) {
      const subscription = await stripeGet(`subscriptions/${encodeURIComponent(session.subscription)}`);
      await upsertPlan({
        employerId,
        plan,
        billing,
        status: subscription.status === 'trialing' ? 'trialing' : String(subscription.status || 'active').toLowerCase(),
        periodEnd: subscription.current_period_end,
        subscriptionId: subscription.id,
        customerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id,
        scheduleId: typeof subscription.schedule === 'string' ? subscription.schedule : subscription.schedule?.id,
        candidateAccessLocked: false
      });
      await clearPendingIfApplied(employerId, plan);
      await stopSecondSlotRenewalForPaidPlan(employerId);
      return;
    }

    // Legacy quarterly one-time checkout compatibility.
    const expires = plusMonthsUnix(3);
    await upsertPlan({
      employerId, plan, billing, status: 'active', periodEnd: expires,
      candidateAccessLocked: false
    });
    await stopSecondSlotRenewalForPaidPlan(employerId);
  }
}

async function fulfillSubscription(subscription, forceStatus, options = {}) {
  const meta = subscription.metadata || {};
  const product = String(meta.product || '').toLowerCase();
  if (!meta.employer_id) return;

  const actualStatus = forceStatus ||
    (subscription.status === 'trialing' ? 'trialing' : String(subscription.status || 'active').toLowerCase());

  if (product === 'additional_slot' || product === 'single_job') {
    await syncSecondSlotSubscription(subscription, actualStatus);
    return;
  }

  if (product !== 'job_plan') return;

  let candidateLock;
  let lockReason;
  let failedAt;

  if (options.clearCandidateLock === true ||
      ['canceled','unpaid','incomplete_expired'].includes(actualStatus)) {
    candidateLock = false;
  } else if (options.lockCandidateAccess === true || actualStatus === 'past_due') {
    candidateLock = true;
    lockReason = options.lockReason || 'payment_failed';
    failedAt = options.paymentFailedAt || new Date().toISOString();
  }

  await upsertPlan({
    employerId: meta.employer_id,
    plan: meta.plan,
    billing: meta.billing || 'monthly',
    status: actualStatus,
    periodEnd: subscription.current_period_end,
    subscriptionId: subscription.id,
    customerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id,
    scheduleId: typeof subscription.schedule === 'string' ? subscription.schedule : subscription.schedule?.id,
    candidateAccessLocked: candidateLock,
    candidateAccessLockReason: lockReason,
    paymentFailedAt: failedAt
  });

  await clearPendingIfApplied(meta.employer_id, meta.plan);

  if (['canceled','unpaid','incomplete_expired'].includes(actualStatus)) {
    await rpc('alygnn_apply_free_fallback_after_plan_end', {
      p_employer_id: meta.employer_id
    });
  }
}

function invoiceSubscriptionId(invoice) {
  const direct = typeof invoice?.subscription === 'string'
    ? invoice.subscription
    : invoice?.subscription?.id;
  if (direct) return direct;

  const parent = invoice?.parent?.subscription_details?.subscription;
  if (typeof parent === 'string') return parent;
  if (parent?.id) return parent.id;

  const legacyDetails = invoice?.subscription_details?.subscription;
  if (typeof legacyDetails === 'string') return legacyDetails;
  if (legacyDetails?.id) return legacyDetails.id;
  return null;
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

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const status = String(subscription.status || '').toLowerCase();
        await fulfillSubscription(subscription, null, {
          lockCandidateAccess: status === 'past_due',
          lockReason: status === 'past_due' ? 'payment_failed' : undefined,
          clearCandidateLock: ['canceled','unpaid','incomplete_expired'].includes(status)
        });
        break;
      }

      case 'customer.subscription.deleted':
        await fulfillSubscription(event.data.object, 'canceled', { clearCandidateLock: true });
        break;

      case 'invoice.paid': {
        const invoice = event.data.object;

        // Fixed-difference plan upgrade invoice: payment first, capacity upgrade second.
        if (String(invoice?.metadata?.product || '').toLowerCase() === 'plan_upgrade') {
          await applyPaidUpgradeInvoice(invoice);
          break;
        }

        const subscriptionId = invoiceSubscriptionId(invoice);
        if (subscriptionId) {
          const subscription = await stripeGet(`subscriptions/${encodeURIComponent(subscriptionId)}`);
          await fulfillSubscription(subscription, null, { clearCandidateLock: true });
        }
        break;
      }

      case 'invoice.payment_failed':
      case 'invoice.payment_action_required': {
        const invoice = event.data.object;

        // A failed one-time fixed-difference upgrade does NOT lock the existing plan;
        // the employer simply remains on the plan they already paid for.
        if (String(invoice?.metadata?.product || '').toLowerCase() === 'plan_upgrade') break;

        const subscriptionId = invoiceSubscriptionId(invoice);
        if (subscriptionId) {
          const subscription = await stripeGet(`subscriptions/${encodeURIComponent(subscriptionId)}`);
          const product = String(subscription?.metadata?.product || '').toLowerCase();

          if (product === 'job_plan') {
            await fulfillSubscription(subscription, 'past_due', {
              lockCandidateAccess: true,
              lockReason: event.type === 'invoice.payment_action_required'
                ? 'payment_action_required'
                : 'payment_failed',
              paymentFailedAt: new Date().toISOString()
            });
          } else if (product === 'additional_slot' || product === 'single_job') {
            await syncSecondSlotSubscription(subscription, 'past_due');
          }
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
