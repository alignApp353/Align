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

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    const supabase = serviceClient();
    const admin = await requireAdmin(req, supabase);

    if (req.method === 'GET') {
      const allowedStatuses = new Set(['pending_review', 'approved', 'rejected']);
      const requestedStatus = String(req.query.status || 'pending_review');
      const status = allowedStatuses.has(requestedStatus)
        ? requestedStatus
        : 'pending_review';

      const { data, error } = await supabase
        .from('employer_verifications')
        .select(
          [
            'user_id',
            'company_id',
            'company_name',
            'website',
            'business_phone',
            'industry',
            'company_size',
            'headquarters',
            'ein_last4',
            'verification_status',
            'rejection_reason',
            'created_at',
            'updated_at'
          ].join(',')
        )
        .eq('verification_status', status)
        .order('created_at', { ascending: true });

      if (error) throw error;

      const reviews = await addSignedUrls(supabase, data || []);

      return sendJson(res, 200, {
        success: true,
        reviews
      });
    }

    if (req.method === 'PATCH') {
      const body =
        typeof req.body === 'string'
          ? JSON.parse(req.body || '{}')
          : req.body || {};

      const companyId = String(body.company_id || '').trim();
      const decision = String(body.decision || '').trim();
      const reason = String(body.reason || '').trim();

      if (!companyId) {
        return sendJson(res, 400, {
          success: false,
          error: 'A company ID is required.'
        });
      }

      if (!['approved', 'rejected'].includes(decision)) {
        return sendJson(res, 400, {
          success: false,
          error: 'Decision must be approved or rejected.'
        });
      }

      if (decision === 'rejected' && !reason) {
        return sendJson(res, 400, {
          success: false,
          error: 'Enter a reason before declining the employer.'
        });
      }

      const now = new Date().toISOString();

      const { error: verificationError } = await supabase
        .from('employer_verifications')
        .update({
          verification_status: decision,
          reviewed_by: admin.id,
          reviewed_at: now,
          rejection_reason: decision === 'rejected' ? reason : null,
          updated_at: now
        })
        .eq('company_id', companyId);

      if (verificationError) throw verificationError;

      const { error: companyError } = await supabase
        .from('companies')
        .update({
          verification_status: decision
        })
        .eq('id', companyId);

      if (companyError) throw companyError;

      const { error: documentError } = await supabase
        .from('employer_verification_documents')
        .update({
          review_status: decision
        })
        .eq('company_id', companyId)
        .eq('review_status', 'pending_review');

      if (documentError) throw documentError;

      return sendJson(res, 200, {
        success: true,
        company_id: companyId,
        verification_status: decision
      });
    }

    res.setHeader('Allow', 'GET, PATCH, OPTIONS');
    return sendJson(res, 405, {
      success: false,
      error: 'Method not allowed.'
    });
  } catch (error) {
    console.error('Employer verification admin error:', error);
    return sendJson(res, error.status || 500, {
      success: false,
      error: error.message || 'Unable to process the employer review.'
    });
  }
};
