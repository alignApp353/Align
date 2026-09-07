// Vercel Node Function: /api/create-checkout-session
// Alygnn checkout + subscription management in ONE Serverless Function.
// This combined route avoids adding /api/manage-subscription on Vercel Hobby.

const STRIPE_API = 'https://api.stripe.com/v1';

// Supabase's publishable key is intentionally public and is already used by
// Alygnn's browser/Capacitor app. Vercel may still provide SUPABASE_ANON_KEY or
// SUPABASE_PUBLISHABLE_KEY; use those first, then fall back to Alygnn's public key.
const ALYGNN_SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  'sb_publishable_3l8krRh6WCyvKfNumWDBDw_C6CKr7rG';

function supabasePublicKey(){
  return ALYGNN_SUPABASE_PUBLISHABLE_KEY;
}


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

// Every employer permanently keeps one reusable free job slot.
const PERMANENT_FREE_JOB_SLOTS = 1;

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
  const anon = supabasePublicKey();

  const response = await fetch(base.replace(/\/$/, '') + '/auth/v1/user', {
    headers: { apikey: anon, Authorization: 'Bearer ' + token }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.id) throw new Error('Invalid employer session.');
  return data;
}

async function verifyOwnedActiveJob(token, userId, jobId) {
  const base = process.env.SUPABASE_URL || 'https://auth.alygnn.com';
  const anon = supabasePublicKey();
  const url = new URL(base.replace(/\/$/, '') + '/rest/v1/jobs');

  url.searchParams.set('id', 'eq.' + jobId);
  url.searchParams.set('employer_id', 'eq.' + userId);
  url.searchParams.set(
    'select',
    'id,status,pause_reason,posting_access_type'
  );
  url.searchParams.set('limit', '1');

  const response = await fetch(url, {
    headers: {
      apikey: anon,
      Authorization: 'Bearer ' + token
    }
  });

  const rows = await response.json().catch(() => []);

  if(
    !response.ok ||
    !Array.isArray(rows) ||
    !rows[0]
  ){
    throw new Error(
      'The selected job could not be verified.'
    );
  }

  const row=rows[0];
  const status=String(
    row.status||''
  ).toLowerCase();

  const pauseReason=String(
    row.pause_reason||''
  ).toLowerCase();

  const boostable=
    status==='active' ||
    (
      status==='paused' &&
      pauseReason==='free_applicant_limit'
    );

  if(!boostable){
    throw new Error(
      'Only active jobs or jobs automatically paused at the free applicant limit can be boosted.'
    );
  }

  return row;
}


async function getEmployerPostingAccess(token) {
  const base=(process.env.SUPABASE_URL||'https://auth.alygnn.com').replace(/\/$/,'');
  const anon=supabasePublicKey();

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


async function getTeamAccess(token) {
  const base =
    (process.env.SUPABASE_URL || 'https://auth.alygnn.com')
      .replace(/\/$/, '');

  const anon =
    supabasePublicKey();

  const response =
    await fetch(
      base +
      '/rest/v1/rpc/get_my_team_access',
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
    await response.json().catch(
      () => null
    );

  if (!response.ok) {
    throw new Error(
      (
        data &&
        (
          data.message ||
          data.error
        )
      ) ||
      'Could not verify team-seat access.'
    );
  }

  return data || {};
}

function additionalSlotEligible(access) {
  // The $150/month Second Job Slot is ONLY for employers without
  // an active monthly/quarterly Launch/Growth/Scale plan.
  if (access?.active_paid_plan === true || access?.base_paid_plan === true) {
    return false;
  }

  return Number(
    access?.second_slot_count ??
    access?.addon_slot_count ??
    0
  ) < 1;
}

function nextSelfServePlan(access) {
  const plan = String(
    access?.test_plan ||
    access?.plan ||
    'free'
  ).toLowerCase();

  if (plan === 'launch' || plan === 'business') return 'growth';
  if (plan === 'growth') return 'scale';

  return null;
}

function weeklyCheckoutDecision(access) {
  const weeklyCount = Math.max(
    0,
    Number(access?.weekly_slot_count || 0)
  );

  const paid =
    access?.active_paid_plan === true ||
    access?.base_paid_plan === true;

  if (!paid) {
    return {
      allowed: true,
      recommendedPlan: null
    };
  }

  if (weeklyCount < 1) {
    return {
      allowed: true,
      recommendedPlan: null
    };
  }

  const recommendedPlan =
    String(
      access?.recommended_upgrade_plan ||
      nextSelfServePlan(access) ||
      ''
    ).toLowerCase() || null;

  // Launch/Growth should upgrade after one active Weekly extra.
  if (recommendedPlan) {
    return {
      allowed: false,
      recommendedPlan
    };
  }

  // Scale is currently the highest self-serve plan.
  return {
    allowed: true,
    recommendedPlan: null
  };
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


const MANAGE_CATALOG={
  monthly:{
    launch:{name:'Alygnn Launch',cents:29900,slots:3,rank:1,lookup:'alygnn_launch_monthly',interval:'month',intervalCount:1},
    growth:{name:'Alygnn Growth',cents:44900,slots:5,rank:2,lookup:'alygnn_growth_monthly',interval:'month',intervalCount:1},
    scale:{name:'Alygnn Scale',cents:64900,slots:8,rank:3,lookup:'alygnn_scale_monthly',interval:'month',intervalCount:1}
  },
  quarterly:{
    launch:{name:'Alygnn Launch — 3 months',cents:75000,slots:3,rank:1,lookup:'alygnn_launch_quarterly',interval:'month',intervalCount:3},
    growth:{name:'Alygnn Growth — 3 months',cents:114000,slots:5,rank:2,lookup:'alygnn_growth_quarterly',interval:'month',intervalCount:3},
    scale:{name:'Alygnn Scale — 3 months',cents:170000,slots:8,rank:3,lookup:'alygnn_scale_quarterly',interval:'month',intervalCount:3}
  }
};

function manageCors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type');
}
function manageSend(res,status,payload){
  manageCors(res);res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(payload));
}
function manageBody(req){
  if(!req.body)return {};
  if(typeof req.body==='object'&&!Buffer.isBuffer(req.body))return req.body;
  try{return JSON.parse(Buffer.isBuffer(req.body)?req.body.toString('utf8'):String(req.body));}catch(_){return {};}
}
function manageBearer(req){const v=String(req.headers.authorization||'');return v.toLowerCase().startsWith('bearer ')?v.slice(7).trim():'';}
function manageBase(){return (process.env.SUPABASE_URL||'https://auth.alygnn.com').replace(/\/$/,'');}
function manageServiceHeaders(extra={}){
  const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!key)throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured.');
  return {apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',...extra};
}
async function manageCurrentUser(token){
  const anon=supabasePublicKey();
  const r=await fetch(manageBase()+'/auth/v1/user',{headers:{apikey:anon,Authorization:'Bearer '+token}});
  const data=await r.json().catch(()=>({}));
  if(!r.ok||!data?.id){const e=new Error('Invalid employer session.');e.status=401;throw e;}
  return data;
}
async function getEntitlement(employerId){
  const url=new URL(manageBase()+'/rest/v1/employer_entitlements');
  url.searchParams.set('employer_id','eq.'+employerId);
  url.searchParams.set('select','*');
  url.searchParams.set('limit','1');
  const r=await fetch(url,{headers:manageServiceHeaders()});
  const rows=await r.json().catch(()=>[]);
  if(!r.ok)throw new Error(rows?.message||'Could not load billing entitlement.');
  return Array.isArray(rows)?(rows[0]||{}):{};
}
async function patchEntitlement(employerId,patch){
  const url=new URL(manageBase()+'/rest/v1/employer_entitlements');
  url.searchParams.set('employer_id','eq.'+employerId);
  const r=await fetch(url,{
    method:'PATCH',
    headers:manageServiceHeaders({Prefer:'return=minimal'}),
    body:JSON.stringify({...patch,plan_change_updated_at:new Date().toISOString(),updated_at:new Date().toISOString()})
  });
  if(!r.ok)throw new Error('Could not save billing state: '+await r.text());
}
function exactPlan(ent){
  const exact=String(ent?.test_plan||'').toLowerCase();
  if(['launch','growth','scale'].includes(exact))return exact;
  const legacy=String(ent?.plan||'').toLowerCase();
  if(legacy==='business')return 'launch';
  if(legacy==='enterprise')return Number(ent?.slot_limit||0)>=8?'scale':'growth';
  return ['launch','growth','scale'].includes(legacy)?legacy:'free';
}
function billingPeriod(ent){
  const billing=String(ent?.billing_period||'').toLowerCase();
  return ['monthly','quarterly'].includes(billing)?billing:billing||'free';
}
function recurringPlan(ent){
  const billing=billingPeriod(ent);
  const plan=exactPlan(ent);
  return MANAGE_CATALOG[billing]?.[plan]||null;
}
function entitlementLooksActive(ent){
  const status=String(ent?.subscription_status||'').toLowerCase();
  const end=ent?.current_period_end?new Date(ent.current_period_end).getTime():Infinity;
  return ['active','trialing','past_due'].includes(status)&&!!recurringPlan(ent)&&end>Date.now();
}
function shouldResolveSubscription(ent){
  const status=String(ent?.subscription_status||'').toLowerCase();
  return !!String(ent?.stripe_plan_subscription_id||'').trim() ||
    (['active','trialing','past_due'].includes(status)&&!!recurringPlan(ent));
}
function subscriptionIsActive(sub){
  if(!sub)return false;
  const status=String(sub.status||'').toLowerCase();
  const end=sub.current_period_end?Number(sub.current_period_end)*1000:Infinity;
  return ['active','trialing','past_due'].includes(status)&&end>Date.now();
}
function subscriptionPlan(ent,sub){
  const fromStripe=String(sub?.metadata?.plan||'').toLowerCase();
  return ['launch','growth','scale'].includes(fromStripe)?fromStripe:exactPlan(ent);
}
function subscriptionBilling(ent,sub){
  const fromStripe=String(sub?.metadata?.billing||'').toLowerCase();
  return ['monthly','quarterly'].includes(fromStripe)?fromStripe:billingPeriod(ent);
}

async function manageStripe(method,path,params){
  const secret=process.env.STRIPE_SECRET_KEY;
  if(!secret)throw new Error('STRIPE_SECRET_KEY is not configured.');
  let url=STRIPE_API+'/'+String(path).replace(/^\//,'');
  const options={method,headers:{Authorization:'Bearer '+secret}};
  if(method==='GET'){
    const u=new URL(url);
    Object.entries(params||{}).forEach(([k,v])=>{if(v!==undefined&&v!==null&&v!=='')u.searchParams.append(k,String(v));});
    url=u.toString();
  }else{
    const form=new URLSearchParams();
    Object.entries(params||{}).forEach(([k,v])=>{if(v!==undefined&&v!==null&&v!=='')form.append(k,String(v));});
    options.headers['Content-Type']='application/x-www-form-urlencoded';
    options.body=form;
  }
  const r=await fetch(url,options);
  const data=await r.json().catch(()=>({}));
  if(!r.ok){const err=new Error(data?.error?.message||'Stripe request failed.');err.status=r.status;err.stripe=data?.error||null;throw err;}
  return data;
}

async function ensureRecurringPrice(plan,billing){
  const p=MANAGE_CATALOG[billing]?.[plan];
  if(!p)throw new Error('Unknown recurring plan.');
  const envKey=`STRIPE_PRICE_${plan.toUpperCase()}_${billing.toUpperCase()}`;
  if(process.env[envKey])return process.env[envKey];
  const listed=await manageStripe('GET','prices',{'lookup_keys[]':p.lookup,active:'true',limit:1});
  if(listed?.data?.[0]?.id)return listed.data[0].id;
  const created=await manageStripe('POST','prices',{
    currency:'usd',unit_amount:p.cents,lookup_key:p.lookup,
    'recurring[interval]':p.interval,'recurring[interval_count]':p.intervalCount,
    'product_data[name]':p.name,
    'metadata[alygnn_plan]':plan,'metadata[billing]':billing
  });
  return created.id;
}

async function searchPlanSubscription(employerId){
  const q=`metadata[\"employer_id\"]:\"${employerId}\" AND metadata[\"product\"]:\"job_plan\"`;
  const found=await manageStripe('GET','subscriptions/search',{query:q,limit:20});
  const rows=(found?.data||[]).filter(s=>!['canceled','incomplete_expired'].includes(String(s.status||'')));
  rows.sort((a,b)=>(b.created||0)-(a.created||0));
  return rows[0]||null;
}
async function resolveSubscription(employerId,ent){
  let sub=null;
  const stored=String(ent?.stripe_plan_subscription_id||'').trim();
  if(stored){try{sub=await manageStripe('GET','subscriptions/'+encodeURIComponent(stored));}catch(_){} }
  if(!sub)sub=await searchPlanSubscription(employerId);
  if(sub){
    await patchEntitlement(employerId,{
      stripe_plan_subscription_id:sub.id,
      stripe_plan_customer_id:typeof sub.customer==='string'?sub.customer:sub.customer?.id||null,
      stripe_plan_schedule_id:typeof sub.schedule==='string'?sub.schedule:sub.schedule?.id||null
    });
  }
  return sub;
}
function subscriptionSummary(ent,sub){
  const plan=subscriptionPlan(ent,sub);
  const billing=subscriptionBilling(ent,sub);
  const p=MANAGE_CATALOG[billing]?.[plan]||null;
  const endUnix=sub?.current_period_end||null;
  const slots=canonicalSlotSummary(ent,sub);
  return {
    current_plan:plan,
    billing_period:billing,
    test_mode:ent?.test_mode===true,
    subscription_status:String(sub?.status||ent?.subscription_status||'free').toLowerCase(),
    current_period_end:endUnix?new Date(endUnix*1000).toISOString():(ent?.current_period_end||null),
    amount_cents:p?.cents??Number(ent?.plan_amount_cents||0),

    // For the Billing UI, slot_limit is the TOTAL reusable capacity.
    // Launch = 3 + 1 free = 4, Growth = 5 + 1 free = 6,
    // Scale = 8 + 1 free = 9.
    slot_limit:slots.total_slot_limit,
    total_slot_limit:slots.total_slot_limit,
    plan_slot_limit:slots.plan_slot_limit,
    permanent_free_slot_count:slots.permanent_free_slot_count,
    pending_plan:ent?.pending_plan||null,
    pending_billing_period:ent?.pending_billing_period||null,
    pending_plan_effective_at:ent?.pending_plan_effective_at||null,
    cancel_at_period_end:
      sub?.cancel_at_period_end===true ||
      (
        String(ent?.pending_plan||'').toLowerCase()==='free' &&
        !!ent?.pending_plan_effective_at
      ),
    cancel_effective_at:
      sub?.cancel_at_period_end===true && sub?.current_period_end
        ? new Date(Number(sub.current_period_end)*1000).toISOString()
        : (
            String(ent?.pending_plan||'').toLowerCase()==='free'
              ? ent?.pending_plan_effective_at||null
              : null
          ),
    stripe_subscription_id:sub?.id||ent?.stripe_plan_subscription_id||null,
    managed_subscription:!!sub
  };
}

async function searchSubscriptionByProduct(employerId,product){
  const q=`metadata[\"employer_id\"]:\"${employerId}\" AND metadata[\"product\"]:\"${product}\"`;
  const found=await manageStripe('GET','subscriptions/search',{query:q,limit:20});
  const rows=(found?.data||[])
    .filter(row=>!['canceled','incomplete_expired'].includes(String(row.status||'')));
  rows.sort((a,b)=>(b.created||0)-(a.created||0));
  return rows[0]||null;
}

async function resolveSecondSlotSubscription(employerId){
  let sub=await searchSubscriptionByProduct(employerId,'additional_slot');
  if(!sub)sub=await searchSubscriptionByProduct(employerId,'single_job');
  return sub;
}

function secondSlotSummary(sub){
  if(!sub)return {
    managed_subscription:false,
    subscription_status:null,
    current_period_end:null,
    cancel_at_period_end:false,
    cancel_effective_at:null
  };

  return {
    managed_subscription:true,
    subscription_status:String(sub.status||'').toLowerCase(),
    current_period_end:sub.current_period_end
      ? new Date(Number(sub.current_period_end)*1000).toISOString()
      : null,
    cancel_at_period_end:sub.cancel_at_period_end===true,
    cancel_effective_at:
      sub.cancel_at_period_end===true && sub.current_period_end
        ? new Date(Number(sub.current_period_end)*1000).toISOString()
        : null,
    stripe_subscription_id:sub.id||null
  };
}

async function cancelPlanAtRenewal({employerId,ent,sub}){
  const effectiveIso=
    sub?.current_period_end
      ? new Date(Number(sub.current_period_end)*1000).toISOString()
      : ent?.current_period_end||null;

  if(sub&&subscriptionIsActive(sub)){
    // A scheduled downgrade and a scheduled cancellation should never coexist.
    await releaseSchedule(sub,ent);

    const updated=await manageStripe(
      'POST',
      'subscriptions/'+encodeURIComponent(sub.id),
      {cancel_at_period_end:'true'}
    );

    const endIso=updated.current_period_end
      ? new Date(Number(updated.current_period_end)*1000).toISOString()
      : effectiveIso;

    await patchEntitlement(employerId,{
      stripe_plan_schedule_id:null,
      pending_plan:null,
      pending_billing_period:null,
      pending_plan_effective_at:null
    });

    return {
      change:'cancellation_scheduled',
      effective_at:endIso,
      cancel_at_period_end:true
    };
  }

  // Developer test plans are prepaid test terms rather than Stripe subscriptions.
  // Scheduling "free" lets the app demonstrate the same cancel-at-renewal UX.
  if(ent?.test_mode===true && recurringPlan(ent) && entitlementLooksActive(ent)){
    if(!effectiveIso)throw new Error('Could not determine when this test plan ends.');

    await patchEntitlement(employerId,{
      stripe_plan_schedule_id:null,
      pending_plan:'free',
      pending_billing_period:'free',
      pending_plan_effective_at:effectiveIso
    });

    return {
      change:'cancellation_scheduled',
      effective_at:effectiveIso,
      cancel_at_period_end:true,
      test_mode:true
    };
  }

  const error=new Error(
    'This plan is already prepaid without automatic renewal, so there is no future charge to cancel.'
  );
  error.status=409;
  throw error;
}

async function resumePlanRenewal({employerId,ent,sub}){
  if(sub&&sub.cancel_at_period_end===true){
    await manageStripe(
      'POST',
      'subscriptions/'+encodeURIComponent(sub.id),
      {cancel_at_period_end:'false'}
    );
  }

  await patchEntitlement(employerId,{
    pending_plan:null,
    pending_billing_period:null,
    pending_plan_effective_at:null
  });

  return {
    change:'cancellation_reversed',
    cancel_at_period_end:false
  };
}

async function cancelSecondSlotAtRenewal({sub}){
  if(!sub||!subscriptionIsActive(sub)){
    const error=new Error(
      'The Second Job Slot does not have an active recurring subscription to cancel.'
    );
    error.status=409;
    throw error;
  }

  const updated=await manageStripe(
    'POST',
    'subscriptions/'+encodeURIComponent(sub.id),
    {cancel_at_period_end:'true'}
  );

  return {
    change:'second_slot_cancellation_scheduled',
    effective_at:updated.current_period_end
      ? new Date(Number(updated.current_period_end)*1000).toISOString()
      : null,
    cancel_at_period_end:true
  };
}

async function resumeSecondSlotRenewal({sub}){
  if(!sub){
    const error=new Error('Second Job Slot subscription could not be found.');
    error.status=409;
    throw error;
  }

  await manageStripe(
    'POST',
    'subscriptions/'+encodeURIComponent(sub.id),
    {cancel_at_period_end:'false'}
  );

  return {
    change:'second_slot_cancellation_reversed',
    cancel_at_period_end:false
  };
}

async function releaseSchedule(sub,ent){
  const scheduleId=(typeof sub?.schedule==='string'?sub.schedule:sub?.schedule?.id)||ent?.stripe_plan_schedule_id;
  if(!scheduleId)return;
  try{await manageStripe('POST','subscription_schedules/'+encodeURIComponent(scheduleId)+'/release',{});}catch(error){
    if(!/released|completed|not found|no such subscription schedule/i.test(error.message||''))throw error;
  }
}

function planChangeMoney(billing,currentPlan,targetPlan){
  const catalog=MANAGE_CATALOG[billing];
  const current=catalog?.[currentPlan];
  const target=catalog?.[targetPlan];

  if(!current||!target){
    throw new Error(
      'Could not calculate the Alygnn plan change.'
    );
  }

  return {
    current_cents:current.cents,
    target_cents:target.cents,
    difference_cents:Math.max(
      0,
      target.cents-current.cents
    ),
    decrease_cents:Math.max(
      0,
      current.cents-target.cents
    )
  };
}

function testPlanSlotLimit(plan){
  return MANAGE_CATALOG.monthly?.[plan]?.slots ||
    MANAGE_CATALOG.quarterly?.[plan]?.slots ||
    0;
}

async function normalizeCanonicalPlanEntitlement(employerId,ent){
  const plan=exactPlan(ent);
  const billing=billingPeriod(ent);
  const catalog=MANAGE_CATALOG[billing];
  const planRow=catalog?.[plan];

  // slot_limit in employer_entitlements stores ONLY the paid-plan slots.
  // The permanent free slot is added separately by posting-access/UI logic.
  if(!planRow || !['launch','growth','scale'].includes(plan)){
    return ent;
  }

  const expectedSlots=Number(planRow.slots||0);
  const expectedUrgent=['growth','scale'].includes(plan);
  const currentSlots=Number(ent?.slot_limit||0);
  const currentUrgent=ent?.urgently_hiring===true;

  if(currentSlots===expectedSlots && currentUrgent===expectedUrgent){
    return ent;
  }

  await patchEntitlement(employerId,{
    slot_limit:expectedSlots,
    urgently_hiring:expectedUrgent
  });

  return await getEntitlement(employerId);
}

function canonicalSlotSummary(ent,sub){
  const plan=subscriptionPlan(ent,sub);
  const billing=subscriptionBilling(ent,sub);
  const paidPlanSlots=Number(MANAGE_CATALOG[billing]?.[plan]?.slots||0);

  if(paidPlanSlots>0){
    return {
      plan_slot_limit:paidPlanSlots,
      permanent_free_slot_count:PERMANENT_FREE_JOB_SLOTS,
      total_slot_limit:paidPlanSlots+PERMANENT_FREE_JOB_SLOTS
    };
  }

  return {
    plan_slot_limit:0,
    permanent_free_slot_count:PERMANENT_FREE_JOB_SLOTS,
    total_slot_limit:PERMANENT_FREE_JOB_SLOTS
  };
}

async function applyDueTestPlanChange(
  employerId,
  ent
){
  if(ent?.test_mode!==true){
    return ent;
  }

  const pending=String(
    ent?.pending_plan||''
  ).toLowerCase();

  const effectiveAt=
    ent?.pending_plan_effective_at
      ?new Date(
          ent.pending_plan_effective_at
        ).getTime()
      :NaN;

  if(
    !['launch','growth','scale'].includes(
      pending
    ) ||
    !Number.isFinite(effectiveAt) ||
    effectiveAt>Date.now()
  ){
    return ent;
  }

  await patchEntitlement(employerId,{
    test_plan:pending,
    slot_limit:testPlanSlotLimit(pending),
    urgently_hiring:[
      'growth',
      'scale'
    ].includes(pending),

    pending_plan:null,
    pending_billing_period:null,
    pending_plan_effective_at:null
  });

  return await getEntitlement(employerId);
}

async function testModePlanChange({
  employerId,
  ent,
  currentPlan,
  targetPlan,
  billing
}){
  const catalog=MANAGE_CATALOG[billing];

  if(
    !catalog?.[currentPlan] ||
    !catalog?.[targetPlan]
  ){
    const error=new Error(
      'This test plan cannot be changed automatically.'
    );
    error.status=409;
    throw error;
  }

  const money=planChangeMoney(
    billing,
    currentPlan,
    targetPlan
  );

  const upgrade=
    catalog[targetPlan].rank>
    catalog[currentPlan].rank;

  if(upgrade){
    await patchEntitlement(employerId,{
      test_plan:targetPlan,
      slot_limit:catalog[targetPlan].slots,
      urgently_hiring:[
        'growth',
        'scale'
      ].includes(targetPlan),

      pending_plan:null,
      pending_billing_period:null,
      pending_plan_effective_at:null
    });

    return {
      change:'upgrade_applied',
      test_mode:true,
      effective:'immediate',

      /*
       * Simulated only. This mirrors the exact-difference
       * production billing contract.
       */
      amount_due_now_cents:
        money.difference_cents,

      simulated_charge_cents:
        money.difference_cents,

      next_renewal_amount_cents:
        money.target_cents,

      refund_cents:0,
      credit_cents:0,
      billing_period:billing
    };
  }

  const effectiveIso=
    ent?.current_period_end||null;

  if(!effectiveIso){
    throw new Error(
      'Could not determine the current test billing-period end.'
    );
  }

  await patchEntitlement(employerId,{
    pending_plan:targetPlan,
    pending_billing_period:billing,
    pending_plan_effective_at:effectiveIso
  });

  return {
    change:'downgrade_scheduled',
    test_mode:true,
    effective_at:effectiveIso,
    billing_period:billing,

    amount_due_now_cents:0,
    refund_cents:0,
    credit_cents:0,

    current_plan_stays_active:true,
    next_renewal_amount_cents:
      money.target_cents
  };
}

async function scheduleDowngrade({employerId,ent,sub,currentPlan,targetPlan,billing}){
  if(sub?.cancel_at_period_end===true){
    sub=await manageStripe(
      'POST',
      'subscriptions/'+encodeURIComponent(sub.id),
      {cancel_at_period_end:'false'}
    );
  }

  const item=sub?.items?.data?.[0];
  const currentPriceId=typeof item?.price==='string'?item.price:item?.price?.id;
  if(!item?.id||!currentPriceId)throw new Error('Stripe subscription item could not be identified.');
  const targetPrice=await ensureRecurringPrice(targetPlan,billing);

  let scheduleId=(typeof sub.schedule==='string'?sub.schedule:sub.schedule?.id)||ent?.stripe_plan_schedule_id||null;
  let schedule=null;
  if(scheduleId){
    schedule=await manageStripe('GET','subscription_schedules/'+encodeURIComponent(scheduleId));
  }else{
    schedule=await manageStripe('POST','subscription_schedules',{from_subscription:sub.id});
    scheduleId=schedule.id;
  }

  const now=Math.floor(Date.now()/1000);
  const phase=(schedule?.phases||[]).find(p=>p.start_date<=now&&p.end_date>now)||(schedule?.phases||[])[0];
  const start=phase?.start_date||sub.current_period_start;
  const end=phase?.end_date||sub.current_period_end;
  if(!start||!end)throw new Error('Could not determine the current billing-period boundary.');

  const phasePrice=typeof phase?.items?.[0]?.price==='string'?phase.items[0].price:phase?.items?.[0]?.price?.id;
  const currentPrice=phasePrice||currentPriceId;
  const currentQty=phase?.items?.[0]?.quantity||item.quantity||1;
  const intervalCount=MANAGE_CATALOG[billing][targetPlan].intervalCount;

  await manageStripe('POST','subscription_schedules/'+encodeURIComponent(scheduleId),{
    end_behavior:'release',
    'phases[0][start_date]':start,
    'phases[0][end_date]':end,
    'phases[0][items][0][price]':currentPrice,
    'phases[0][items][0][quantity]':currentQty,
    'phases[0][proration_behavior]':'none',
    'phases[0][metadata][employer_id]':employerId,
    'phases[0][metadata][product]':'job_plan',
    'phases[0][metadata][plan]':currentPlan,
    'phases[0][metadata][billing]':billing,
    'phases[1][start_date]':end,
    'phases[1][duration][interval]':'month',
    'phases[1][duration][interval_count]':intervalCount,
    'phases[1][items][0][price]':targetPrice,
    'phases[1][items][0][quantity]':1,
    'phases[1][proration_behavior]':'none',
    'phases[1][metadata][employer_id]':employerId,
    'phases[1][metadata][product]':'job_plan',
    'phases[1][metadata][plan]':targetPlan,
    'phases[1][metadata][billing]':billing
  });

  await patchEntitlement(employerId,{
    stripe_plan_schedule_id:scheduleId,
    pending_plan:targetPlan,
    pending_billing_period:billing,
    pending_plan_effective_at:new Date(end*1000).toISOString()
  });
  const money=planChangeMoney(
    billing,
    currentPlan,
    targetPlan
  );

  return {
    change:'downgrade_scheduled',
    effective_at:
      new Date(end*1000).toISOString(),

    schedule_id:scheduleId,
    billing_period:billing,

    /*
     * FINAL DOWNGRADE POLICY:
     * no refund, no account credit, no charge today.
     */
    amount_due_now_cents:0,
    refund_cents:0,
    credit_cents:0,

    current_plan_stays_active:true,

    next_renewal_amount_cents:
      money.target_cents
  };
}
async function applyPaidUpgradeSubscription({
  employerId,
  ent,
  sub,
  targetPlan,
  billing,
  targetPrice
}){
  const item=sub?.items?.data?.[0];

  if(!item?.id){
    throw new Error(
      'Stripe subscription item could not be identified.'
    );
  }

  const updated=await manageStripe(
    'POST',
    'subscriptions/'+
      encodeURIComponent(sub.id),
    {
      cancel_at_period_end:'false',

      'items[0][id]':
        item.id,

      'items[0][price]':
        targetPrice,

      'items[0][quantity]':
        1,

      /*
       * The exact upgrade difference was already charged
       * separately, so Stripe must not create another proration.
       */
      proration_behavior:'none',

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

  await patchEntitlement(employerId,{
    stripe_plan_subscription_id:
      updated.id,

    stripe_plan_customer_id:
      typeof updated.customer==='string'
        ?updated.customer
        :updated.customer?.id||null,

    stripe_plan_schedule_id:null,

    /*
     * Alygnn uses test_plan as the exact Launch/Growth/Scale
     * plan code even for real production entitlements.
     */
    test_plan:targetPlan,
    slot_limit:
      MANAGE_CATALOG[billing][targetPlan]
        .slots,

    plan_amount_cents:
      MANAGE_CATALOG[billing][targetPlan]
        .cents,

    urgently_hiring:
      ['growth','scale'].includes(
        targetPlan
      ),

    pending_plan:null,
    pending_billing_period:null,
    pending_plan_effective_at:null
  });

  return updated;
}

async function createExactUpgradeInvoice({
  employerId,
  sub,
  currentPlan,
  targetPlan,
  billing,
  targetPrice,
  differenceCents
}){
  const customerId=
    typeof sub?.customer==='string'
      ?sub.customer
      :sub?.customer?.id;

  if(!customerId){
    throw new Error(
      'Stripe customer could not be identified.'
    );
  }

  /*
   * Create a dedicated invoice first so unrelated pending
   * invoice items cannot be collected with this upgrade.
   */
  const invoice=await manageStripe(
    'POST',
    'invoices',
    {
      customer:customerId,
      collection_method:
        'charge_automatically',

      auto_advance:'false',

      description:
        `Alygnn ${currentPlan} to ${targetPlan} upgrade`,

      'metadata[product]':
        'plan_upgrade',

      'metadata[employer_id]':
        employerId,

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

      'metadata[difference_cents]':
        differenceCents
    }
  );

  await manageStripe(
    'POST',
    'invoiceitems',
    {
      customer:customerId,
      invoice:invoice.id,
      currency:'usd',
      amount:differenceCents,

      description:
        `Alygnn upgrade difference: ${currentPlan} → ${targetPlan}`,

      'metadata[product]':
        'plan_upgrade',

      'metadata[employer_id]':
        employerId,

      'metadata[current_plan]':
        currentPlan,

      'metadata[target_plan]':
        targetPlan,

      'metadata[billing]':
        billing
    }
  );

  const finalized=await manageStripe(
    'POST',
    'invoices/'+
      encodeURIComponent(invoice.id)+
      '/finalize',
    {
      auto_advance:'false',
      'expand[0]':'payment_intent'
    }
  );

  let paid=finalized;

  if(
    finalized.status!=='paid' &&
    Number(
      finalized.amount_remaining||0
    )>0
  ){
    try{
      paid=await manageStripe(
        'POST',
        'invoices/'+
          encodeURIComponent(invoice.id)+
          '/pay',
        {
          'expand[0]':
            'payment_intent'
        }
      );
    }catch(paymentError){
      /*
       * Some cards require additional authentication.
       * In that case the Stripe hosted invoice can finish
       * payment and invoice.paid applies the upgrade.
       */
      console.warn(
        'Exact upgrade invoice needs customer action:',
        paymentError?.message||
        paymentError
      );

      try{
        paid=await manageStripe(
          'GET',
          'invoices/'+
            encodeURIComponent(
              invoice.id
            ),
          {
            'expand[]':
              'payment_intent'
          }
        );
      }catch(_lookupError){
        paid=finalized;
      }
    }
  }

  return paid;
}

async function upgradeNow({
  employerId,
  ent,
  sub,
  currentPlan,
  targetPlan,
  billing
}){
  const item=sub?.items?.data?.[0];

  if(!item?.id){
    throw new Error(
      'Stripe subscription item could not be identified.'
    );
  }

  const money=planChangeMoney(
    billing,
    currentPlan,
    targetPlan
  );

  if(money.difference_cents<=0){
    throw new Error(
      'The selected plan is not a higher-priced Alygnn plan.'
    );
  }

  /*
   * Any previously scheduled downgrade/cancellation is
   * removed before starting an immediate upgrade.
   */
  await releaseSchedule(
    sub,
    ent
  );

  if(sub?.cancel_at_period_end===true){
    sub=await manageStripe(
      'POST',
      'subscriptions/'+
        encodeURIComponent(sub.id),
      {
        cancel_at_period_end:'false'
      }
    );
  }

  const targetPrice=
    await ensureRecurringPrice(
      targetPlan,
      billing
    );

  const invoice=
    await createExactUpgradeInvoice({
      employerId,
      sub,
      currentPlan,
      targetPlan,
      billing,
      targetPrice,

      differenceCents:
        money.difference_cents
    });

  const paymentIntent=
    typeof invoice?.payment_intent===
      'object'
      ?invoice.payment_intent
      :null;

  const paid=
    invoice?.status==='paid' ||
    Number(
      invoice?.amount_remaining||0
    )===0;

  if(!paid){
    return {
      change:
        'upgrade_payment_required',

      effective:
        'after_payment',

      pending_update:true,

      /*
       * EXACT plan-price difference.
       */
      amount_due_cents:
        money.difference_cents,

      amount_due_now_cents:
        money.difference_cents,

      next_renewal_amount_cents:
        money.target_cents,

      refund_cents:0,
      credit_cents:0,

      invoice_id:
        invoice?.id||null,

      hosted_invoice_url:
        invoice?.hosted_invoice_url||
        null,

      payment_intent_status:
        paymentIntent?.status||null,

      client_secret:
        paymentIntent?.client_secret||
        null,

      billing_period:
        billing
    };
  }

  const updated=
    await applyPaidUpgradeSubscription({
      employerId,
      ent,
      sub,
      targetPlan,
      billing,
      targetPrice
    });

  return {
    change:'upgrade_applied',
    effective:'immediate',

    amount_due_cents:
      money.difference_cents,

    amount_due_now_cents:
      money.difference_cents,

    amount_paid_cents:
      Number(
        invoice?.amount_paid||
        money.difference_cents
      ),

    next_renewal_amount_cents:
      money.target_cents,

    refund_cents:0,
    credit_cents:0,

    /*
     * Billing-cycle anchor is left unchanged.
     */
    current_period_end:
      updated.current_period_end
        ?new Date(
            Number(
              updated.current_period_end
            )*1000
          ).toISOString()
        :ent?.current_period_end||
          null,

    billing_period:
      billing
  };
}



function stripeCustomerId(sub,ent){
  return (
    (typeof sub?.customer==='string' ? sub.customer : sub?.customer?.id) ||
    ent?.stripe_plan_customer_id ||
    null
  );
}

function normalizePaymentMethod(pm){
  if(!pm || typeof pm!=='object')return null;

  if(pm.type==='card' && pm.card){
    return {
      type:'card',
      brand:String(pm.card.brand||'card').toLowerCase(),
      last4:String(pm.card.last4||''),
      exp_month:Number(pm.card.exp_month||0)||null,
      exp_year:Number(pm.card.exp_year||0)||null
    };
  }

  return {
    type:String(pm.type||'payment_method'),
    brand:String(pm.type||'payment method'),
    last4:'',
    exp_month:null,
    exp_year:null
  };
}

async function customerSnapshot(customerId,sub){
  if(!customerId)return {
    customer_id:null,
    email:null,
    payment_method:null,
    invoices:[]
  };

  let customer=null;
  try{
    customer=await manageStripe(
      'GET',
      'customers/'+encodeURIComponent(customerId),
      {'expand[]':'invoice_settings.default_payment_method'}
    );
  }catch(error){
    console.warn('Could not load Stripe customer:',error?.message||error);
  }

  let pm=
    customer?.invoice_settings?.default_payment_method ||
    sub?.default_payment_method ||
    null;

  if(typeof pm==='string'){
    try{
      pm=await manageStripe(
        'GET',
        'payment_methods/'+encodeURIComponent(pm)
      );
    }catch(error){
      console.warn('Could not load Stripe payment method:',error?.message||error);
      pm=null;
    }
  }

  let invoices=[];
  try{
    const result=await manageStripe('GET','invoices',{
      customer:customerId,
      limit:8
    });

    invoices=(result?.data||[]).map(invoice=>({
      id:invoice.id,
      number:invoice.number||null,
      created:invoice.created
        ? new Date(Number(invoice.created)*1000).toISOString()
        : null,
      status:String(invoice.status||'').toLowerCase(),
      amount_paid_cents:Number(invoice.amount_paid||0),
      amount_due_cents:Number(invoice.amount_due||0),
      currency:String(invoice.currency||'usd').toLowerCase(),
      hosted_invoice_url:invoice.hosted_invoice_url||null,
      invoice_pdf:invoice.invoice_pdf||null,
      description:
        invoice.lines?.data?.[0]?.description ||
        invoice.description ||
        null
    }));
  }catch(error){
    console.warn('Could not load Stripe invoice history:',error?.message||error);
  }

  return {
    customer_id:customerId,
    email:customer?.email||null,
    payment_method:normalizePaymentMethod(pm),
    invoices
  };
}

function calculateNextPlanCharge(ent,sub){
  const currentPlan=subscriptionPlan(ent,sub);
  const billing=subscriptionBilling(ent,sub);

  if(
    sub?.cancel_at_period_end===true ||
    (
      String(ent?.pending_plan||'').toLowerCase()==='free' &&
      !!ent?.pending_plan_effective_at
    )
  ){
    return 0;
  }

  const pending=String(ent?.pending_plan||'').toLowerCase();
  const pendingBilling=String(
    ent?.pending_billing_period||billing
  ).toLowerCase();

  if(MANAGE_CATALOG[pendingBilling]?.[pending]){
    return MANAGE_CATALOG[pendingBilling][pending].cents;
  }

  return MANAGE_CATALOG[billing]?.[currentPlan]?.cents ??
    Number(ent?.plan_amount_cents||0);
}

async function billingAccountSummary(user,ent,planSub,secondSub){
  const ids=[
    stripeCustomerId(planSub,ent),
    typeof secondSub?.customer==='string'
      ? secondSub.customer
      : secondSub?.customer?.id
  ].filter(Boolean);

  const uniqueIds=[...new Set(ids)];
  const snapshots=[];

  for(const customerId of uniqueIds){
    const related=
      stripeCustomerId(planSub,ent)===customerId
        ? planSub
        : secondSub;

    snapshots.push(
      await customerSnapshot(customerId,related)
    );
  }

  const paymentMethod=
    snapshots.map(row=>row.payment_method).find(Boolean) ||
    null;

  const stripeEmail=
    snapshots.map(row=>row.email).find(Boolean) ||
    null;

  const invoices=[];
  const seen=new Set();

  for(const snap of snapshots){
    for(const invoice of snap.invoices||[]){
      if(!invoice?.id || seen.has(invoice.id))continue;
      seen.add(invoice.id);
      invoices.push(invoice);
    }
  }

  invoices.sort((a,b)=>{
    const at=a?.created?new Date(a.created).getTime():0;
    const bt=b?.created?new Date(b.created).getTime():0;
    return bt-at;
  });

  return {
    billing_email:stripeEmail||user?.email||null,
    payment_method:paymentMethod,
    invoices:invoices.slice(0,8),
    stripe_customer_count:uniqueIds.length,
    next_plan_charge_cents:calculateNextPlanCharge(ent,planSub)
  };
}

async function createBillingPortalSession({user,ent,planSub,input}){
  if(ent?.test_mode===true){
    const error=new Error(
      'Developer test billing has no Stripe payment method or invoices. Payment method & invoices is available after a real Stripe checkout.'
    );
    error.status=409;
    error.test_mode=true;
    throw error;
  }

  let secondSub=null;
  let customerId=stripeCustomerId(planSub,ent);

  if(!customerId){
    try{
      secondSub=await resolveSecondSlotSubscription(user.id);
      customerId=
        typeof secondSub?.customer==='string'
          ?secondSub.customer
          :secondSub?.customer?.id||null;
    }catch(error){
      console.warn(
        'Could not resolve customer for billing portal:',
        error?.message||error
      );
    }
  }

  if(!customerId){
    const error=new Error(
      'No Stripe billing profile exists for this account yet. Complete a paid checkout first.'
    );
    error.status=409;
    throw error;
  }

  const returnUrl=allowedReturnUrl(
    input.return_url||input.success_url,
    'https://alygnn.com/employer-account.html#billing'
  );

  const session=await manageStripe(
    'POST',
    'billing_portal/sessions',
    {
      customer:customerId,
      return_url:returnUrl
    }
  );

  if(!session?.url){
    throw new Error('Stripe could not open the billing portal.');
  }

  return {
    url:session.url,
    id:session.id||null
  };
}

async function runManageAction(res,user,input){
  const action=String(input.action||'summary').toLowerCase();

  let ent=await getEntitlement(user.id);

  ent=await applyDueTestPlanChange(
    user.id,
    ent
  );

  // Migrate any stale Launch/Growth/Scale slot limits from older pricing.
  // This fixes old values such as Scale = 14 and restores Scale to 8 paid
  // slots + the permanent free slot = 9 total reusable slots.
  ent=await normalizeCanonicalPlanEntitlement(
    user.id,
    ent
  );

  /*
   * IMPORTANT:
   * Developer/test billing must never touch Stripe.
   *
   * Previously the API tried to resolve a Stripe subscription BEFORE it
   * reached the test-mode plan-change branch. That caused:
   *
   *   STRIPE_SECRET_KEY is not configured.
   *
   * even though the user was explicitly using $0 developer test billing.
   */
  let sub=
    ent?.test_mode===true
      ?null
      :shouldResolveSubscription(ent)
        ?await resolveSubscription(
            user.id,
            ent
          )
        :null;

  ent=await getEntitlement(user.id);

  if([
    'billing_portal',
    'customer_portal',
    'payment_method',
    'payment_methods',
    'payment_method_and_invoices',
    'manage_billing'
  ].includes(action)){
    const portal=await createBillingPortalSession({
      user,
      ent,
      planSub:sub,
      input
    });
    return send(res,200,{ok:true,...portal});
  }

  if(action==='summary'){
    let secondSlot=null;

    /*
     * Test billing intentionally has no Stripe subscription/payment data.
     */
    if(ent?.test_mode!==true){
      try{
        secondSlot=
          await resolveSecondSlotSubscription(
            user.id
          );
      }catch(error){
        console.warn(
          'Could not resolve Second Job Slot subscription:',
          error?.message||error
        );
      }
    }

    let billingAccount={
      billing_email:user?.email||null,
      payment_method:null,
      invoices:[],
      stripe_customer_count:0,
      next_plan_charge_cents:
        calculateNextPlanCharge(
          ent,
          sub
        )
    };

    if(ent?.test_mode!==true){
      try{
        billingAccount=
          await billingAccountSummary(
            user,
            ent,
            sub,
            secondSlot
          );
      }catch(error){
        console.warn(
          'Could not load billing account summary:',
          error?.message||error
        );
      }
    }

    return send(res,200,{
      ok:true,
      summary:{
        ...subscriptionSummary(ent,sub),
        second_job_slot:secondSlotSummary(secondSlot),
        billing_account:billingAccount
      }
    });
  }

  if(action==='cancel_scheduled_change'){
    if(sub)await releaseSchedule(sub,ent);
    await patchEntitlement(user.id,{
      stripe_plan_schedule_id:null,
      pending_plan:null,
      pending_billing_period:null,
      pending_plan_effective_at:null
    });
    return send(res,200,{ok:true,change:'scheduled_change_canceled'});
  }

  if(action==='cancel_plan'){
    const result=await cancelPlanAtRenewal({
      employerId:user.id,
      ent,
      sub
    });
    return send(res,200,{ok:true,...result});
  }

  if(action==='resume_plan'){
    const result=await resumePlanRenewal({
      employerId:user.id,
      ent,
      sub
    });
    return send(res,200,{ok:true,...result});
  }

  if(action==='cancel_second_slot'){
    const secondSlot=await resolveSecondSlotSubscription(user.id);
    const result=await cancelSecondSlotAtRenewal({sub:secondSlot});
    return send(res,200,{ok:true,...result});
  }

  if(action==='resume_second_slot'){
    const secondSlot=await resolveSecondSlotSubscription(user.id);
    const result=await resumeSecondSlotRenewal({sub:secondSlot});
    return send(res,200,{ok:true,...result});
  }

  if(action!=='change_plan'){
    return send(res,400,{error:'Unknown billing action.'});
  }

  const target=String(input.target_plan||'').toLowerCase();
  const current=subscriptionPlan(ent,sub);
  const billing=subscriptionBilling(ent,sub);
  const catalog=MANAGE_CATALOG[billing];

  if(!catalog?.[target]){
    return send(res,400,{error:'Choose Launch, Growth, or Scale.'});
  }

  if(
    ent?.test_mode===true &&
    entitlementLooksActive(ent) &&
    catalog?.[current]
  ){
    if(current===target){
      return send(res,200,{
        ok:true,
        change:'none',
        message:
          'You are already on this plan.'
      });
    }

    const result=
      await testModePlanChange({
        employerId:user.id,
        ent,
        currentPlan:current,
        targetPlan:target,
        billing
      });

    return send(
      res,
      200,
      {
        ok:true,
        ...result
      }
    );
  }

  if(
    !subscriptionIsActive(sub) ||
    !catalog?.[current]
  ){
    return send(res,409,{
      error:'This account does not have a recurring Alygnn plan that can be modified automatically. Choose a plan through secure checkout first.',
      requires_checkout:true,
      billing_period:billing
    });
  }

  if(current===target){
    return send(res,200,{
      ok:true,
      change:'none',
      message:'You are already on this plan.'
    });
  }

  // Choosing another plan means the employer wants billing to continue,
  // so a previously scheduled cancellation is automatically reversed.
  if(sub?.cancel_at_period_end===true){
    sub=await manageStripe(
      'POST',
      'subscriptions/'+encodeURIComponent(sub.id),
      {cancel_at_period_end:'false'}
    );
  }

  if(String(ent?.pending_plan||'').toLowerCase()==='free'){
    await patchEntitlement(user.id,{
      pending_plan:null,
      pending_billing_period:null,
      pending_plan_effective_at:null
    });
    ent=await getEntitlement(user.id);
  }

  const result=catalog[target].rank>catalog[current].rank
    ?await upgradeNow({
        employerId:user.id,
        ent,
        sub,
        currentPlan:current,
        targetPlan:target,
        billing
      })
    :await scheduleDowngrade({
        employerId:user.id,
        ent,
        sub,
        currentPlan:current,
        targetPlan:target,
        billing
      });

  return send(res,200,{ok:true,...result});
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

    // Billing & plan management shares this existing Vercel function so the
    // Hobby deployment stays below the Serverless Function limit.
    const billingAction = String(input.action || '').toLowerCase();
    if ([
      'summary',
      'change_plan',
      'cancel_scheduled_change',
      'cancel_plan',
      'resume_plan',
      'cancel_second_slot',
      'resume_second_slot',
      'billing_portal',
      'customer_portal',
      'payment_method',
      'payment_methods',
      'payment_method_and_invoices',
      'manage_billing'
    ].includes(billingAction)) {
      return await runManageAction(res, user, input);
    }

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
    let billingEmployerId = user.id;

    // Backward compatibility: the former $150 "single_job" product is now
    // the standalone $150/month Second Job Slot.
    if (!product && plan && plan !== 'single_job') product = 'job_plan';
    if (!product && plan === 'single_job') product = 'additional_slot';
    if (product === 'single_job') product = 'additional_slot';

    if (product === 'additional_slot') {
      const access = await getEmployerPostingAccess(token);

      if (!additionalSlotEligible(access)) {
        const paid =
          access?.active_paid_plan === true ||
          access?.base_paid_plan === true;

        return send(res, 400, {
          error: paid
            ? 'The $150/month Second Job Slot is only available on the Free employer account. Paid plans use the included free slot plus $99 Weekly Job Slots for temporary extra capacity.'
            : 'Your Second Job Slot is already active.'
        });
      }

      plan = 'second_job_slot';
      billing = 'monthly';
      name = 'Alygnn Second Job Slot';
      cents = 15000;
      slots = 1;
      mode = 'subscription';

    } else if (product === 'team_seat') {
      const access =
        await getTeamAccess(token);

      if (!access?.has_company) {
        return send(
          res,
          400,
          {
            error:
              'Create or join a company workspace before adding a team seat.'
          }
        );
      }

      const canManageBilling =
        access?.is_owner === true ||
        access?.can_manage_billing === true;

      if (!canManageBilling) {
        return send(
          res,
          403,
          {
            error:
              'You do not have Manage Billing access for this company.'
          }
        );
      }

      const teamPlan =
        String(
          access.plan || 'free'
        ).toLowerCase();

      if (
        ![
          'launch',
          'growth',
          'scale'
        ].includes(teamPlan)
      ) {
        return send(
          res,
          400,
          {
            error:
              'Team seats require an active Launch, Growth, or Scale plan.'
          }
        );
      }

      if (
        Number(
          access.available_seats || 0
        ) > 0
      ) {
        return send(
          res,
          409,
          {
            error:
              'You already have an available team seat. Invite the team member before purchasing another seat.'
          }
        );
      }

      if (
        access.can_purchase_seat !== true
      ) {
        const recommended =
          String(
            access.upgrade_recommended ||
            ''
          ).toLowerCase();

        return send(
          res,
          409,
          {
            error:
              recommended
                ? `Your ${teamPlan} team capacity is full. Upgrade to ${recommended} for more team access.`
                : 'Your current plan has reached its team-member limit.',
            recommend_upgrade:
              Boolean(recommended),
            recommended_plan:
              recommended || null
          }
        );
      }

      cents =
        Number(
          access.seat_price_cents || 0
        );

      if (
        ![9900,7500,5000]
          .includes(cents)
      ) {
        return send(
          res,
          400,
          {
            error:
              'The team-seat price could not be verified.'
          }
        );
      }

      billingEmployerId =
        String(
          access.owner_user_id ||
          user.id
        );

      plan = teamPlan;
      billing = 'monthly';
      mode = 'subscription';
      slots = 1;
      name =
        `Alygnn ${teamPlan.charAt(0).toUpperCase()+teamPlan.slice(1)} Team Seat`;

    } else if (product === 'job_boost') {
      const access =
        await getEmployerPostingAccess(token);

      const paidPlan =
        access?.active_paid_plan === true ||
        access?.base_paid_plan === true;

      if(!paidPlan){
        return send(res,403,{
          error:
            'Job Boost is available only with an active monthly or quarterly Launch, Growth, or Scale plan. Free accounts and standalone Second Job Slot accounts cannot boost jobs.'
        });
      }

      jobId = String(input.job_id || '');

      days = Math.max(
        1,
        Math.min(
          30,
          Number.parseInt(
            input.days ||
            Math.ceil(
              Number(input.duration_hours || 24) / 24
            ),
            10
          ) || 1
        )
      );

      if (!jobId){
        return send(res,400,{
          error:'Job ID is required for Job Boost.'
        });
      }

      await verifyOwnedActiveJob(
        token,
        user.id,
        jobId
      );

      name =
        `Alygnn Job Boost — ${days} day${days === 1 ? '' : 's'}`;

      cents = 1500 * days;
      billing = 'one_time';
      mode = 'payment';

    } else {
      product = 'job_plan';
      if (billing === 'weekly' || plan === 'weekly_slot') {
        billing = 'weekly';
        plan = 'weekly_slot';
      }
      const item = CHECKOUT_CATALOG[billing]?.[plan];
      if (!item) return send(res, 400, { error: 'Unknown Alygnn plan or billing period.' });

      if (billing === 'weekly' && plan === 'weekly_slot') {
        const access = await getEmployerPostingAccess(token);
        const decision = weeklyCheckoutDecision(access);

        if (!decision.allowed) {
          const recommended =
            decision.recommendedPlan === 'growth'
              ? 'Growth'
              : 'Scale';

          return send(res, 409, {
            error:
              `You already have one active $99 Weekly Job Slot. Upgrade to ${recommended} for better ongoing value instead of stacking another weekly slot.`,
            recommend_upgrade: true,
            recommended_plan: decision.recommendedPlan,
            billing_period: String(access?.billing_period || 'monthly').toLowerCase()
          });
        }
      }

      // Do not create a second paid plan while an employer already has one active.
      // Existing recurring subscribers change plans through Billing & plan so
      // upgrades can be prorated and downgrades can wait until renewal.
      if (billing === 'monthly' || billing === 'quarterly') {
        const access = await getEmployerPostingAccess(token);
        const currentPlan = String(access?.plan || '').toLowerCase();
        const currentBilling = String(access?.billing_period || '').toLowerCase();
        if (
          access?.active_paid_plan === true &&
          ['monthly','quarterly'].includes(currentBilling) &&
          ['launch','growth','scale','business','enterprise'].includes(currentPlan)
        ) {
          return send(res, 409, {
            error: 'You already have an active paid plan. Change it from Settings → Billing & plan so Alygnn can prorate upgrades or schedule downgrades correctly.',
            manage_plan: true
          });
        }
      }

      name = item.name;
      cents = item.cents;
      slots = item.slots;
      mode = item.mode;
    }

    const metadata = {
      employer_id: billingEmployerId,
      employer_email: user.email || '',
      product,
      plan,
      billing,
      slots: slots || '',
      job_id: jobId,
      days: days || '',
      unit_amount_cents:
        product === 'job_boost'
          ? '1500'
          : cents,
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
      params['line_items[0][price_data][recurring][interval_count]'] =
        product === 'job_plan' && billing === 'quarterly' ? 3 : 1;
    }

    Object.entries(metadata).forEach(([key, value]) => {
      params[`metadata[${key}]`] = value;
      if (mode === 'subscription') params[`subscription_data[metadata][${key}]`] = value;
      else params[`payment_intent_data[metadata][${key}]`] = value;
    });

    const session = await stripeCreateCheckout(params);
    return send(res, 200, { url: session.url, id: session.id });
  } catch (error) {
    console.error('Alygnn billing/checkout error:', error);
    return send(res, error.status&&error.status>=400&&error.status<500?error.status:500, { error: error?.message || 'Could not complete billing request.' });
  }
};
