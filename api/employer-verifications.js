'use strict';

const { createClient } = require('@supabase/supabase-js');

function applyCors(req, res) {
  const allowedOrigins = new Set([
    'https://alygnn.com',
    'https://www.alygnn.com',
    'http://localhost:3000',
    'http://localhost:5173',
    'capacitor://localhost'
  ]);

  const origin = String(req.headers.origin || '').trim();

  if (
    allowedOrigins.has(origin) ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, payload) {
  res.status(status).json(payload);
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  return header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : '';
}

function adminEmails() {
  return new Set(
    String(process.env.ALYGNN_ADMIN_EMAILS || '')
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

function serviceClient() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Server configuration is incomplete.');
  }

  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    }
  );
}

async function requireAdmin(req, supabase) {
  const token = bearerToken(req);

  if (!token) {
    const error = new Error('Sign in before opening the admin review page.');
    error.status = 401;
    throw error;
  }

  const { data, error } = await supabase.auth.getUser(token);
  const user = data?.user;

  if (error || !user) {
    const authError = new Error('Your login session is invalid or expired.');
    authError.status = 401;
    throw authError;
  }

  const allowed = adminEmails();

  if (!allowed.size || !allowed.has(String(user.email || '').toLowerCase())) {
    const permissionError = new Error('This account is not authorized to review employers.');
    permissionError.status = 403;
    throw permissionError;
  }

  return user;
}

async function latestDocuments(supabase, companyIds) {
  if (!companyIds.length) return new Map();

  const { data, error } = await supabase
    .from('employer_verification_documents')
    .select(
      'id, company_id, storage_path, original_file_name, document_type, review_status, created_at'
    )
    .in('company_id', companyIds)
    .order('created_at', { ascending: false });

  if (error) throw error;

  const map = new Map();

  for (const document of data || []) {
    if (!map.has(document.company_id)) {
      map.set(document.company_id, document);
    }
  }

  return map;
}

async function addSignedUrls(supabase, rows) {
  const documentMap = await latestDocuments(
    supabase,
    rows.map(row => row.company_id).filter(Boolean)
  );

  return Promise.all(
    rows.map(async row => {
      const document = documentMap.get(row.company_id) || null;
      let documentUrl = '';

      if (document?.storage_path) {
        const { data, error } = await supabase.storage
          .from('employer-verification-documents')
          .createSignedUrl(document.storage_path, 300);

        if (!error) documentUrl = data?.signedUrl || '';
      }

      return {
        ...row,
        document,
        document_url: documentUrl
      };
    })
  );
}

module.exports = async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const supabase = serviceClient();
    const admin = await requireAdmin(req, supabase);

    if (req.method === 'GET') {
      const requestedStatus = String(req.query.status || 'pending_review').trim();
      const allowedStatuses = new Set(['pending_review','approved','rejected','deactivated']);
      const status = allowedStatuses.has(requestedStatus) ? requestedStatus : 'pending_review';
      let rows = [];

      if (status === 'deactivated') {
        const {data:companies,error:companyError}=await supabase
          .from('companies').select('id').eq('account_status','deactivated');
        if(companyError)throw companyError;
        const ids=(companies||[]).map(row=>row.id).filter(Boolean);
        if(ids.length){
          const {data,error}=await supabase.from('employer_verifications')
            .select('user_id,company_id,company_name,website,business_phone,industry,company_size,headquarters,ein_last4,verification_status,rejection_reason,created_at,updated_at')
            .in('company_id',ids).order('created_at',{ascending:true});
          if(error)throw error;
          rows=data||[];
        }
      }else{
        const {data,error}=await supabase.from('employer_verifications')
          .select('user_id,company_id,company_name,website,business_phone,industry,company_size,headquarters,ein_last4,verification_status,rejection_reason,created_at,updated_at')
          .eq('verification_status',status).order('created_at',{ascending:true});
        if(error)throw error;
        rows=data||[];
      }

      const ids=rows.map(row=>row.company_id).filter(Boolean);
      const companyMap=new Map();
      if(ids.length){
        const {data:companies,error}=await supabase.from('companies')
          .select('id,account_number,account_status').in('id',ids);
        if(error)throw error;
        for(const company of companies||[])companyMap.set(company.id,company);
      }

      const enriched=rows.map(row=>({
        ...row,
        account_number:companyMap.get(row.company_id)?.account_number||null,
        account_status:companyMap.get(row.company_id)?.account_status||'active'
      }));
      const reviews=await addSignedUrls(supabase,enriched);
      return sendJson(res,200,{success:true,reviews});
    }

    if (req.method === 'PATCH') {
      const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
      const companyId=String(body.company_id||'').trim();
      // Current admin page sends action; older page sent decision. Support both.
      const action=String(body.action||body.decision||'').trim();
      const reason=String(body.reason||'').trim();

      if(!companyId)return sendJson(res,400,{success:false,error:'A company ID is required.'});
      const allowed=new Set(['approved','rejected','pending_review','deactivate','reactivate']);
      if(!allowed.has(action))return sendJson(res,400,{success:false,error:'Unsupported employer review action.'});
      if((action==='rejected'||action==='deactivate')&&!reason){
        return sendJson(res,400,{success:false,error:'Enter a reason before continuing.'});
      }

      const now=new Date().toISOString();
      const {data:verificationRow,error:lookupError}=await supabase
        .from('employer_verifications').select('user_id,company_id,verification_status')
        .eq('company_id',companyId).maybeSingle();
      if(lookupError)throw lookupError;

      if(action==='deactivate'||action==='reactivate'){
        const {error}=await supabase.from('companies')
          .update({account_status:action==='deactivate'?'deactivated':'active'})
          .eq('id',companyId);
        if(error)throw error;
        return sendJson(res,200,{success:true,company_id:companyId,account_status:action==='deactivate'?'deactivated':'active'});
      }

      const {data:latestDocument,error:documentLookupError}=await supabase
        .from('employer_verification_documents').select('id,review_status')
        .eq('company_id',companyId).order('created_at',{ascending:false}).limit(1).maybeSingle();
      if(documentLookupError)throw documentLookupError;
      if(action==='approved'&&!latestDocument){
        return sendJson(res,400,{success:false,error:'A verification document must be uploaded before this employer can be approved.'});
      }

      // One admin decision must be reflected everywhere Alygnn still reads
      // verification state. `companies` / `employer_verifications` are canonical,
      // while several employer-facing website pages still read the legacy fields
      // on `profiles`, so keep them in lockstep here on the server.
      const returningToPending=action==='pending_review';

      const {error:verificationError}=await supabase.from('employer_verifications').update({
        verification_status:action,
        reviewed_by:returningToPending?null:admin.id,
        reviewed_at:returningToPending?null:now,
        rejection_reason:action==='rejected'?reason:null,
        updated_at:now
      }).eq('company_id',companyId);
      if(verificationError)throw verificationError;

      const {error:companyError}=await supabase.from('companies')
        .update({verification_status:action}).eq('id',companyId);
      if(companyError)throw companyError;

      // Sync every active Alygnn employer account attached to this company, not
      // only the original owner/submitting user. That prevents the Account page,
      // Dashboard, team members, and admin queue from showing different states.
      const profileIds=new Set();
      if(verificationRow?.user_id)profileIds.add(verificationRow.user_id);

      const {data:members,error:memberLookupError}=await supabase
        .from('company_members')
        .select('user_id,membership_status')
        .eq('company_id',companyId)
        .in('membership_status',['active','pending']);

      if(memberLookupError){
        console.warn('Company member verification sync lookup failed:',memberLookupError);
      }else{
        for(const member of members||[]){
          if(member?.user_id)profileIds.add(member.user_id);
        }
      }

      if(profileIds.size){
        const {error:profileError}=await supabase.from('profiles').update({
          verification_status:action,
          employer_verified:action==='approved'
        }).in('id',[...profileIds]);
        if(profileError)throw profileError;
      }

      // Keep the latest uploaded verification document in the same state too.
      // This is especially important for Move to Pending after an approval.
      if(latestDocument?.id){
        const {error:documentError}=await supabase.from('employer_verification_documents')
          .update({
            review_status:action,
            rejection_reason:action==='rejected'?reason:null,
            reviewed_by:returningToPending?null:admin.id,
            reviewed_at:returningToPending?null:now
          })
          .eq('id',latestDocument.id);
        if(documentError)throw documentError;
      }

      return sendJson(res,200,{
        success:true,
        company_id:companyId,
        verification_status:action,
        synced_profile_count:profileIds.size
      });
    }

    res.setHeader('Allow','GET, PATCH, OPTIONS');
    return sendJson(res,405,{success:false,error:'Method not allowed.'});
  } catch (error) {
    console.error('Employer verification admin error:',error);
    return sendJson(res,error.status||500,{success:false,error:error.message||'Unable to process the employer review.'});
  }
};
