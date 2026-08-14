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
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type'
  );
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, payload) {
  return res.status(status).json(payload);
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
  if (
    !process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
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
    const error = new Error(
      'Sign in before opening the admin review page.'
    );
    error.status = 401;
    throw error;
  }

  const { data, error } = await supabase.auth.getUser(token);
  const user = data?.user;

  if (error || !user) {
    const authError = new Error(
      'Your login session is invalid or expired.'
    );
    authError.status = 401;
    throw authError;
  }

  const allowed = adminEmails();

  if (
    !allowed.size ||
    !allowed.has(String(user.email || '').toLowerCase())
  ) {
    const permissionError = new Error(
      'This account is not authorized to review employers.'
    );
    permissionError.status = 403;
    throw permissionError;
  }

  return user;
}

async function latestDocuments(supabase, companyIds) {
  if (!companyIds.length) {
    return new Map();
  }

  const { data, error } = await supabase
    .from('employer_verification_documents')
    .select(
      [
        'id',
        'company_id',
        'storage_path',
        'original_file_name',
        'document_type',
        'review_status',
        'rejection_reason',
        'reviewed_by',
        'reviewed_at',
        'created_at'
      ].join(',')
    )
    .in('company_id', companyIds)
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  const map = new Map();

  for (const document of data || []) {
    if (!map.has(document.company_id)) {
      map.set(document.company_id, document);
    }
  }

  return map;
}

async function companyRecords(supabase, companyIds) {
  if (!companyIds.length) {
    return new Map();
  }

  const { data, error } = await supabase
    .from('companies')
    .select(
      [
        'id',
        'company_name',
        'account_number',
        'owner_user_id',
        'verification_status',
        'account_status',
        'deactivation_reason',
        'deactivated_at',
        'deactivated_by',
        'reactivated_at',
        'reactivated_by'
      ].join(',')
    )
    .in('id', companyIds);

  if (error) {
    throw error;
  }

  return new Map(
    (data || []).map(company => [
      String(company.id),
      company
    ])
  );
}

async function addReviewDetails(supabase, rows) {
  const companyIds = [
    ...new Set(
      rows
        .map(row => row.company_id)
        .filter(Boolean)
        .map(String)
    )
  ];

  const documentMap = await latestDocuments(
    supabase,
    companyIds
  );

  const companyMap = await companyRecords(
    supabase,
    companyIds
  );

  return Promise.all(
    rows.map(async row => {
      const company =
        companyMap.get(String(row.company_id)) || null;

      const document =
        documentMap.get(row.company_id) || null;

      let documentUrl = '';

      if (document?.storage_path) {
        const { data, error } = await supabase.storage
          .from('employer-verification-documents')
          .createSignedUrl(
            document.storage_path,
            300
          );

        if (!error) {
          documentUrl = data?.signedUrl || '';
        }
      }

      return {
        ...row,

        company_name:
          row.company_name ||
          company?.company_name ||
          '',

        account_number:
          company?.account_number || '',

        account_status:
          company?.account_status || 'active',

        deactivation_reason:
          company?.deactivation_reason || '',

        deactivated_at:
          company?.deactivated_at || null,

        reactivated_at:
          company?.reactivated_at || null,

        document,

        document_url: documentUrl
      };
    })
  );
}

async function getVerificationRows(
  supabase,
  status
) {
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
        'reviewed_by',
        'reviewed_at',
        'created_at',
        'updated_at'
      ].join(',')
    )
    .eq('verification_status', status)
    .order('created_at', { ascending: true });

  if (error) {
    throw error;
  }

  const reviews = await addReviewDetails(
    supabase,
    data || []
  );

  /*
   * Deactivated companies get their own admin tab.
   * Do not also show them inside Approved,
   * Pending or Rejected.
   */
  return reviews.filter(
    review =>
      String(
        review.account_status || 'active'
      ).toLowerCase() !== 'deactivated'
  );
}

async function getDeactivatedRows(supabase) {
  const { data: companies, error } = await supabase
    .from('companies')
    .select(
      [
        'id',
        'company_name',
        'account_number',
        'owner_user_id',
        'verification_status',
        'account_status',
        'deactivation_reason',
        'deactivated_at',
        'deactivated_by',
        'reactivated_at'
      ].join(',')
    )
    .eq('account_status', 'deactivated')
    .order('deactivated_at', {
      ascending: false,
      nullsFirst: false
    });

  if (error) {
    throw error;
  }

  if (!companies?.length) {
    return [];
  }

  const companyIds = companies.map(
    company => company.id
  );

  const {
    data: verificationRows,
    error: verificationError
  } = await supabase
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
        'reviewed_by',
        'reviewed_at',
        'created_at',
        'updated_at'
      ].join(',')
    )
    .in('company_id', companyIds);

  if (verificationError) {
    throw verificationError;
  }

  const verificationMap = new Map(
    (verificationRows || []).map(row => [
      String(row.company_id),
      row
    ])
  );

  const rows = companies.map(company => {
    const verification =
      verificationMap.get(
        String(company.id)
      ) || {};

    return {
      ...verification,

      company_id: company.id,

      company_name:
        verification.company_name ||
        company.company_name ||
        '',

      verification_status:
        verification.verification_status ||
        company.verification_status ||
        'pending_review',

      account_number:
        company.account_number || '',

      account_status:
        company.account_status,

      deactivation_reason:
        company.deactivation_reason || '',

      deactivated_at:
        company.deactivated_at || null,

      reactivated_at:
        company.reactivated_at || null
    };
  });

  return addReviewDetails(
    supabase,
    rows
  );
}

async function logAdminAction(
  supabase,
  {
    companyId,
    action,
    reason,
    adminId
  }
) {
  const { error } = await supabase
    .from('company_admin_actions')
    .insert({
      company_id: companyId,
      action,
      reason: reason || null,
      performed_by: adminId
    });

  if (error) {
    throw error;
  }
}

async function updateLatestDocument(
  supabase,
  companyId,
  {
    status,
    reason,
    adminId,
    reviewedAt
  }
) {
  const { data, error } = await supabase
    .from('employer_verification_documents')
    .select('id')
    .eq('company_id', companyId)
    .order('created_at', {
      ascending: false
    })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data?.id) {
    return;
  }

  const payload = {
    review_status: status,
    rejection_reason:
      status === 'rejected'
        ? reason || null
        : null,
    reviewed_by:
      status === 'pending_review'
        ? null
        : adminId,
    reviewed_at:
      status === 'pending_review'
        ? null
        : reviewedAt
  };

  const { error: updateError } = await supabase
    .from('employer_verification_documents')
    .update(payload)
    .eq('id', data.id);

  if (updateError) {
    throw updateError;
  }
}

async function companyEmployerIds(
  supabase,
  companyId
) {
  const ids = new Set();

  const {
    data: company,
    error: companyError
  } = await supabase
    .from('companies')
    .select('owner_user_id')
    .eq('id', companyId)
    .maybeSingle();

  if (companyError) {
    throw companyError;
  }

  if (company?.owner_user_id) {
    ids.add(String(company.owner_user_id));
  }

  const {
    data: members,
    error: memberError
  } = await supabase
    .from('company_members')
    .select('user_id')
    .eq('company_id', companyId);

  if (memberError) {
    throw memberError;
  }

  for (const member of members || []) {
    if (member?.user_id) {
      ids.add(String(member.user_id));
    }
  }

  return [...ids];
}

async function pauseCompanyJobs(
  supabase,
  companyId
) {
  const employerIds =
    await companyEmployerIds(
      supabase,
      companyId
    );

  if (!employerIds.length) {
    return 0;
  }

  const {
    data,
    error
  } = await supabase
    .from('jobs')
    .update({
      status: 'paused',
      updated_at: new Date().toISOString()
    })
    .in('employer_id', employerIds)
    .eq('status', 'active')
    .select('id');

  if (error) {
    /*
     * Don't allow an old jobs schema to break
     * employer administration entirely.
     */
    console.error(
      'Unable to pause company jobs:',
      error
    );

    return 0;
  }

  return data?.length || 0;
}

async function handleVerificationDecision(
  supabase,
  admin,
  {
    companyId,
    decision,
    reason
  }
) {
  const now = new Date().toISOString();

  if (
    ![
      'approved',
      'rejected',
      'pending_review'
    ].includes(decision)
  ) {
    const error = new Error(
      'Invalid verification decision.'
    );
    error.status = 400;
    throw error;
  }

  if (
    decision === 'rejected' &&
    !reason
  ) {
    const error = new Error(
      'Enter a reason before declining the employer.'
    );
    error.status = 400;
    throw error;
  }

  const verificationPayload = {
    verification_status: decision,

    rejection_reason:
      decision === 'rejected'
        ? reason
        : null,

    reviewed_by:
      decision === 'pending_review'
        ? null
        : admin.id,

    reviewed_at:
      decision === 'pending_review'
        ? null
        : now,

    updated_at: now
  };

  const {
    data: updatedVerification,
    error: verificationError
  } = await supabase
    .from('employer_verifications')
    .update(verificationPayload)
    .eq('company_id', companyId)
    .select('company_id')
    .maybeSingle();

  if (verificationError) {
    throw verificationError;
  }

  if (!updatedVerification) {
    const error = new Error(
      'Employer verification record was not found.'
    );
    error.status = 404;
    throw error;
  }

  const {
    error: companyError
  } = await supabase
    .from('companies')
    .update({
      verification_status: decision
    })
    .eq('id', companyId);

  if (companyError) {
    throw companyError;
  }

  await updateLatestDocument(
    supabase,
    companyId,
    {
      status: decision,
      reason,
      adminId: admin.id,
      reviewedAt: now
    }
  );

  let auditAction = decision;

  if (decision === 'pending_review') {
    auditAction = 'moved_to_pending';
  }

  await logAdminAction(
    supabase,
    {
      companyId,
      action: auditAction,
      reason,
      adminId: admin.id
    }
  );

  let pausedJobs = 0;

  /*
   * If Alygnn removes verification,
   * active jobs should stop being public.
   */
  if (
    decision === 'pending_review' ||
    decision === 'rejected'
  ) {
    pausedJobs =
      await pauseCompanyJobs(
        supabase,
        companyId
      );
  }

  return {
    verification_status: decision,
    paused_jobs: pausedJobs
  };
}

async function deactivateCompany(
  supabase,
  admin,
  companyId,
  reason
) {
  if (!reason) {
    const error = new Error(
      'Enter a reason before deactivating the company.'
    );
    error.status = 400;
    throw error;
  }

  const now = new Date().toISOString();

  const {
    data,
    error
  } = await supabase
    .from('companies')
    .update({
      account_status: 'deactivated',
      deactivation_reason: reason,
      deactivated_at: now,
      deactivated_by: admin.id
    })
    .eq('id', companyId)
    .select(
      'id,company_name,verification_status,account_status'
    )
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    const notFound = new Error(
      'Company was not found.'
    );
    notFound.status = 404;
    throw notFound;
  }

  const pausedJobs =
    await pauseCompanyJobs(
      supabase,
      companyId
    );

  await logAdminAction(
    supabase,
    {
      companyId,
      action: 'deactivated',
      reason,
      adminId: admin.id
    }
  );

  return {
    company: data,
    paused_jobs: pausedJobs
  };
}

async function reactivateCompany(
  supabase,
  admin,
  companyId,
  reason
) {
  const now = new Date().toISOString();

  const {
    data,
    error
  } = await supabase
    .from('companies')
    .update({
      account_status: 'active',

      deactivation_reason: null,
      deactivated_at: null,
      deactivated_by: null,

      reactivated_at: now,
      reactivated_by: admin.id
    })
    .eq('id', companyId)
    .select(
      'id,company_name,verification_status,account_status'
    )
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    const notFound = new Error(
      'Company was not found.'
    );
    notFound.status = 404;
    throw notFound;
  }

  await logAdminAction(
    supabase,
    {
      companyId,
      action: 'reactivated',
      reason:
        reason ||
        'Company reactivated by Alygnn admin.',
      adminId: admin.id
    }
  );

  /*
   * IMPORTANT:
   * Jobs stay paused.
   * We intentionally DO NOT automatically
   * republish them.
   */

  return {
    company: data
  };
}

module.exports = async function handler(
  req,
  res
) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    const supabase =
      serviceClient();

    const admin =
      await requireAdmin(
        req,
        supabase
      );

    /*
     * =====================================================
     * GET ADMIN REVIEW QUEUE
     * =====================================================
     */

    if (req.method === 'GET') {
      const requestedStatus =
        String(
          req.query.status ||
          'pending_review'
        )
          .trim()
          .toLowerCase();

      if (
        requestedStatus ===
        'deactivated'
      ) {
        const reviews =
          await getDeactivatedRows(
            supabase
          );

        return sendJson(
          res,
          200,
          {
            success: true,
            status: 'deactivated',
            reviews
          }
        );
      }

      const allowedStatuses =
        new Set([
          'pending_review',
          'approved',
          'rejected'
        ]);

      const status =
        allowedStatuses.has(
          requestedStatus
        )
          ? requestedStatus
          : 'pending_review';

      const reviews =
        await getVerificationRows(
          supabase,
          status
        );

      return sendJson(
        res,
        200,
        {
          success: true,
          status,
          reviews
        }
      );
    }

    /*
     * =====================================================
     * ADMIN ACTION
     * =====================================================
     */

    if (req.method === 'PATCH') {
      const body =
        typeof req.body === 'string'
          ? JSON.parse(
              req.body || '{}'
            )
          : req.body || {};

      const companyId =
        String(
          body.company_id || ''
        ).trim();

      /*
       * Supports old admin page:
       *
       * decision: "approved"
       *
       * and new admin page:
       *
       * action: "deactivate"
       */
      const action =
        String(
          body.action ||
          body.decision ||
          ''
        )
          .trim()
          .toLowerCase();

      const reason =
        String(
          body.reason || ''
        ).trim();

      if (!companyId) {
        return sendJson(
          res,
          400,
          {
            success: false,
            error:
              'A company ID is required.'
          }
        );
      }

      /*
       * APPROVE / REJECT / MOVE TO PENDING
       */
      if (
        [
          'approved',
          'rejected',
          'pending_review'
        ].includes(action)
      ) {
        const result =
          await handleVerificationDecision(
            supabase,
            admin,
            {
              companyId,
              decision: action,
              reason
            }
          );

        return sendJson(
          res,
          200,
          {
            success: true,
            company_id:
              companyId,
            ...result
          }
        );
      }

      /*
       * DEACTIVATE COMPANY
       */
      if (
        action === 'deactivate' ||
        action === 'deactivated'
      ) {
        const result =
          await deactivateCompany(
            supabase,
            admin,
            companyId,
            reason
          );

        return sendJson(
          res,
          200,
          {
            success: true,
            company_id:
              companyId,
            account_status:
              'deactivated',
            ...result
          }
        );
      }

      /*
       * REACTIVATE COMPANY
       */
      if (
        action === 'reactivate' ||
        action === 'reactivated'
      ) {
        const result =
          await reactivateCompany(
            supabase,
            admin,
            companyId,
            reason
          );

        return sendJson(
          res,
          200,
          {
            success: true,
            company_id:
              companyId,
            account_status:
              'active',
            ...result
          }
        );
      }

      return sendJson(
        res,
        400,
        {
          success: false,
          error:
            'Action must be approved, rejected, pending_review, deactivate, or reactivate.'
        }
      );
    }

    res.setHeader(
      'Allow',
      'GET, PATCH, OPTIONS'
    );

    return sendJson(
      res,
      405,
      {
        success: false,
        error:
          'Method not allowed.'
      }
    );
  } catch (error) {
    console.error(
      'Employer verification admin error:',
      error
    );

    return sendJson(
      res,
      error.status || 500,
      {
        success: false,
        error:
          error.message ||
          'Unable to process the employer review.'
      }
    );
  }
};
