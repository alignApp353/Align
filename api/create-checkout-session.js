// Vercel Node Function: /api/create-checkout-session
// Alygnn employer checkout for website + Capacitor app.
// No Stripe npm package required; this uses Stripe's HTTPS API directly.
//
// Required Vercel environment variables:
//   STRIPE_SECRET_KEY
//   SUPABASE_URL=https://auth.alygnn.com
//   SUPABASE_ANON_KEY=<your publishable/anon key>
//
// IMPORTANT: The webhook file supplied with this patch is what grants the
// $150 reusable add-on slot / Job Boost / plan entitlement after Stripe confirms payment.

const STRIPE_API = 'https://api.stripe.com/v1';

const PLAN_CATALOG = {
  monthly: {
    launch: { name: 'Alygnn Launch', cents: 29900, slots: 3, mode: 'subscription' },
    growth: { name: 'Alygnn Growth', cents: 44900, slots: 5, mode: 'subscription' },
    scale:  { name: 'Alygnn Scale',  cents: 64900, slots: 8, mode: 'subscription' }
  },
  quarterly: {
    launch: { name: 'Alygnn Launch — 3 months', cents: 75000, slots: 3, mode: 'payment' },
    growth: { name: 'Alygnn Growth — 3 months', cents: 114000, slots: 5, mode: 'payment' },
    scale:  { name: 'Alygnn Scale — 3 months',  cents: 170000, slots: 8, mode: 'payment' }
  },
  weekly: {
    weekly_slot: { name: 'Alygnn Weekly Job Slot — 7 days', cents: 9900, slots: 1, mode: 'payment' }
  }
};

function cors(res) {
  // Authorization is Bearer-token based, not cookie based, so wildcard origin is
  // appropriate for the local Capacitor WebView + alygnn.com.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
}

function send(res, status, payload) {
  cors(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  try { return JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body)); }
  catch (_) { return {}; }
}

function bearer(req) {
  const value = String(req.headers.authorization || '');
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : '';
}

function allowedReturnUrl(value, fallback) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol === 'https:' && (url.hostname === 'alygnn.com' || url.hostname.endsWith('.alygnn.com'))) {
      return url.toString();
    }
  } catch (_) {}
  return fallback;
}

async function supabaseUser(token) {
  const base = process.env.SUPABASE_URL || 'https://auth.alygnn.com';
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!anon) throw new Error('SUPABASE_ANON_KEY is not configured.');

  const response = await fetch(base.replace(/\/$/, '') + '/auth/v1/user', {
    headers: { apikey: anon, Authorization: 'Bearer ' + token }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.id) throw new Error('Invalid employer session.');
  return data;
}

async function verifyOwnedActiveJob(token, userId, jobId) {
  const base = process.env.SUPABASE_URL || 'https://auth.alygnn.com';
  const anon = process.env.SUPABASE_ANON_KEY;
  const url = new URL(base.replace(/\/$/, '') + '/rest/v1/jobs');
  url.searchParams.set('id', 'eq.' + jobId);
  url.searchParams.set('employer_id', 'eq.' + userId);
  url.searchParams.set('select', 'id,status');
  url.searchParams.set('limit', '1');

  const response = await fetch(url, {
    headers: { apikey: anon, Authorization: 'Bearer ' + token }
  });
  const rows = await response.json().catch(() => []);
  if (!response.ok || !Array.isArray(rows) || !rows[0]) throw new Error('The selected job could not be verified.');
  if (String(rows[0].status || '').toLowerCase() !== 'active') throw new Error('Only active jobs can be boosted.');
  return rows[0];
}


async function getEmployerPostingAccess(token) {
  const base=(process.env.SUPABASE_URL||'https://auth.alygnn.com').replace(/\/$/,'');
  const anon=process.env.SUPABASE_ANON_KEY;

  if(!anon) throw new Error('SUPABASE_ANON_KEY is not configured.');

  const response=await fetch(base+'/rest/v1/rpc/get_employer_posting_access',{
    method:'POST',
    headers:{
      apikey:anon,
      Authorization:'Bearer '+token,
      'Content-Type':'application/json'
    },
    body:'{}'
  });

  const data=await response.json().catch(()=>null);

  if(!response.ok){
    throw new Error(
      (data&&(data.message||data.error))||
      'Could not verify employer hiring capacity.'
    );
  }

  return data||{};
}

function additionalSlotEligible(access) {
  const plan=String(access?.plan||'').toLowerCase();

  return(
    access?.active_paid_plan===true &&
    String(access?.billing_period||'').toLowerCase()==='monthly' &&
    ['launch','growth','scale','business','enterprise'].includes(plan)
  );
}

async function stripeCreateCheckout(params) {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error('STRIPE_SECRET_KEY is not configured.');

  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    body.append(key, String(value));
  }

  const response = await fetch(STRIPE_API + '/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + secret,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.url) {
    throw new Error(data?.error?.message || 'Stripe could not create the checkout session.');
  }
  return data;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });

  try {
    const token = bearer(req);
    if (!token) return send(res, 401, { error: 'Authentication required.' });

    const user = await supabaseUser(token);
    const input = parseBody(req);
    if (input.terms_accepted !== true) return send(res, 400, { error: 'Terms must be accepted before checkout.' });

    const successUrl = allowedReturnUrl(
      input.success_url,
      'https://alygnn.com/employer-dashboard.html?payment=success'
    );
    const cancelUrl = allowedReturnUrl(
      input.cancel_url,
      'https://alygnn.com/employer-dashboard.html?payment=cancelled'
    );

    let product = String(input.product || '').toLowerCase();
    let plan = String(input.plan || '').toLowerCase();
    let billing = String(input.billing || '').toLowerCase();
    let name = '';
    let cents = 0;
    let mode = 'payment';
    let slots = 0;
    let days = 0;
    let jobId = '';

    // Backward compatibility: the former $150 "single_job" product is now
    // the CURRENT $150 reusable monthly-plan add-on.
    if (!product && plan && plan !== 'single_job') product = 'job_plan';
    if (!product && plan === 'single_job') product = 'additional_slot';
    if (product === 'single_job') product = 'additional_slot';

    if (product === 'additional_slot') {
      const access = await getEmployerPostingAccess(token);

      if (!additionalSlotEligible(access)) {
        return send(res, 400, {
          error: 'The $150 additional reusable slot requires an active monthly Launch, Growth, or Scale plan.'
        });
      }

      plan = String(access.plan || '').toLowerCase();
      billing = 'monthly';
      name = 'Alygnn Additional Reusable Job Slot';
      cents = 15000;
      slots = 1;
      mode = 'payment';

    } else if (product === 'job_boost') {
      jobId = String(input.job_id || '');
      days = Math.max(1, Math.min(30, Number.parseInt(input.days || Math.ceil(Number(input.duration_hours || 24) / 24), 10) || 1));
      if (!jobId) return send(res, 400, { error: 'Job ID is required for Job Boost.' });
      await verifyOwnedActiveJob(token, user.id, jobId);
      name = `Alygnn Job Boost — ${days} day${days === 1 ? '' : 's'}`;
      cents = 1500 * days;
      billing = 'one_time';
      mode = 'payment';
    } else {
      product = 'job_plan';
      if (billing === 'weekly' || plan === 'weekly_slot') {
        billing = 'weekly';
        plan = 'weekly_slot';
      }
      const item = PLAN_CATALOG[billing]?.[plan];
      if (!item) return send(res, 400, { error: 'Unknown Alygnn plan or billing period.' });
      name = item.name;
      cents = item.cents;
      slots = item.slots;
      mode = item.mode;
    }

    const metadata = {
      employer_id: user.id,
      employer_email: user.email || '',
      product,
      plan,
      billing,
      slots: slots || '',
      job_id: jobId,
      days: days || '',
      unit_amount_cents: product === 'job_boost' ? '1500' : cents,
      source: String(input.source || 'website'),
      terms_version: String(input.terms_version || '')
    };

    const params = {
      mode,
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: user.email || undefined,
      'line_items[0][quantity]': 1,
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': cents,
      'line_items[0][price_data][product_data][name]': name,
      'payment_method_types[0]': 'card'
    };

    if (mode === 'subscription') {
      params['line_items[0][price_data][recurring][interval]'] = 'month';
    }

    Object.entries(metadata).forEach(([key, value]) => {
      params[`metadata[${key}]`] = value;
      if (mode === 'subscription') params[`subscription_data[metadata][${key}]`] = value;
      else params[`payment_intent_data[metadata][${key}]`] = value;
    });

    const session = await stripeCreateCheckout(params);
    return send(res, 200, { url: session.url, id: session.id });
  } catch (error) {
    console.error('Alygnn checkout error:', error);
    return send(res, 500, { error: error?.message || 'Could not create checkout.' });
  }
};
