// Vercel Node Function: /api/create-checkout-session
// Alygnn checkout + subscription management in ONE Serverless Function.
// This combined route avoids adding /api/manage-subscription on Vercel Hobby.

const STRIPE_API = 'https://api.stripe.com/v1';

const CHECKOUT_CATALOG = {
  monthly: {
    launch: { name: 'Alygnn Launch', cents: 29900, slots: 3, mode: 'subscription' },
    growth: { name: 'Alygnn Growth', cents: 44900, slots: 5, mode: 'subscription' },
    scale:  { name: 'Alygnn Scale',  cents: 64900, slots: 8, mode: 'subscription' }
  },
  quarterly: {
    launch: { name: 'Alygnn Launch — 3 months', cents: 75000, slots: 3, mode: 'subscription' },
    growth: { name: 'Alygnn Growth — 3 months', cents: 114000, slots: 5, mode: 'subscription' },
    scale:  { name: 'Alygnn Scale — 3 months',  cents: 170000, slots: 8, mode: 'subscription' }
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
  try {
    return JSON.parse(
      Buffer.isBuffer(req.body)
        ? req.body.toString('utf8')
        : String(req.body)
    );
  } catch (_) {
    return {};
  }
}

function bearer(req) {
  const value = String(req.headers.authorization || '');
  return value.toLowerCase().startsWith('bearer ')
    ? value.slice(7).trim()
    : '';
}

function allowedReturnUrl(value, fallback) {
  try {
    const url = new URL(String(value || ''));

    if (
      url.protocol === 'https:' &&
      (
        url.hostname === 'alygnn.com' ||
        url.hostname.endsWith('.alygnn.com')
      )
    ) {
      return url.toString();
    }
  } catch (_) {}

  return fallback;
}

async function supabaseUser(token) {
  const base =
    process.env.SUPABASE_URL ||
    'https://auth.alygnn.com';

  const anon =
    process.env.SUPABASE_ANON_KEY;

  if (!anon) {
    throw new Error(
      'SUPABASE_ANON_KEY is not configured.'
    );
  }

  const response =
    await fetch(
      base.replace(/\/$/, '') + '/auth/v1/user',
      {
        headers: {
          apikey: anon,
          Authorization: 'Bearer ' + token
        }
      }
    );

  const data =
    await response
      .json()
      .catch(() => ({}));

  if (!response.ok || !data?.id) {
    throw new Error(
      'Invalid employer session.'
    );
  }

  return data;
}

async function verifyOwnedActiveJob(
  token,
  userId,
  jobId
) {
  const base =
    process.env.SUPABASE_URL ||
    'https://auth.alygnn.com';

  const anon =
    process.env.SUPABASE_ANON_KEY;

  const url =
    new URL(
      base.replace(/\/$/, '') +
      '/rest/v1/jobs'
    );

  url.searchParams.set(
    'id',
    'eq.' + jobId
  );

  url.searchParams.set(
    'employer_id',
    'eq.' + userId
  );

  url.searchParams.set(
    'select',
    'id,status'
  );

  url.searchParams.set(
    'limit',
    '1'
  );

  const response =
    await fetch(
      url,
      {
        headers: {
          apikey: anon,
          Authorization:
            'Bearer ' + token
        }
      }
    );

  const rows =
    await response
      .json()
      .catch(() => []);

  if (
    !response.ok ||
    !Array.isArray(rows) ||
    !rows[0]
  ) {
    throw new Error(
      'The selected job could not be verified.'
    );
  }

  if (
    String(
      rows[0].status || ''
    ).toLowerCase() !== 'active'
  ) {
    throw new Error(
      'Only active jobs can be boosted.'
    );
  }

  return rows[0];
}

async function getEmployerPostingAccess(
  token
) {
  const base =
    (
      process.env.SUPABASE_URL ||
      'https://auth.alygnn.com'
    ).replace(/\/$/, '');

  const anon =
    process.env.SUPABASE_ANON_KEY;

  if (!anon) {
    throw new Error(
      'SUPABASE_ANON_KEY is not configured.'
    );
  }

  const response =
    await fetch(
      base +
      '/rest/v1/rpc/get_employer_posting_access',
      {
        method: 'POST',

        headers: {
          apikey: anon,

          Authorization:
            'Bearer ' + token,

          'Content-Type':
            'application/json'
        },

        body: '{}'
      }
    );

  const data =
    await response
      .json()
      .catch(() => null);

  if (!response.ok) {
    throw new Error(
      (
        data &&
        (
          data.message ||
          data.error
        )
      ) ||
      'Could not verify employer hiring capacity.'
    );
  }

  return data || {};
}

function additionalSlotEligible(
  access
) {
  // The $150/month Second Job Slot is FREE-ACCOUNT ONLY and can exist only once.
  // The database RPC is the source of truth so direct checkout URLs cannot bypass it.

  return (
    access?.second_slot_eligible === true &&
    access?.active_paid_plan !== true &&
    Number(
      access?.addon_slot_count || 0
    ) < 1
  );
}

async function stripeCreateCheckout(
  params
) {
  const secret =
    process.env.STRIPE_SECRET_KEY;

  if (!secret) {
    throw new Error(
      'STRIPE_SECRET_KEY is not configured.'
    );
  }

  const body =
    new URLSearchParams();

  for (
    const [key, value]
    of Object.entries(params)
  ) {
    if (
      value === undefined ||
      value === null ||
      value === ''
    ) {
      continue;
    }

    body.append(
      key,
      String(value)
    );
  }

  const response =
    await fetch(
      STRIPE_API +
      '/checkout/sessions',
      {
        method: 'POST',

        headers: {
          Authorization:
            'Bearer ' + secret,

          'Content-Type':
            'application/x-www-form-urlencoded'
        },

        body
      }
    );

  const data =
    await response
      .json()
      .catch(() => ({}));

  if (
    !response.ok ||
    !data?.url
  ) {
    throw new Error(
      data?.error?.message ||
      'Stripe could not create the checkout session.'
    );
  }

  return data;
}

const MANAGE_CATALOG = {
  monthly: {
    launch: {
      name: 'Alygnn Launch',
      cents: 29900,
      slots: 3,
      rank: 1,
      lookup: 'alygnn_launch_monthly',
      interval: 'month',
      intervalCount: 1
    },

    growth: {
      name: 'Alygnn Growth',
      cents: 44900,
      slots: 5,
      rank: 2,
      lookup: 'alygnn_growth_monthly',
      interval: 'month',
      intervalCount: 1
    },

    scale: {
      name: 'Alygnn Scale',
      cents: 64900,
      slots: 8,
      rank: 3,
      lookup: 'alygnn_scale_monthly',
      interval: 'month',
      intervalCount: 1
    }
  },

  quarterly: {
    launch: {
      name: 'Alygnn Launch — 3 months',
      cents: 75000,
      slots: 3,
      rank: 1,
      lookup: 'alygnn_launch_quarterly',
      interval: 'month',
      intervalCount: 3
    },

    growth: {
      name: 'Alygnn Growth — 3 months',
      cents: 114000,
      slots: 5,
      rank: 2,
      lookup: 'alygnn_growth_quarterly',
      interval: 'month',
      intervalCount: 3
    },

    scale: {
      name: 'Alygnn Scale — 3 months',
      cents: 170000,
      slots: 8,
      rank: 3,
      lookup: 'alygnn_scale_quarterly',
      interval: 'month',
      intervalCount: 3
    }
  }
};

function manageCors(res) {
  res.setHeader(
    'Access-Control-Allow-Origin',
    '*'
  );

  res.setHeader(
    'Access-Control-Allow-Methods',
    'POST,OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization,Content-Type'
  );
}

function manageSend(
  res,
  status,
  payload
) {
  manageCors(res);

  res.statusCode =
    status;

  res.setHeader(
    'Content-Type',
    'application/json; charset=utf-8'
  );

  res.end(
    JSON.stringify(payload)
  );
}

function manageBody(req) {
  if (!req.body) {
    return {};
  }

  if (
    typeof req.body === 'object' &&
    !Buffer.isBuffer(req.body)
  ) {
    return req.body;
  }

  try {
    return JSON.parse(
      Buffer.isBuffer(req.body)
        ? req.body.toString('utf8')
        : String(req.body)
    );
  } catch (_) {
    return {};
  }
}

function manageBearer(req) {
  const value =
    String(
      req.headers.authorization ||
      ''
    );

  return value
    .toLowerCase()
    .startsWith('bearer ')
      ? value.slice(7).trim()
      : '';
}

function manageBase() {
  return (
    process.env.SUPABASE_URL ||
    'https://auth.alygnn.com'
  ).replace(/\/$/, '');
}

function manageServiceHeaders(
  extra = {}
) {
  const key =
    process.env
      .SUPABASE_SERVICE_ROLE_KEY;

  if (!key) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not configured.'
    );
  }

  return {
    apikey: key,

    Authorization:
      'Bearer ' + key,

    'Content-Type':
      'application/json',

    ...extra
  };
}

async function manageCurrentUser(
  token
) {
  const anon =
    process.env.SUPABASE_ANON_KEY;

  if (!anon) {
    throw new Error(
      'SUPABASE_ANON_KEY is not configured.'
    );
  }

  const response =
    await fetch(
      manageBase() +
      '/auth/v1/user',
      {
        headers: {
          apikey: anon,

          Authorization:
            'Bearer ' + token
        }
      }
    );

  const data =
    await response
      .json()
      .catch(() => ({}));

  if (
    !response.ok ||
    !data?.id
  ) {
    const error =
      new Error(
        'Invalid employer session.'
      );

    error.status = 401;

    throw error;
  }

  return data;
}

async function getEntitlement(
  employerId
) {
  const url =
    new URL(
      manageBase() +
      '/rest/v1/employer_entitlements'
    );

  url.searchParams.set(
    'employer_id',
    'eq.' + employerId
  );

  url.searchParams.set(
    'select',
    '*'
  );

  url.searchParams.set(
    'limit',
    '1'
  );

  const response =
    await fetch(
      url,
      {
        headers:
          manageServiceHeaders()
      }
    );

  const rows =
    await response
      .json()
      .catch(() => []);

  if (!response.ok) {
    throw new Error(
      rows?.message ||
      'Could not load billing entitlement.'
    );
  }

  return Array.isArray(rows)
    ? rows[0] || {}
    : {};
}

async function patchEntitlement(
  employerId,
  patch
) {
  const url =
    new URL(
      manageBase() +
      '/rest/v1/employer_entitlements'
    );

  url.searchParams.set(
    'employer_id',
    'eq.' + employerId
  );

  const response =
    await fetch(
      url,
      {
        method: 'PATCH',

        headers:
          manageServiceHeaders({
            Prefer:
              'return=minimal'
          }),

        body:
          JSON.stringify({
            ...patch,

            plan_change_updated_at:
              new Date().toISOString(),

            updated_at:
              new Date().toISOString()
          })
      }
    );

  if (!response.ok) {
    throw new Error(
      'Could not save billing state: ' +
      await response.text()
    );
  }
}

function exactPlan(ent) {
  const exact =
    String(
      ent?.test_plan || ''
    ).toLowerCase();

  if (
    [
      'launch',
      'growth',
      'scale'
    ].includes(exact)
  ) {
    return exact;
  }

  const legacy =
    String(
      ent?.plan || ''
    ).toLowerCase();

  if (
    legacy === 'business'
  ) {
    return 'launch';
  }

  if (
    legacy === 'enterprise'
  ) {
    return Number(
      ent?.slot_limit || 0
    ) >= 8
      ? 'scale'
      : 'growth';
  }

  return [
    'launch',
    'growth',
    'scale'
  ].includes(legacy)
    ? legacy
    : 'free';
}

function billingPeriod(ent) {
  const billing =
    String(
      ent?.billing_period || ''
    ).toLowerCase();

  return [
    'monthly',
    'quarterly'
  ].includes(billing)
    ? billing
    : billing || 'free';
}

function recurringPlan(ent) {
  const billing =
    billingPeriod(ent);

  const plan =
    exactPlan(ent);

  return (
    MANAGE_CATALOG[billing]?.[plan] ||
    null
  );
}

function entitlementLooksActive(
  ent
) {
  const status =
    String(
      ent?.subscription_status || ''
    ).toLowerCase();

  const end =
    ent?.current_period_end
      ? new Date(
          ent.current_period_end
        ).getTime()
      : Infinity;

  if (
    status === 'past_due'
  ) {
    return !!recurringPlan(ent);
  }

  return (
    [
      'active',
      'trialing'
    ].includes(status) &&
    !!recurringPlan(ent) &&
    end > Date.now()
  );
}

function shouldResolveSubscription(
  ent
) {
  const stored =
    String(
      ent?.stripe_plan_subscription_id ||
      ''
    ).trim();

  if (stored) {
    return true;
  }

  // Developer test plans are real Supabase entitlements but intentionally have
  // no Stripe subscription. Do not make a Stripe request just to display them.

  if (
    ent?.test_mode === true
  ) {
    return false;
  }

  const status =
    String(
      ent?.subscription_status || ''
    ).toLowerCase();

  return (
    [
      'active',
      'trialing',
      'past_due'
    ].includes(status) &&
    !!recurringPlan(ent)
  );
}

function subscriptionIsActive(
  sub
) {
  if (!sub) {
    return false;
  }

  const status =
    String(
      sub.status || ''
    ).toLowerCase();

  const end =
    sub.current_period_end
      ? Number(
          sub.current_period_end
        ) * 1000
      : Infinity;

  if (
    status === 'past_due'
  ) {
    return true;
  }

  return (
    [
      'active',
      'trialing'
    ].includes(status) &&
    end > Date.now()
  );
}

function subscriptionPlan(
  ent,
  sub
) {
  const fromStripe =
    String(
      sub?.metadata?.plan || ''
    ).toLowerCase();

  return [
    'launch',
    'growth',
    'scale'
  ].includes(fromStripe)
    ? fromStripe
    : exactPlan(ent);
}

function subscriptionBilling(
  ent,
  sub
) {
  const fromStripe =
    String(
      sub?.metadata?.billing || ''
    ).toLowerCase();

  return [
    'monthly',
    'quarterly'
  ].includes(fromStripe)
    ? fromStripe
    : billingPeriod(ent);
}

async function manageStripe(
  method,
  path,
  params
) {
  const secret =
    process.env.STRIPE_SECRET_KEY;

  if (!secret) {
    throw new Error(
      'STRIPE_SECRET_KEY is not configured.'
    );
  }

  let url =
    STRIPE_API +
    '/' +
    String(path)
      .replace(/^\//, '');

  const options = {
    method,

    headers: {
      Authorization:
        'Bearer ' + secret
    }
  };

  if (
    method === 'GET'
  ) {
    const parsed =
      new URL(url);

    Object.entries(
      params || {}
    ).forEach(
      ([key, value]) => {
        if (
          value !== undefined &&
          value !== null &&
          value !== ''
        ) {
          parsed.searchParams.append(
            key,
            String(value)
          );
        }
      }
    );

    url =
      parsed.toString();

  } else {
    const form =
      new URLSearchParams();

    Object.entries(
      params || {}
    ).forEach(
      ([key, value]) => {
        if (
          value !== undefined &&
          value !== null &&
          value !== ''
        ) {
          form.append(
            key,
            String(value)
          );
        }
      }
    );

    options.headers[
      'Content-Type'
    ] =
      'application/x-www-form-urlencoded';

    options.body =
      form;
  }

  const response =
    await fetch(
      url,
      options
    );

  const data =
    await response
      .json()
      .catch(() => ({}));

  if (!response.ok) {
    const error =
      new Error(
        data?.error?.message ||
        'Stripe request failed.'
      );

    error.status =
      response.status;

    error.stripe =
      data?.error || null;

    throw error;
  }

  return data;
}

async function ensureRecurringPrice(
  plan,
  billing
) {
  const config =
    MANAGE_CATALOG[
      billing
    ]?.[plan];

  if (!config) {
    throw new Error(
      'Unknown recurring plan.'
    );
  }

  const envKey =
    `STRIPE_PRICE_${plan.toUpperCase()}_${billing.toUpperCase()}`;

  if (
    process.env[envKey]
  ) {
    return process.env[envKey];
  }

  const listed =
    await manageStripe(
      'GET',
      'prices',
      {
        'lookup_keys[]':
          config.lookup,

        active:
          'true',

        limit:
          1
      }
    );

  if (
    listed?.data?.[0]?.id
  ) {
    return listed.data[0].id;
  }

  const created =
    await manageStripe(
      'POST',
      'prices',
      {
        currency:
          'usd',

        unit_amount:
          config.cents,

        lookup_key:
          config.lookup,

        'recurring[interval]':
          config.interval,

        'recurring[interval_count]':
          config.intervalCount,

        'product_data[name]':
          config.name,

        'metadata[alygnn_plan]':
          plan,

        'metadata[billing]':
          billing
      }
    );

  return created.id;
}

async function searchPlanSubscription(
  employerId
) {
  const query =
    `metadata["employer_id"]:"${employerId}" AND metadata["product"]:"job_plan"`;

  const found =
    await manageStripe(
      'GET',
      'subscriptions/search',
      {
        query,
        limit: 20
      }
    );

  const rows =
    (
      found?.data || []
    )
      .filter(
        sub =>
          ![
            'canceled',
            'incomplete_expired'
          ].includes(
            String(
              sub.status || ''
            )
          )
      );

  rows.sort(
    (a, b) =>
      (b.created || 0) -
      (a.created || 0)
  );

  return rows[0] || null;
}

async function resolveSubscription(
  employerId,
  ent
) {
  let sub = null;

  const stored =
    String(
      ent?.stripe_plan_subscription_id ||
      ''
    ).trim();

  if (stored) {
    try {
      sub =
        await manageStripe(
          'GET',
          'subscriptions/' +
          encodeURIComponent(stored)
        );
    } catch (_) {}
  }

  if (!sub) {
    sub =
      await searchPlanSubscription(
        employerId
      );
  }

  if (sub) {
    await patchEntitlement(
      employerId,
      {
        stripe_plan_subscription_id:
          sub.id,

        stripe_plan_customer_id:
          typeof sub.customer ===
          'string'
            ? sub.customer
            : sub.customer?.id ||
              null,

        stripe_plan_schedule_id:
          typeof sub.schedule ===
          'string'
            ? sub.schedule
            : sub.schedule?.id ||
              null
      }
    );
  }

  return sub;
}

function subscriptionSummary(
  ent,
  sub
) {
  const rawPlan =
    subscriptionPlan(
      ent,
      sub
    );

  const rawBilling =
    subscriptionBilling(
      ent,
      sub
    );

  const status =
    String(
      sub?.status ||
      ent?.subscription_status ||
      'free'
    ).toLowerCase();

  const terminal =
    [
      'canceled',
      'unpaid',
      'incomplete_expired',
      'inactive'
    ].includes(status);

  const plan =
    terminal
      ? 'free'
      : rawPlan;

  const billing =
    terminal
      ? 'free'
      : rawBilling;

  const config =
    terminal
      ? null
      : (
          MANAGE_CATALOG[
            billing
          ]?.[plan] ||
          null
        );

  const endUnix =
    sub?.current_period_end ||
    null;

  return {
    current_plan:
      plan,

    billing_period:
      billing,

    subscription_status:
      status,

    current_period_end:
      endUnix
        ? new Date(
            endUnix * 1000
          ).toISOString()
        : (
            ent?.current_period_end ||
            null
          ),

    amount_cents:
      config?.cents ?? 0,

    slot_limit:
      config
        ? Number(
            config.slots || 0
          ) + 1
        : 1,

    plan_slot_limit:
      config?.slots ?? 0,

    included_free_slot_count:
      1,

    pending_plan:
      ent?.pending_plan ||
      null,

    pending_billing_period:
      ent?.pending_billing_period ||
      null,

    pending_plan_effective_at:
      ent?.pending_plan_effective_at ||
      null,

    cancel_at_period_end:
      !terminal &&
      (
        sub?.cancel_at_period_end ===
          true ||

        (
          String(
            ent?.pending_plan || ''
          ).toLowerCase() ===
            'free' &&

          !!ent
            ?.pending_plan_effective_at
        )
      ),

    cancel_effective_at:
      !terminal &&
      sub?.cancel_at_period_end ===
        true &&
      sub?.current_period_end

        ? new Date(
            Number(
              sub.current_period_end
            ) * 1000
          ).toISOString()

        : (
            !terminal &&
            String(
              ent?.pending_plan || ''
            ).toLowerCase() ===
              'free'

              ? ent
                  ?.pending_plan_effective_at ||
                null

              : null
          ),

    stripe_subscription_id:
      sub?.id ||
      ent
        ?.stripe_plan_subscription_id ||
      null,

    managed_subscription:
      !!sub,

    test_mode:
      ent?.test_mode === true
  };
}

async function searchSubscriptionByProduct(
  employerId,
  product
) {
  const query =
    `metadata["employer_id"]:"${employerId}" AND metadata["product"]:"${product}"`;

  const found =
    await manageStripe(
      'GET',
      'subscriptions/search',
      {
        query,
        limit: 20
      }
    );

  const rows =
    (
      found?.data || []
    )
      .filter(
        row =>
          ![
            'canceled',
            'incomplete_expired'
          ].includes(
            String(
              row.status || ''
            )
          )
      );

  rows.sort(
    (a, b) =>
      (b.created || 0) -
      (a.created || 0)
  );

  return rows[0] || null;
}

async function resolveSecondSlotSubscription(
  employerId
) {
  let sub =
    await searchSubscriptionByProduct(
      employerId,
      'additional_slot'
    );

  if (!sub) {
    sub =
      await searchSubscriptionByProduct(
        employerId,
        'single_job'
      );
  }

  return sub;
}

function secondSlotSummary(
  sub
) {
  if (!sub) {
    return {
      managed_subscription:
        false,

      subscription_status:
        null,

      current_period_end:
        null,

      cancel_at_period_end:
        false,

      cancel_effective_at:
        null
    };
  }

  return {
    managed_subscription:
      true,

    subscription_status:
      String(
        sub.status || ''
      ).toLowerCase(),

    current_period_end:
      sub.current_period_end
        ? new Date(
            Number(
              sub.current_period_end
            ) * 1000
          ).toISOString()
        : null,

    cancel_at_period_end:
      sub.cancel_at_period_end ===
      true,

    cancel_effective_at:
      sub.cancel_at_period_end ===
        true &&
      sub.current_period_end

        ? new Date(
            Number(
              sub.current_period_end
            ) * 1000
          ).toISOString()

        : null,

    stripe_subscription_id:
      sub.id || null
  };
}

async function cancelPlanAtRenewal({
  employerId,
  ent,
  sub
}) {
  const effectiveIso =
    sub?.current_period_end

      ? new Date(
          Number(
            sub.current_period_end
          ) * 1000
        ).toISOString()

      : (
          ent?.current_period_end ||
          null
        );

  if (
    sub &&
    subscriptionIsActive(sub)
  ) {
    // A scheduled downgrade and a scheduled cancellation should never coexist.

    await releaseSchedule(
      sub,
      ent
    );

    const updated =
      await manageStripe(
        'POST',
        'subscriptions/' +
        encodeURIComponent(
          sub.id
        ),
        {
          cancel_at_period_end:
            'true'
        }
      );

    const endIso =
      updated.current_period_end

        ? new Date(
            Number(
              updated.current_period_end
            ) * 1000
          ).toISOString()

        : effectiveIso;

    await patchEntitlement(
      employerId,
      {
        stripe_plan_schedule_id:
          null,

        pending_plan:
          null,

        pending_billing_period:
          null,

        pending_plan_effective_at:
          null
      }
    );

    return {
      change:
        'cancellation_scheduled',

      effective_at:
        endIso,

      cancel_at_period_end:
        true
    };
  }

  // Developer test plans are prepaid test terms rather than Stripe subscriptions.
  // Scheduling "free" lets the app demonstrate the same cancel-at-renewal UX.

  if (
    ent?.test_mode === true &&
    recurringPlan(ent) &&
    entitlementLooksActive(ent)
  ) {
    if (!effectiveIso) {
      throw new Error(
        'Could not determine when this test plan ends.'
      );
    }

    await patchEntitlement(
      employerId,
      {
        stripe_plan_schedule_id:
          null,

        pending_plan:
          'free',

        pending_billing_period:
          'free',

        pending_plan_effective_at:
          effectiveIso
      }
    );

    return {
      change:
        'cancellation_scheduled',

      effective_at:
        effectiveIso,

      cancel_at_period_end:
        true,

      test_mode:
        true
    };
  }

  const error =
    new Error(
      'This plan is already prepaid without automatic renewal, so there is no future charge to cancel.'
    );

  error.status =
    409;

  throw error;
}

async function resumePlanRenewal({
  employerId,
  ent,
  sub
}) {
  if (
    sub &&
    sub.cancel_at_period_end ===
      true
  ) {
    await manageStripe(
      'POST',
      'subscriptions/' +
      encodeURIComponent(
        sub.id
      ),
      {
        cancel_at_period_end:
          'false'
      }
    );
  }

  await patchEntitlement(
    employerId,
    {
      pending_plan:
        null,

      pending_billing_period:
        null,

      pending_plan_effective_at:
        null
    }
  );

  return {
    change:
      'cancellation_reversed',

    cancel_at_period_end:
      false
  };
}

async function cancelSecondSlotAtRenewal({
  sub
}) {
  if (
    !sub ||
    !subscriptionIsActive(sub)
  ) {
    const error =
      new Error(
        'The Second Job Slot does not have an active recurring subscription to cancel.'
      );

    error.status =
      409;

    throw error;
  }

  const updated =
    await manageStripe(
      'POST',
      'subscriptions/' +
      encodeURIComponent(
        sub.id
      ),
      {
        cancel_at_period_end:
          'true'
      }
    );

  return {
    change:
      'second_slot_cancellation_scheduled',

    effective_at:
      updated.current_period_end
        ? new Date(
            Number(
              updated.current_period_end
            ) * 1000
          ).toISOString()
        : null,

    cancel_at_period_end:
      true
  };
}

async function resumeSecondSlotRenewal({
  sub
}) {
  if (!sub) {
    const error =
      new Error(
        'Second Job Slot subscription could not be found.'
      );

    error.status =
      409;

    throw error;
  }

  await manageStripe(
    'POST',
    'subscriptions/' +
    encodeURIComponent(
      sub.id
    ),
    {
      cancel_at_period_end:
        'false'
    }
  );

  return {
    change:
      'second_slot_cancellation_reversed',

    cancel_at_period_end:
      false
  };
}

async function releaseSchedule(
  sub,
  ent
) {
  const scheduleId =
    (
      typeof sub?.schedule ===
      'string'
        ? sub.schedule
        : sub?.schedule?.id
    ) ||
    ent?.stripe_plan_schedule_id;

  if (!scheduleId) {
    return;
  }

  try {
    await manageStripe(
      'POST',
      'subscription_schedules/' +
      encodeURIComponent(
        scheduleId
      ) +
      '/release',
      {}
    );
  } catch (error) {
    if (
      !/released|completed|not found|no such subscription schedule/i.test(
        error.message || ''
      )
    ) {
      throw error;
    }
  }
}

async function scheduleDowngrade({
  employerId,
  ent,
  sub,
  currentPlan,
  targetPlan,
  billing,
  currentBilling = billing
}) {
  if (
    sub?.cancel_at_period_end ===
    true
  ) {
    sub =
      await manageStripe(
        'POST',
        'subscriptions/' +
        encodeURIComponent(
          sub.id
        ),
        {
          cancel_at_period_end:
            'false'
        }
      );
  }

  const item =
    sub?.items?.data?.[0];

  const currentPriceId =
    typeof item?.price ===
    'string'
      ? item.price
      : item?.price?.id;

  if (
    !item?.id ||
    !currentPriceId
  ) {
    throw new Error(
      'Stripe subscription item could not be identified.'
    );
  }

  const targetPrice =
    await ensureRecurringPrice(
      targetPlan,
      billing
    );

  let scheduleId =
    (
      typeof sub.schedule ===
      'string'
        ? sub.schedule
        : sub.schedule?.id
    ) ||
    ent?.stripe_plan_schedule_id ||
    null;

  let schedule =
    null;

  if (scheduleId) {
    schedule =
      await manageStripe(
        'GET',
        'subscription_schedules/' +
        encodeURIComponent(
          scheduleId
        )
      );

  } else {
    schedule =
      await manageStripe(
        'POST',
        'subscription_schedules',
        {
          from_subscription:
            sub.id
        }
      );

    scheduleId =
      schedule.id;
  }

  const now =
    Math.floor(
      Date.now() / 1000
    );

  const phase =
    (
      schedule?.phases || []
    ).find(
      phase =>
        phase.start_date <= now &&
        phase.end_date > now
    ) ||
    (
      schedule?.phases || []
    )[0];

  const start =
    phase?.start_date ||
    sub.current_period_start;

  const end =
    phase?.end_date ||
    sub.current_period_end;

  if (
    !start ||
    !end
  ) {
    throw new Error(
      'Could not determine the current billing-period boundary.'
    );
  }

  const phasePrice =
    typeof phase
      ?.items?.[0]?.price ===
    'string'

      ? phase.items[0].price

      : phase
          ?.items?.[0]
          ?.price?.id;

  const currentPrice =
    phasePrice ||
    currentPriceId;

  const currentQty =
    phase
      ?.items?.[0]
      ?.quantity ||
    item.quantity ||
    1;

  const intervalCount =
    MANAGE_CATALOG[
      billing
    ][targetPlan]
      .intervalCount;

  await manageStripe(
    'POST',
    'subscription_schedules/' +
    encodeURIComponent(
      scheduleId
    ),
    {
      end_behavior:
        'release',

      'phases[0][start_date]':
        start,

      'phases[0][end_date]':
        end,

      'phases[0][items][0][price]':
        currentPrice,

      'phases[0][items][0][quantity]':
        currentQty,

      'phases[0][proration_behavior]':
        'none',

      'phases[0][metadata][employer_id]':
        employerId,

      'phases[0][metadata][product]':
        'job_plan',

      'phases[0][metadata][plan]':
        currentPlan,

      'phases[0][metadata][billing]':
        currentBilling,

      'phases[1][start_date]':
        end,

      'phases[1][duration][interval]':
        'month',

      'phases[1][duration][interval_count]':
        intervalCount,

      'phases[1][items][0][price]':
        targetPrice,

      'phases[1][items][0][quantity]':
        1,

      'phases[1][proration_behavior]':
        'none',

      'phases[1][metadata][employer_id]':
        employerId,

      'phases[1][metadata][product]':
        'job_plan',

      'phases[1][metadata][plan]':
        targetPlan,

      'phases[1][metadata][billing]':
        billing
    }
  );

  await patchEntitlement(
    employerId,
    {
      stripe_plan_schedule_id:
        scheduleId,

      pending_plan:
        targetPlan,

      pending_billing_period:
        billing,

      pending_plan_effective_at:
        new Date(
          end * 1000
        ).toISOString()
    }
  );

  return {
    change:
      'downgrade_scheduled',

    effective_at:
      new Date(
        end * 1000
      ).toISOString(),

    schedule_id:
      scheduleId,

    billing_period:
      billing
  };
}

function planLegacyName(plan) {
  return plan === 'launch'
    ? 'business'
    : 'enterprise';
}

async function applyPaidFixedUpgrade({
  employerId,
  sub,
  targetPlan,
  billing,
  targetPrice
}) {
  const item =
    sub?.items?.data?.[0];

  if (!item?.id) {
    throw new Error(
      'Stripe subscription item could not be identified.'
    );
  }

  const updated =
    await manageStripe(
      'POST',
      'subscriptions/' +
      encodeURIComponent(
        sub.id
      ),
      {
        cancel_at_period_end:
          'false',

        'items[0][id]':
          item.id,

        'items[0][price]':
          targetPrice,

        'items[0][quantity]':
          1,

        proration_behavior:
          'none',

        'metadata[employer_id]':
          employerId,

        'metadata[product]':
          'job_plan',

        'metadata[plan]':
          targetPlan,

        'metadata[billing]':
          billing
      }
    );

  const catalog =
    MANAGE_CATALOG[
      billing
    ]?.[targetPlan];

  await patchEntitlement(
    employerId,
    {
      plan:
        planLegacyName(
          targetPlan
        ),

      test_plan:
        targetPlan,

      test_mode:
        false,

      subscription_status:
        String(
          updated.status ||
          'active'
        ).toLowerCase(),

      current_period_end:
        updated.current_period_end

          ? new Date(
              Number(
                updated.current_period_end
              ) * 1000
            ).toISOString()

          : null,

      slot_limit:
        catalog?.slots ||
        null,

      billing_period:
        billing,

      urgently_hiring:
        [
          'growth',
          'scale'
        ].includes(
          targetPlan
        ),

      alygnn_recommended:
        [
          'growth',
          'scale'
        ].includes(
          targetPlan
        ),

      plan_amount_cents:
        catalog?.cents ||
        null,

      stripe_plan_subscription_id:
        updated.id,

      stripe_plan_customer_id:
        typeof updated.customer ===
        'string'

          ? updated.customer

          : updated.customer?.id ||
            null,

      stripe_plan_schedule_id:
        null,

      pending_plan:
        null,

      pending_billing_period:
        null,

      pending_plan_effective_at:
        null
    }
  );

  return updated;
}

async function upgradeNow({
  employerId,
  ent,
  sub,
  targetPlan,
  billing
}) {
  const item =
    sub?.items?.data?.[0];

  if (!item?.id) {
    throw new Error(
      'Stripe subscription item could not be identified.'
    );
  }

  const currentPlan =
    subscriptionPlan(
      ent,
      sub
    );

  const currentCatalog =
    MANAGE_CATALOG[
      billing
    ]?.[currentPlan];

  const targetCatalog =
    MANAGE_CATALOG[
      billing
    ]?.[targetPlan];

  if (
    !currentCatalog ||
    !targetCatalog
  ) {
    throw new Error(
      'Could not calculate the plan upgrade price.'
    );
  }

  const difference =
    Math.max(
      0,

      Number(
        targetCatalog.cents
      ) -
      Number(
        currentCatalog.cents
      )
    );

  if (
    difference <= 0
  ) {
    throw new Error(
      'This plan change is not an upgrade.'
    );
  }

  const customerId =
    stripeCustomerId(
      sub,
      ent
    );

  if (!customerId) {
    throw new Error(
      'Stripe customer could not be identified.'
    );
  }

  // Keep the current plan in place until the fixed-difference upgrade invoice is paid.

  await releaseSchedule(
    sub,
    ent
  );

  if (
    sub?.cancel_at_period_end ===
    true
  ) {
    sub =
      await manageStripe(
        'POST',
        'subscriptions/' +
        encodeURIComponent(
          sub.id
        ),
        {
          cancel_at_period_end:
            'false'
        }
      );
  }

  const targetPrice =
    await ensureRecurringPrice(
      targetPlan,
      billing
    );

  // Alygnn uses a SIMPLE FIXED-DIFFERENCE upgrade model, not time-based proration.
  // Example: Launch $299 -> Growth $449 = $150 charged now, regardless of days left.

  const invoice =
    await manageStripe(
      'POST',
      'invoices',
      {
        customer:
          customerId,

        collection_method:
          'charge_automatically',

        auto_advance:
          'false',

        'metadata[employer_id]':
          employerId,

        'metadata[product]':
          'plan_upgrade',

        'metadata[current_plan]':
          currentPlan,

        'metadata[target_plan]':
          targetPlan,

        'metadata[billing]':
          billing,

        'metadata[subscription_id]':
          sub.id,

        'metadata[target_price_id]':
          targetPrice,

        'metadata[fixed_difference_cents]':
          difference
      }
    );

  await manageStripe(
    'POST',
    'invoiceitems',
    {
      customer:
        customerId,

      invoice:
        invoice.id,

      amount:
        difference,

      currency:
        'usd',

      description:
        `Alygnn ${currentCatalog.name} -> ${targetCatalog.name} upgrade`,

      'metadata[employer_id]':
        employerId,

      'metadata[product]':
        'plan_upgrade',

      'metadata[target_plan]':
        targetPlan
    }
  );

  let finalized =
    await manageStripe(
      'POST',
      'invoices/' +
      encodeURIComponent(
        invoice.id
      ) +
      '/finalize',
      {
        auto_advance:
          'true'
      }
    );

  try {
    finalized =
      await manageStripe(
        'POST',
        'invoices/' +
        encodeURIComponent(
          invoice.id
        ) +
        '/pay',
        {}
      );

  } catch (error) {
    try {
      finalized =
        await manageStripe(
          'GET',
          'invoices/' +
          encodeURIComponent(
            invoice.id
          ),
          {
            'expand[]':
              'payment_intent'
          }
        );
    } catch (_) {}
  }

  if (
    String(
      finalized?.status ||
      ''
    ).toLowerCase() ===
    'paid'
  ) {
    const updated =
      await applyPaidFixedUpgrade({
        employerId,
        sub,
        targetPlan,
        billing,
        targetPrice
      });

    return {
      change:
        'upgrade_completed',

      effective:
        'immediate',

      fixed_difference_cents:
        difference,

      amount_due_cents:
        finalized.amount_due ??
        difference,

      amount_paid_cents:
        finalized.amount_paid ??
        difference,

      hosted_invoice_url:
        finalized
          .hosted_invoice_url ||
        null,

      payment_status:
        'paid',

      billing_period:
        billing,

      next_renewal_plan:
        targetPlan,

      next_renewal_amount_cents:
        targetCatalog.cents,

      subscription_status:
        String(
          updated.status ||
          'active'
        ).toLowerCase()
    };
  }

  return {
    change:
      'upgrade_payment_required',

    effective:
      'after_payment',

    fixed_difference_cents:
      difference,

    amount_due_cents:
      finalized?.amount_due ??
      difference,

    amount_paid_cents:
      finalized?.amount_paid ??
      0,

    hosted_invoice_url:
      finalized
        ?.hosted_invoice_url ||
      null,

    payment_intent_status:
      finalized
        ?.payment_intent
        ?.status ||
      null,

    payment_status:
      finalized?.status ||
      'open',

    billing_period:
      billing,

    current_plan:
      currentPlan,

    target_plan:
      targetPlan,

    next_renewal_amount_cents:
      targetCatalog.cents
  };
}

function stripeCustomerId(
  sub,
  ent
) {
  return (
    (
      typeof sub?.customer ===
      'string'
        ? sub.customer
        : sub?.customer?.id
    ) ||

    ent?.stripe_plan_customer_id ||

    null
  );
}

function normalizePaymentMethod(
  paymentMethod
) {
  if (
    !paymentMethod ||
    typeof paymentMethod !==
    'object'
  ) {
    return null;
  }

  if (
    paymentMethod.type ===
    'card' &&
    paymentMethod.card
  ) {
    return {
      type:
        'card',

      brand:
        String(
          paymentMethod.card.brand ||
          'card'
        ).toLowerCase(),

      last4:
        String(
          paymentMethod.card.last4 ||
          ''
        ),

      exp_month:
        Number(
          paymentMethod.card
            .exp_month ||
          0
        ) || null,

      exp_year:
        Number(
          paymentMethod.card
            .exp_year ||
          0
        ) || null
    };
  }

  return {
    type:
      String(
        paymentMethod.type ||
        'payment_method'
      ),

    brand:
      String(
        paymentMethod.type ||
        'payment method'
      ),

    last4:
      '',

    exp_month:
      null,

    exp_year:
      null
  };
}

async function customerSnapshot(
  customerId,
  sub
) {
  if (!customerId) {
    return {
      customer_id:
        null,

      email:
        null,

      payment_method:
        null,

      invoices:
        []
    };
  }

  let customer =
    null;

  try {
    customer =
      await manageStripe(
        'GET',
        'customers/' +
        encodeURIComponent(
          customerId
        ),
        {
          'expand[]':
            'invoice_settings.default_payment_method'
        }
      );

  } catch (error) {
    console.warn(
      'Could not load Stripe customer:',
      error?.message ||
      error
    );
  }

  let paymentMethod =
    customer
      ?.invoice_settings
      ?.default_payment_method ||

    sub?.default_payment_method ||

    null;

  if (
    typeof paymentMethod ===
    'string'
  ) {
    try {
      paymentMethod =
        await manageStripe(
          'GET',
          'payment_methods/' +
          encodeURIComponent(
            paymentMethod
          )
        );

    } catch (error) {
      console.warn(
        'Could not load Stripe payment method:',
        error?.message ||
        error
      );

      paymentMethod =
        null;
    }
  }

  let invoices =
    [];

  try {
    const result =
      await manageStripe(
        'GET',
        'invoices',
        {
          customer:
            customerId,

          limit:
            8
        }
      );

    invoices =
      (
        result?.data || []
      ).map(
        invoice => ({
          id:
            invoice.id,

          number:
            invoice.number ||
            null,

          created:
            invoice.created
              ? new Date(
                  Number(
                    invoice.created
                  ) * 1000
                ).toISOString()
              : null,

          status:
            String(
              invoice.status ||
              ''
            ).toLowerCase(),

          amount_paid_cents:
            Number(
              invoice.amount_paid ||
              0
            ),

          amount_due_cents:
            Number(
              invoice.amount_due ||
              0
            ),

          currency:
            String(
              invoice.currency ||
              'usd'
            ).toLowerCase(),

          hosted_invoice_url:
            invoice
              .hosted_invoice_url ||
            null,

          invoice_pdf:
            invoice.invoice_pdf ||
            null,

          description:
            invoice
              .lines
              ?.data?.[0]
              ?.description ||

            invoice.description ||

            null
        })
      );

  } catch (error) {
    console.warn(
      'Could not load Stripe invoice history:',
      error?.message ||
      error
    );
  }

  return {
    customer_id:
      customerId,

    email:
      customer?.email ||
      null,

    payment_method:
      normalizePaymentMethod(
        paymentMethod
      ),

    invoices
  };
}

function calculateNextPlanCharge(
  ent,
  sub
) {
  const currentPlan =
    subscriptionPlan(
      ent,
      sub
    );

  const billing =
    subscriptionBilling(
      ent,
      sub
    );

  if (
    sub?.cancel_at_period_end ===
      true ||

    (
      String(
        ent?.pending_plan || ''
      ).toLowerCase() ===
        'free' &&

      !!ent
        ?.pending_plan_effective_at
    )
  ) {
    return 0;
  }

  const pending =
    String(
      ent?.pending_plan || ''
    ).toLowerCase();

  const pendingBilling =
    String(
      ent?.pending_billing_period ||
      billing
    ).toLowerCase();

  if (
    MANAGE_CATALOG[
      pendingBilling
    ]?.[pending]
  ) {
    return (
      MANAGE_CATALOG[
        pendingBilling
      ][pending].cents
    );
  }

  return (
    MANAGE_CATALOG[
      billing
    ]?.[currentPlan]?.cents ??

    Number(
      ent?.plan_amount_cents ||
      0
    )
  );
}

async function billingAccountSummary(
  user,
  ent,
  planSub,
  secondSub
) {
  const ids = [
    stripeCustomerId(
      planSub,
      ent
    ),

    typeof secondSub?.customer ===
    'string'

      ? secondSub.customer

      : secondSub
          ?.customer
          ?.id

  ].filter(Boolean);

  const uniqueIds =
    [
      ...new Set(ids)
    ];

  const snapshots =
    [];

  for (
    const customerId
    of uniqueIds
  ) {
    const related =
      stripeCustomerId(
        planSub,
        ent
      ) === customerId

        ? planSub

        : secondSub;

    snapshots.push(
      await customerSnapshot(
        customerId,
        related
      )
    );
  }

  const paymentMethod =
    snapshots
      .map(
        row =>
          row.payment_method
      )
      .find(Boolean) ||
    null;

  const stripeEmail =
    snapshots
      .map(
        row =>
          row.email
      )
      .find(Boolean) ||
    null;

  const invoices =
    [];

  const seen =
    new Set();

  for (
    const snapshot
    of snapshots
  ) {
    for (
      const invoice
      of snapshot.invoices || []
    ) {
      if (
        !invoice?.id ||
        seen.has(invoice.id)
      ) {
        continue;
      }

      seen.add(
        invoice.id
      );

      invoices.push(
        invoice
      );
    }
  }

  invoices.sort(
    (a, b) => {
      const aTime =
        a?.created
          ? new Date(
              a.created
            ).getTime()
          : 0;

      const bTime =
        b?.created
          ? new Date(
              b.created
            ).getTime()
          : 0;

      return bTime - aTime;
    }
  );

  return {
    billing_email:
      stripeEmail ||
      user?.email ||
      null,

    payment_method:
      paymentMethod,

    invoices:
      invoices.slice(
        0,
        8
      ),

    stripe_customer_count:
      uniqueIds.length,

    next_plan_charge_cents:
      calculateNextPlanCharge(
        ent,
        planSub
      )
  };
}

async function runManageAction(
  res,
  user,
  input
) {
  const action =
    String(
      input.action ||
      'summary'
    ).toLowerCase();

  let ent =
    await getEntitlement(
      user.id
    );

  let sub =
    null;

  if (
    shouldResolveSubscription(
      ent
    )
  ) {
    try {
      sub =
        await resolveSubscription(
          user.id,
          ent
        );

    } catch (error) {
      // The account page should still be able to display the employer's
      // Supabase entitlement if Stripe is temporarily unavailable. Actions
      // that actually change billing still require Stripe and must fail.

      if (
        action !== 'summary'
      ) {
        throw error;
      }

      console.warn(
        'Could not resolve Stripe subscription for billing summary:',
        error?.message ||
        error
      );
    }
  }

  ent =
    await getEntitlement(
      user.id
    );

  if (
    action ===
    'billing_portal'
  ) {
    let secondSlot =
      null;

    try {
      secondSlot =
        await resolveSecondSlotSubscription(
          user.id
        );

    } catch (error) {
      console.warn(
        'Could not resolve Second Job Slot for billing portal:',
        error?.message ||
        error
      );
    }

    const customerId =
      stripeCustomerId(
        sub,
        ent
      ) ||

      (
        typeof secondSlot?.customer ===
        'string'

          ? secondSlot.customer

          : secondSlot
              ?.customer
              ?.id
      ) ||

      null;

    if (!customerId) {
      const error =
        new Error(
          'No Stripe billing account is connected to this employer yet.'
        );

      error.status =
        409;

      throw error;
    }

    const returnUrl =
      allowedReturnUrl(
        input.return_url,

        'https://alygnn.com/employer-account.html?billing=return'
      );

    const portal =
      await manageStripe(
        'POST',
        'billing_portal/sessions',
        {
          customer:
            customerId,

          return_url:
            returnUrl
        }
      );

    return send(
      res,
      200,
      {
        ok:
          true,

        url:
          portal.url
      }
    );
  }

  if (
    action === 'summary'
  ) {
    let secondSlot =
      null;

    try {
      secondSlot =
        await resolveSecondSlotSubscription(
          user.id
        );

    } catch (error) {
      console.warn(
        'Could not resolve Second Job Slot subscription:',
        error?.message ||
        error
      );
    }

    let billingAccount = {
      billing_email:
        user?.email ||
        null,

      payment_method:
        null,

      invoices:
        [],

      stripe_customer_count:
        0,

      next_plan_charge_cents:
        calculateNextPlanCharge(
          ent,
          sub
        )
    };

    try {
      billingAccount =
        await billingAccountSummary(
          user,
          ent,
          sub,
          secondSlot
        );

    } catch (error) {
      console.warn(
        'Could not load billing account summary:',
        error?.message ||
        error
      );
    }

    return send(
      res,
      200,
      {
        ok:
          true,

        summary: {
          ...subscriptionSummary(
            ent,
            sub
          ),

          second_job_slot:
            secondSlotSummary(
              secondSlot
            ),

          billing_account:
            billingAccount
        }
      }
    );
  }

  if (
    action ===
    'cancel_scheduled_change'
  ) {
    if (sub) {
      await releaseSchedule(
        sub,
        ent
      );
    }

    await patchEntitlement(
      user.id,
      {
        stripe_plan_schedule_id:
          null,

        pending_plan:
          null,

        pending_billing_period:
          null,

        pending_plan_effective_at:
          null
      }
    );

    return send(
      res,
      200,
      {
        ok:
          true,

        change:
          'scheduled_change_canceled'
      }
    );
  }

  if (
    action === 'cancel_plan'
  ) {
    const result =
      await cancelPlanAtRenewal({
        employerId:
          user.id,

        ent,
        sub
      });

    return send(
      res,
      200,
      {
        ok:
          true,

        ...result
      }
    );
  }

  if (
    action === 'resume_plan'
  ) {
    const result =
      await resumePlanRenewal({
        employerId:
          user.id,

        ent,
        sub
      });

    return send(
      res,
      200,
      {
        ok:
          true,

        ...result
      }
    );
  }

  if (
    action ===
    'cancel_second_slot'
  ) {
    const secondSlot =
      await resolveSecondSlotSubscription(
        user.id
      );

    const result =
      await cancelSecondSlotAtRenewal({
        sub:
          secondSlot
      });

    return send(
      res,
      200,
      {
        ok:
          true,

        ...result
      }
    );
  }

  if (
    action ===
    'resume_second_slot'
  ) {
    const secondSlot =
      await resolveSecondSlotSubscription(
        user.id
      );

    const result =
      await resumeSecondSlotRenewal({
        sub:
          secondSlot
      });

    return send(
      res,
      200,
      {
        ok:
          true,

        ...result
      }
    );
  }

  if (
    action !== 'change_plan'
  ) {
    return send(
      res,
      400,
      {
        error:
          'Unknown billing action.'
      }
    );
  }

  const target =
    String(
      input.target_plan ||
      ''
    ).toLowerCase();

  const current =
    subscriptionPlan(
      ent,
      sub
    );

  const currentBilling =
    subscriptionBilling(
      ent,
      sub
    );

  const requestedBilling =
    String(
      input.billing ||
      input.target_billing ||
      currentBilling
    ).toLowerCase();

  const targetBilling =
    [
      'monthly',
      'quarterly'
    ].includes(
      requestedBilling
    )
      ? requestedBilling
      : currentBilling;

  const currentCatalog =
    MANAGE_CATALOG[
      currentBilling
    ];

  const targetCatalog =
    MANAGE_CATALOG[
      targetBilling
    ];

  if (
    !targetCatalog?.[target]
  ) {
    return send(
      res,
      400,
      {
        error:
          'Choose Launch, Growth, or Scale with Monthly or Quarterly billing.'
      }
    );
  }

  if (
    !subscriptionIsActive(
      sub
    ) ||
    !currentCatalog?.[current]
  ) {
    return send(
      res,
      409,
      {
        error:
          'This account does not have a recurring Alygnn plan that can be modified automatically. Choose a plan through secure checkout first.',

        requires_checkout:
          true,

        billing_period:
          currentBilling
      }
    );
  }

  if (
    current === target &&
    currentBilling === targetBilling
  ) {
    return send(
      res,
      200,
      {
        ok:
          true,

        change:
          'none',

        message:
          'You are already on this plan and billing cadence.'
      }
    );
  }

  if (
    String(
      sub?.status ||
      ent?.subscription_status ||
      ''
    ).toLowerCase() ===
    'past_due'
  ) {
    return send(
      res,
      409,
      {
        error:
          'Resolve the outstanding payment before changing plans. Update your payment method, then try the plan change again.',

        payment_required:
          true
      }
    );
  }

  // Choosing another plan/cadence means the employer wants billing to continue,
  // so a previously scheduled cancellation is automatically reversed.

  if (
    sub?.cancel_at_period_end ===
    true
  ) {
    sub =
      await manageStripe(
        'POST',
        'subscriptions/' +
        encodeURIComponent(
          sub.id
        ),
        {
          cancel_at_period_end:
            'false'
        }
      );
  }

  if (
    String(
      ent?.pending_plan || ''
    ).toLowerCase() ===
    'free'
  ) {
    await patchEntitlement(
      user.id,
      {
        pending_plan:
          null,

        pending_billing_period:
          null,

        pending_plan_effective_at:
          null
      }
    );

    ent =
      await getEntitlement(
        user.id
      );
  }

  const billingChanged =
    currentBilling !==
    targetBilling;

  let result;

  if (billingChanged) {
    // Monthly <-> Quarterly changes always take effect at renewal.
    // This avoids charging a full new cadence while time remains on the current paid term.

    result =
      await scheduleDowngrade({
        employerId:
          user.id,

        ent,
        sub,

        currentPlan:
          current,

        targetPlan:
          target,

        billing:
          targetBilling,

        currentBilling
      });

    result = {
      ...result,

      change:
        'billing_change_scheduled',

      current_billing_period:
        currentBilling,

      target_billing_period:
        targetBilling
    };

  } else if (
    targetCatalog[target].rank >
    currentCatalog[current].rank
  ) {
    result =
      await upgradeNow({
        employerId:
          user.id,

        ent,
        sub,

        targetPlan:
          target,

        billing:
          targetBilling
      });

  } else {
    result =
      await scheduleDowngrade({
        employerId:
          user.id,

        ent,
        sub,

        currentPlan:
          current,

        targetPlan:
          target,

        billing:
          targetBilling,

        currentBilling
      });
  }

  return send(
    res,
    200,
    {
      ok:
        true,

      ...result
    }
  );
}

module.exports =
async function handler(
  req,
  res
) {
  cors(res);

  if (
    req.method === 'OPTIONS'
  ) {
    return send(
      res,
      204,
      {}
    );
  }

  if (
    req.method !== 'POST'
  ) {
    return send(
      res,
      405,
      {
        error:
          'Method not allowed.'
      }
    );
  }

  try {
    const token =
      bearer(req);

    if (!token) {
      return send(
        res,
        401,
        {
          error:
            'Authentication required.'
        }
      );
    }

    const user =
      await supabaseUser(
        token
      );

    const input =
      parseBody(req);

    // Billing & plan management shares this existing Vercel function so the
    // Hobby deployment stays below the Serverless Function limit.

    const billingAction =
      String(
        input.action ||
        ''
      ).toLowerCase();

    if (
      [
        'summary',
        'change_plan',
        'cancel_scheduled_change',
        'cancel_plan',
        'resume_plan',
        'cancel_second_slot',
        'resume_second_slot',
        'billing_portal'
      ].includes(
        billingAction
      )
    ) {
      return await runManageAction(
        res,
        user,
        input
      );
    }

    if (
      input.terms_accepted !==
      true
    ) {
      return send(
        res,
        400,
        {
          error:
            'Terms must be accepted before checkout.'
        }
      );
    }

    const successUrl =
      allowedReturnUrl(
        input.success_url,

        'https://alygnn.com/employer-dashboard.html?payment=success'
      );

    const cancelUrl =
      allowedReturnUrl(
        input.cancel_url,

        'https://alygnn.com/employer-dashboard.html?payment=cancelled'
      );

    let product =
      String(
        input.product ||
        ''
      ).toLowerCase();

    let plan =
      String(
        input.plan ||
        ''
      ).toLowerCase();

    let billing =
      String(
        input.billing ||
        ''
      ).toLowerCase();

    let name = '';
    let cents = 0;
    let mode = 'payment';
    let slots = 0;
    let days = 0;
    let jobId = '';

    // Backward compatibility: the former $150 "single_job" product is now
    // the standalone $150/month Second Job Slot.

    if (
      !product &&
      plan &&
      plan !== 'single_job'
    ) {
      product =
        'job_plan';
    }

    if (
      !product &&
      plan === 'single_job'
    ) {
      product =
        'additional_slot';
    }

    if (
      product === 'single_job'
    ) {
      product =
        'additional_slot';
    }

    if (
      product ===
      'additional_slot'
    ) {
      const access =
        await getEmployerPostingAccess(
          token
        );

      if (
        !additionalSlotEligible(
          access
        )
      ) {
        const message =
          access?.active_paid_plan ===
          true

            ? 'The $150/month Second Job Slot is only for Free employers. Use a $99 Weekly Job Slot or upgrade your plan.'

            : 'Your Second Job Slot is already active.';

        return send(
          res,
          400,
          {
            error:
              message
          }
        );
      }

      plan =
        'second_job_slot';

      billing =
        'monthly';

      name =
        'Alygnn Second Job Slot';

      cents =
        15000;

      slots =
        1;

      mode =
        'subscription';

    } else if (
      product === 'job_boost'
    ) {
      jobId =
        String(
          input.job_id ||
          ''
        );

      days =
        Math.max(
          1,

          Math.min(
            30,

            Number.parseInt(
              input.days ||

              Math.ceil(
                Number(
                  input.duration_hours ||
                  24
                ) / 24
              ),

              10
            ) || 1
          )
        );

      if (!jobId) {
        return send(
          res,
          400,
          {
            error:
              'Job ID is required for Job Boost.'
          }
        );
      }

      await verifyOwnedActiveJob(
        token,
        user.id,
        jobId
      );

      name =
        `Alygnn Job Boost — ${days} day${days === 1 ? '' : 's'}`;

      cents =
        1500 * days;

      billing =
        'one_time';

      mode =
        'payment';

    } else {
      product =
        'job_plan';

      if (
        billing === 'weekly' ||
        plan === 'weekly_slot'
      ) {
        billing =
          'weekly';

        plan =
          'weekly_slot';

        const access =
          await getEmployerPostingAccess(
            token
          );

        if (
          access?.candidate_access_locked ===
          true
        ) {
          return send(
            res,
            402,
            {
              error:
                'Update your payment method before adding another Weekly Job Slot.',

              payment_issue:
                true
            }
          );
        }

        if (
          access?.active_paid_plan !==
          true
        ) {
          return send(
            res,
            400,
            {
              error:
                'The $99 Weekly Job Slot is available only with an active Launch, Growth, or Scale monthly/quarterly plan.'
            }
          );
        }

        if (
          access?.weekly_purchase_allowed !==
          true
        ) {
          const recommended =
            String(
              access?.recommended_upgrade_plan ||
              ''
            ).toLowerCase();

          return send(
            res,
            409,
            {
              error:
                recommended

                  ? `You already have one active Weekly Job Slot. Upgrade to ${recommended.charAt(0).toUpperCase() + recommended.slice(1)} for better ongoing value.`

                  : 'Another Weekly Job Slot is not available for this plan right now.',

              recommended_upgrade_plan:
                recommended ||
                null,

              manage_plan:
                !!recommended
            }
          );
        }
      }

      const item =
        CHECKOUT_CATALOG[
          billing
        ]?.[plan];

      if (!item) {
        return send(
          res,
          400,
          {
            error:
              'Unknown Alygnn plan or billing period.'
          }
        );
      }

      // Do not create a second paid plan while an employer already has one active.
      // Existing recurring subscribers change plans through Billing & plan so
      // upgrades use Alygnn's fixed-difference charge and downgrades wait until renewal.

      if (
        billing === 'monthly' ||
        billing === 'quarterly'
      ) {
        const access =
          await getEmployerPostingAccess(
            token
          );

        const currentPlan =
          String(
            access?.plan ||
            ''
          ).toLowerCase();

        const currentBilling =
          String(
            access?.billing_period ||
            ''
          ).toLowerCase();

        if (
          access?.active_paid_plan ===
            true &&

          [
            'monthly',
            'quarterly'
          ].includes(
            currentBilling
          ) &&

          [
            'launch',
            'growth',
            'scale',
            'business',
            'enterprise'
          ].includes(
            currentPlan
          )
        ) {
          return send(
            res,
            409,
            {
              error:
                'You already have an active paid plan. Change it from Settings → Billing & plan so Alygnn can charge the fixed plan difference for upgrades or schedule downgrades correctly.',

              manage_plan:
                true
            }
          );
        }
      }

      name =
        item.name;

      cents =
        item.cents;

      slots =
        item.slots;

      mode =
        item.mode;
    }

    const metadata = {
      employer_id:
        user.id,

      employer_email:
        user.email ||
        '',

      product,
      plan,
      billing,

      slots:
        slots || '',

      job_id:
        jobId,

      days:
        days || '',

      unit_amount_cents:
        product ===
        'job_boost'

          ? '1500'

          : cents,

      source:
        String(
          input.source ||
          'website'
        ),

      terms_version:
        String(
          input.terms_version ||
          ''
        )
    };

    const params = {
      mode,

      success_url:
        successUrl,

      cancel_url:
        cancelUrl,

      customer_email:
        user.email ||
        undefined,

      'line_items[0][quantity]':
        1,

      'line_items[0][price_data][currency]':
        'usd',

      'line_items[0][price_data][unit_amount]':
        cents,

      'line_items[0][price_data][product_data][name]':
        name,

      'payment_method_types[0]':
        'card'
    };

    if (
      mode === 'subscription'
    ) {
      params[
        'line_items[0][price_data][recurring][interval]'
      ] =
        'month';

      params[
        'line_items[0][price_data][recurring][interval_count]'
      ] =
        product ===
          'job_plan' &&
        billing ===
          'quarterly'

          ? 3

          : 1;
    }

    Object.entries(
      metadata
    ).forEach(
      ([key, value]) => {
        params[
          `metadata[${key}]`
        ] =
          value;

        if (
          mode ===
          'subscription'
        ) {
          params[
            `subscription_data[metadata][${key}]`
          ] =
            value;

        } else {
          params[
            `payment_intent_data[metadata][${key}]`
          ] =
            value;
        }
      }
    );

    const session =
      await stripeCreateCheckout(
        params
      );

    return send(
      res,
      200,
      {
        url:
          session.url,

        id:
          session.id
      }
    );

  } catch (error) {
    console.error(
      'Alygnn billing/checkout error:',
      error
    );

    return send(
      res,

      error.status &&
      error.status >= 400 &&
      error.status < 500

        ? error.status

        : 500,

      {
        error:
          error?.message ||
          'Could not complete billing request.'
      }
    );
  }
};
