// Vercel Node Function: /api/manage-subscription
// Alygnn recurring plan management for Launch / Growth / Scale.
//
// Required env vars:
//   STRIPE_SECRET_KEY
//   SUPABASE_URL=https://auth.alygnn.com
//   SUPABASE_ANON_KEY
//   SUPABASE_SERVICE_ROLE_KEY
//
// Optional stable Stripe Price IDs (recommended):
//   STRIPE_PRICE_LAUNCH_MONTHLY
//   STRIPE_PRICE_GROWTH_MONTHLY
//   STRIPE_PRICE_SCALE_MONTHLY
//   STRIPE_PRICE_LAUNCH_QUARTERLY
//   STRIPE_PRICE_GROWTH_QUARTERLY
//   STRIPE_PRICE_SCALE_QUARTERLY

const STRIPE_API='https://api.stripe.com/v1';

const PLAN_CATALOG={
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

function cors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type');
}
function send(res,status,payload){
  cors(res);res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(payload));
}
function body(req){
  if(!req.body)return {};
  if(typeof req.body==='object'&&!Buffer.isBuffer(req.body))return req.body;
  try{return JSON.parse(Buffer.isBuffer(req.body)?req.body.toString('utf8'):String(req.body));}catch(_){return {};}
}
function bearer(req){const v=String(req.headers.authorization||'');return v.toLowerCase().startsWith('bearer ')?v.slice(7).trim():'';}
function base(){return (process.env.SUPABASE_URL||'https://auth.alygnn.com').replace(/\/$/,'');}
function serviceHeaders(extra={}){
  const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!key)throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured.');
  return {apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',...extra};
}
async function currentUser(token){
  const anon=process.env.SUPABASE_ANON_KEY;
  if(!anon)throw new Error('SUPABASE_ANON_KEY is not configured.');
  const r=await fetch(base()+'/auth/v1/user',{headers:{apikey:anon,Authorization:'Bearer '+token}});
  const data=await r.json().catch(()=>({}));
  if(!r.ok||!data?.id){const e=new Error('Invalid employer session.');e.status=401;throw e;}
  return data;
}
async function getEntitlement(employerId){
  const url=new URL(base()+'/rest/v1/employer_entitlements');
  url.searchParams.set('employer_id','eq.'+employerId);
  url.searchParams.set('select','*');
  url.searchParams.set('limit','1');
  const r=await fetch(url,{headers:serviceHeaders()});
  const rows=await r.json().catch(()=>[]);
  if(!r.ok)throw new Error(rows?.message||'Could not load billing entitlement.');
  return Array.isArray(rows)?(rows[0]||{}):{};
}
async function patchEntitlement(employerId,patch){
  const url=new URL(base()+'/rest/v1/employer_entitlements');
  url.searchParams.set('employer_id','eq.'+employerId);
  const r=await fetch(url,{
    method:'PATCH',
    headers:serviceHeaders({Prefer:'return=minimal'}),
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
  return PLAN_CATALOG[billing]?.[plan]||null;
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

async function stripe(method,path,params){
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
  const p=PLAN_CATALOG[billing]?.[plan];
  if(!p)throw new Error('Unknown recurring plan.');
  const envKey=`STRIPE_PRICE_${plan.toUpperCase()}_${billing.toUpperCase()}`;
  if(process.env[envKey])return process.env[envKey];
  const listed=await stripe('GET','prices',{'lookup_keys[]':p.lookup,active:'true',limit:1});
  if(listed?.data?.[0]?.id)return listed.data[0].id;
  const created=await stripe('POST','prices',{
    currency:'usd',unit_amount:p.cents,lookup_key:p.lookup,
    'recurring[interval]':p.interval,'recurring[interval_count]':p.intervalCount,
    'product_data[name]':p.name,
    'metadata[alygnn_plan]':plan,'metadata[billing]':billing
  });
  return created.id;
}

async function searchPlanSubscription(employerId){
  const q=`metadata[\"employer_id\"]:\"${employerId}\" AND metadata[\"product\"]:\"job_plan\"`;
  const found=await stripe('GET','subscriptions/search',{query:q,limit:20});
  const rows=(found?.data||[]).filter(s=>!['canceled','incomplete_expired'].includes(String(s.status||'')));
  rows.sort((a,b)=>(b.created||0)-(a.created||0));
  return rows[0]||null;
}
async function resolveSubscription(employerId,ent){
  let sub=null;
  const stored=String(ent?.stripe_plan_subscription_id||'').trim();
  if(stored){try{sub=await stripe('GET','subscriptions/'+encodeURIComponent(stored));}catch(_){} }
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
  const p=PLAN_CATALOG[billing]?.[plan]||null;
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
    stripe_subscription_id:sub?.id||ent?.stripe_plan_subscription_id||null,
    managed_subscription:!!sub
  };
}
async function releaseSchedule(sub,ent){
  const scheduleId=(typeof sub?.schedule==='string'?sub.schedule:sub?.schedule?.id)||ent?.stripe_plan_schedule_id;
  if(!scheduleId)return;
  try{await stripe('POST','subscription_schedules/'+encodeURIComponent(scheduleId)+'/release',{});}catch(error){
    if(!/released|completed|not found|no such subscription schedule/i.test(error.message||''))throw error;
  }
}
async function scheduleDowngrade({employerId,ent,sub,currentPlan,targetPlan,billing}){
  const item=sub?.items?.data?.[0];
  const currentPriceId=typeof item?.price==='string'?item.price:item?.price?.id;
  if(!item?.id||!currentPriceId)throw new Error('Stripe subscription item could not be identified.');
  const targetPrice=await ensureRecurringPrice(targetPlan,billing);

  let scheduleId=(typeof sub.schedule==='string'?sub.schedule:sub.schedule?.id)||ent?.stripe_plan_schedule_id||null;
  let schedule=null;
  if(scheduleId){
    schedule=await stripe('GET','subscription_schedules/'+encodeURIComponent(scheduleId));
  }else{
    schedule=await stripe('POST','subscription_schedules',{from_subscription:sub.id});
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
  const intervalCount=PLAN_CATALOG[billing][targetPlan].intervalCount;

  await stripe('POST','subscription_schedules/'+encodeURIComponent(scheduleId),{
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

  // A previously scheduled downgrade must be removed before an immediate upgrade.
  await releaseSchedule(sub,ent);
  const targetPrice=await ensureRecurringPrice(targetPlan,billing);
  const updated=await stripe('POST','subscriptions/'+encodeURIComponent(sub.id),{
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

module.exports=async function handler(req,res){
  cors(res);
  if(req.method==='OPTIONS')return send(res,204,{});
  if(req.method!=='POST')return send(res,405,{error:'Method not allowed.'});

  try{
    const token=bearer(req);
    if(!token)return send(res,401,{error:'Authentication required.'});
    const user=await currentUser(token);
    const input=body(req);
    const action=String(input.action||'summary').toLowerCase();

    let ent=await getEntitlement(user.id);
    let sub=shouldResolveSubscription(ent)?await resolveSubscription(user.id,ent):null;
    ent=await getEntitlement(user.id);

    if(action==='summary'){
      return send(res,200,{ok:true,summary:subscriptionSummary(ent,sub)});
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

    if(action!=='change_plan')return send(res,400,{error:'Unknown billing action.'});

    const target=String(input.target_plan||'').toLowerCase();
    const current=subscriptionPlan(ent,sub);
    const billing=subscriptionBilling(ent,sub);
    const catalog=PLAN_CATALOG[billing];

    if(!catalog?.[target])return send(res,400,{error:'Choose Launch, Growth, or Scale.'});
    if(!subscriptionIsActive(sub)||!catalog?.[current]){
      return send(res,409,{
        error:'This account does not have a recurring Alygnn plan that can be modified automatically. Choose a plan through secure checkout first.',
        requires_checkout:true,
        billing_period:billing
      });
    }
    if(current===target)return send(res,200,{ok:true,change:'none',message:'You are already on this plan.'});

    const result=catalog[target].rank>catalog[current].rank
      ?await upgradeNow({employerId:user.id,ent,sub,targetPlan:target,billing})
      :await scheduleDowngrade({employerId:user.id,ent,sub,currentPlan:current,targetPlan:target,billing});

    return send(res,200,{ok:true,...result});
  }catch(error){
    console.error('Alygnn plan management error:',error);
    return send(res,error.status&&error.status>=400&&error.status<500?error.status:500,{error:error?.message||'Could not manage this subscription.'});
  }
};
