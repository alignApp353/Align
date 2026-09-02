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
  const anon=process.env.SUPABASE_ANON_KEY;
  if(!anon)throw new Error('SUPABASE_ANON_KEY is not configured.');
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
  return {
    current_plan:plan,
    billing_period:billing,
    subscription_status:String(sub?.status||ent?.subscription_status||'free').toLowerCase(),
    current_period_end:endUnix?new Date(endUnix*1000).toISOString():(ent?.current_period_end||null),
    amount_cents:p?.cents??Number(ent?.plan_amount_cents||0),
    slot_limit:Number(ent?.slot_limit||p?.slots||1),
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
  return {change:'downgrade_scheduled',effective_at:new Date(end*1000).toISOString(),schedule_id:scheduleId,billing_period:billing};
}
async function upgradeNow({employerId,ent,sub,targetPlan,billing}){
  const item=sub?.items?.data?.[0];
  if(!item?.id)throw new Error('Stripe subscription item could not be identified.');

  // A previously scheduled downgrade/cancellation must be removed before an immediate upgrade.
  await releaseSchedule(sub,ent);
  const targetPrice=await ensureRecurringPrice(targetPlan,billing);
  const updated=await manageStripe('POST','subscriptions/'+encodeURIComponent(sub.id),{
    cancel_at_period_end:'false',
    'items[0][id]':item.id,
    'items[0][price]':targetPrice,
    'items[0][quantity]':1,
    proration_behavior:'always_invoice',
    payment_behavior:'pending_if_incomplete',
    'metadata[employer_id]':employerId,
    'metadata[product]':'job_plan',
    'metadata[plan]':targetPlan,
    'metadata[billing]':billing,
    'expand[0]':'latest_invoice.payment_intent'
  });

  await patchEntitlement(employerId,{
    stripe_plan_subscription_id:updated.id,
    stripe_plan_customer_id:typeof updated.customer==='string'?updated.customer:updated.customer?.id||null,
    stripe_plan_schedule_id:null,
    pending_plan:null,
    pending_billing_period:null,
    pending_plan_effective_at:null
  });

  const invoice=typeof updated.latest_invoice==='object'?updated.latest_invoice:null;
  const paymentIntent=typeof invoice?.payment_intent==='object'?invoice.payment_intent:null;
  return {
    change:'upgrade_requested',
    effective:'immediate_after_payment',
    amount_due_cents:invoice?.amount_due??null,
    amount_paid_cents:invoice?.amount_paid??null,
    hosted_invoice_url:invoice?.hosted_invoice_url||null,
    payment_intent_status:paymentIntent?.status||null,
    payment_status:invoice?.status||updated.status,
    pending_update:!!updated.pending_update,
    billing_period:billing
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

async function runManageAction(res,user,input){
  const action=String(input.action||'summary').toLowerCase();

  let ent=await getEntitlement(user.id);
  let sub=shouldResolveSubscription(ent)?await resolveSubscription(user.id,ent):null;
  ent=await getEntitlement(user.id);

  if(action==='summary'){
    let secondSlot=null;

    try{
      secondSlot=await resolveSecondSlotSubscription(user.id);
    }catch(error){
      console.warn(
        'Could not resolve Second Job Slot subscription:',
        error?.message||error
      );
    }

    let billingAccount={
      billing_email:user?.email||null,
      payment_method:null,
      invoices:[],
      stripe_customer_count:0,
      next_plan_charge_cents:calculateNextPlanCharge(ent,sub)
    };

    try{
      billingAccount=await billingAccountSummary(
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

  if(!subscriptionIsActive(sub)||!catalog?.[current]){
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
      'resume_second_slot'
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
