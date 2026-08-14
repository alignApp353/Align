'use strict';

const { createClient } = require('@supabase/supabase-js');


/* =========================================================
   CORS
========================================================= */

function applyCors(req, res) {
  const allowedOrigins = new Set([
    'https://alygnn.com',
    'https://www.alygnn.com',
    'http://localhost:3000',
    'http://localhost:5173',
    'capacitor://localhost',
    'https://localhost'
  ]);

  const origin = String(req.headers.origin || '').trim();

  if (
    allowedOrigins.has(origin) ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.setHeader('Vary', 'Origin');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, PATCH, OPTIONS'
  );
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
  const header = String(
    req.headers.authorization || ''
  );

  return header
    .toLowerCase()
    .startsWith('bearer ')
      ? header.slice(7).trim()
      : '';
}


/* =========================================================
   ADMIN SECURITY
========================================================= */

function adminEmails() {
  return new Set(
    String(
      process.env.ALYGNN_ADMIN_EMAILS || ''
    )
      .split(',')
      .map(value =>
        value.trim().toLowerCase()
      )
      .filter(Boolean)
  );
}


function serviceClient() {
  if (
    !process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    throw new Error(
      'Server configuration is incomplete.'
    );
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


  const {
    data,
    error
  } = await supabase.auth.getUser(token);


  const user = data?.user;


  if (error || !user) {
    const authError = new Error(
      'Your login session is invalid or expired.'
    );

    authError.status = 401;
    throw authError;
  }


  const allowed = adminEmails();

  const email = String(
    user.email || ''
  ).toLowerCase();


  if (
    !allowed.size ||
    !allowed.has(email)
  ) {
    const permissionError = new Error(
      'This account is not authorized to review employers.'
    );

    permissionError.status = 403;
    throw permissionError;
  }


  return user;
}


/* =========================================================
   SIGNED PDF URL
========================================================= */

async function signedDocumentUrl(
  supabase,
  document
) {
  if (!document?.storage_path) {
    return '';
  }


  const {
    data,
    error
  } = await supabase.storage
    .from(
      'employer-verification-documents'
    )
    .createSignedUrl(
      document.storage_path,
      300
    );


  if (error) {
    console.error(
      'Unable to create signed verification URL:',
      error
    );

    return '';
  }


  return data?.signedUrl || '';
}


/* =========================================================
   COMPANY / VERIFICATION DATA
========================================================= */

async function loadCompanies(
  supabase,
  companyIds
) {
  if (!companyIds.length) {
    return new Map();
  }


  const {
    data,
    error
  } = await supabase
    .from('companies')
    .select(
      [
        'id',
        'company_name',
        'account_number',
        'owner_user_id',
        'website',
        'business_phone',
        'industry',
        'company_size',
        'headquarters',
        'verification_status',
        'account_status',
        'deactivation_reason',
        'deactivated_at',
        'deactivated_by',
        'reactivated_at',
        'reactivated_by',
        'created_at'
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


async function loadVerificationExtras(
  supabase,
  companyIds,
  userIds = []
) {
  const byCompany = new Map();
  const byUser = new Map();


  if (companyIds.length) {
    const {
      data,
      error
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


    /*
     * IMPORTANT:
     * employer_verifications is optional
     * for the admin queue.
     */
    if (!error) {
      for (const row of data || []) {
        if (row.company_id) {
          byCompany.set(
            String(row.company_id),
            row
          );
        }

        if (row.user_id) {
          byUser.set(
            String(row.user_id),
            row
          );
        }
      }
    } else {
      console.error(
        'Could not load verification extras:',
        error
      );
    }
  }


  const missingUsers = userIds.filter(
    userId =>
      userId &&
      !byUser.has(String(userId))
  );


  if (missingUsers.length) {
    const {
      data,
      error
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
      .in('user_id', missingUsers);


    if (!error) {
      for (const row of data || []) {
        if (row.company_id) {
          byCompany.set(
            String(row.company_id),
            row
          );
        }

        if (row.user_id) {
          byUser.set(
            String(row.user_id),
            row
          );
        }
      }
    }
  }


  return {
    byCompany,
    byUser
  };
}


/* =========================================================
   NORMAL VERIFICATION QUEUE

   Source of truth:
   employer_verification_documents
========================================================= */

async function loadDocumentReviews(
  supabase,
  status
) {
  const {
    data: documents,
    error
  } = await supabase
    .from(
      'employer_verification_documents'
    )
    .select(
      [
        'id',
        'company_id',
        'uploaded_by',
        'document_type',
        'storage_path',
        'original_file_name',
        'mime_type',
        'file_size_bytes',
        'review_status',
        'rejection_reason',
        'reviewed_by',
        'reviewed_at',
        'created_at'
      ].join(',')
    )
    .eq('review_status', status)
    .order(
      'created_at',
      {
        ascending: false
      }
    );


  if (error) {
    throw error;
  }


  if (!documents?.length) {
    return [];
  }


  /*
   * Keep newest document per company.
   */
  const latestByCompany = new Map();


  for (const document of documents) {
    const key = String(
      document.company_id || ''
    );

    if (
      key &&
      !latestByCompany.has(key)
    ) {
      latestByCompany.set(
        key,
        document
      );
    }
  }


  const latestDocuments =
    [...latestByCompany.values()];


  const companyIds = [
    ...new Set(
      latestDocuments
        .map(document =>
          String(
            document.company_id || ''
          )
        )
        .filter(Boolean)
    )
  ];


  const userIds = [
    ...new Set(
      latestDocuments
        .map(document =>
          String(
            document.uploaded_by || ''
          )
        )
        .filter(Boolean)
    )
  ];


  const companies =
    await loadCompanies(
      supabase,
      companyIds
    );


  const extras =
    await loadVerificationExtras(
      supabase,
      companyIds,
      userIds
    );


  const reviews = [];


  for (const document of latestDocuments) {
    const companyId =
      String(document.company_id);


    const company =
      companies.get(companyId) || {};


    /*
     * Deactivated companies have
     * their own admin tab.
     */
    if (
      String(
        company.account_status || 'active'
      ).toLowerCase() === 'deactivated'
    ) {
      continue;
    }


    const verification =
      extras.byCompany.get(companyId)

      ||

      extras.byUser.get(
        String(
          document.uploaded_by || ''
        )
      )

      ||

      {};


    reviews.push({
      user_id:
        document.uploaded_by,

      company_id:
        document.company_id,

      company_name:
        company.company_name
        ||
        verification.company_name
        ||
        'Unnamed company',

      account_number:
        company.account_number
        ||
        '',

      website:
        company.website
        ||
        verification.website
        ||
        '',

      business_phone:
        company.business_phone
        ||
        verification.business_phone
        ||
        '',

      industry:
        company.industry
        ||
        verification.industry
        ||
        '',

      company_size:
        company.company_size
        ||
        verification.company_size
        ||
        '',

      headquarters:
        company.headquarters
        ||
        verification.headquarters
        ||
        '',

      ein_last4:
        verification.ein_last4
        ||
        '',

      verification_status:
        document.review_status,

      account_status:
        company.account_status
        ||
        'active',

      rejection_reason:
        document.rejection_reason
        ||
        verification.rejection_reason
        ||
        null,

      deactivation_reason:
        company.deactivation_reason
        ||
        null,

      deactivated_at:
        company.deactivated_at
        ||
        null,

      created_at:
        document.created_at,

      updated_at:
        verification.updated_at
        ||
        document.reviewed_at
        ||
        document.created_at,

      document,

      document_url:
        await signedDocumentUrl(
          supabase,
          document
        )
    });
  }


  return reviews;
}


/* =========================================================
   DEACTIVATED COMPANIES
========================================================= */

async function loadDeactivatedReviews(
  supabase
) {
  const {
    data: companies,
    error
  } = await supabase
    .from('companies')
    .select(
      [
        'id',
        'company_name',
        'account_number',
        'owner_user_id',
        'website',
        'business_phone',
        'industry',
        'company_size',
        'headquarters',
        'verification_status',
        'account_status',
        'deactivation_reason',
        'deactivated_at',
        'deactivated_by',
        'reactivated_at',
        'created_at'
      ].join(',')
    )
    .eq(
      'account_status',
      'deactivated'
    )
    .order(
      'deactivated_at',
      {
        ascending: false
      }
    );


  if (error) {
    throw error;
  }


  if (!companies?.length) {
    return [];
  }


  const companyIds =
    companies.map(company =>
      String(company.id)
    );


  const extras =
    await loadVerificationExtras(
      supabase,
      companyIds
    );


  const {
    data: documents,
    error: documentError
  } = await supabase
    .from(
      'employer_verification_documents'
    )
    .select(
      [
        'id',
        'company_id',
        'uploaded_by',
        'document_type',
        'storage_path',
        'original_file_name',
        'review_status',
        'rejection_reason',
        'reviewed_by',
        'reviewed_at',
        'created_at'
      ].join(',')
    )
    .in(
      'company_id',
      companyIds
    )
    .order(
      'created_at',
      {
        ascending: false
      }
    );


  if (documentError) {
    throw documentError;
  }


  const latestDocument =
    new Map();


  for (const document of documents || []) {
    const key =
      String(document.company_id);

    if (
      !latestDocument.has(key)
    ) {
      latestDocument.set(
        key,
        document
      );
    }
  }


  const reviews = [];


  for (const company of companies) {
    const companyId =
      String(company.id);


    const verification =
      extras.byCompany.get(
        companyId
      ) || {};


    const document =
      latestDocument.get(
        companyId
      ) || null;


    reviews.push({
      user_id:
        verification.user_id
        ||
        company.owner_user_id
        ||
        null,

      company_id:
        company.id,

      company_name:
        company.company_name
        ||
        verification.company_name
        ||
        'Unnamed company',

      account_number:
        company.account_number
        ||
        '',

      website:
        company.website
        ||
        verification.website
        ||
        '',

      business_phone:
        company.business_phone
        ||
        verification.business_phone
        ||
        '',

      industry:
        company.industry
        ||
        verification.industry
        ||
        '',

      company_size:
        company.company_size
        ||
        verification.company_size
        ||
        '',

      headquarters:
        company.headquarters
        ||
        verification.headquarters
        ||
        '',

      ein_last4:
        verification.ein_last4
        ||
        '',

      verification_status:
        company.verification_status
        ||
        verification.verification_status
        ||
        document?.review_status
        ||
        'pending_review',

      account_status:
        'deactivated',

      rejection_reason:
        verification.rejection_reason
        ||
        document?.rejection_reason
        ||
        null,

      deactivation_reason:
        company.deactivation_reason
        ||
        null,

      deactivated_at:
        company.deactivated_at
        ||
        null,

      created_at:
        verification.created_at
        ||
        document?.created_at
        ||
        company.created_at,

      document,

      document_url:
        await signedDocumentUrl(
          supabase,
          document
        )
    });
  }


  return reviews;
}


/* =========================================================
   ADMIN AUDIT LOG
========================================================= */

async function logAdminAction(
  supabase,
  companyId,
  action,
  reason,
  adminId
) {
  const {
    error
  } = await supabase
    .from(
      'company_admin_actions'
    )
    .insert({
      company_id:
        companyId,

      action,

      reason:
        reason || null,

      performed_by:
        adminId
    });


  if (error) {
    throw error;
  }
}


/* =========================================================
   LATEST PDF UPDATE
========================================================= */

async function updateLatestDocument(
  supabase,
  companyId,
  status,
  reason,
  adminId,
  now
) {
  const {
    data,
    error
  } = await supabase
    .from(
      'employer_verification_documents'
    )
    .select('id')
    .eq(
      'company_id',
      companyId
    )
    .order(
      'created_at',
      {
        ascending: false
      }
    )
    .limit(1)
    .maybeSingle();


  if (error) {
    throw error;
  }


  if (!data?.id) {
    return;
  }


  const {
    error: updateError
  } = await supabase
    .from(
      'employer_verification_documents'
    )
    .update({
      review_status:
        status,

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
          : now
    })
    .eq(
      'id',
      data.id
    );


  if (updateError) {
    throw updateError;
  }
}


/* =========================================================
   OPTIONAL employer_verifications SYNC

   This table is NOT required for the queue.
========================================================= */

async function syncEmployerVerification(
  supabase,
  companyId,
  status,
  reason,
  adminId,
  now
) {
  const {
    error
  } = await supabase
    .from(
      'employer_verifications'
    )
    .update({
      verification_status:
        status,

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
          : now,

      updated_at:
        now
    })
    .eq(
      'company_id',
      companyId
    );


  /*
   * Do NOT break the admin action if
   * there is no verification profile row.
   */
  if (error) {
    console.error(
      'Unable to sync employer_verifications:',
      error
    );
  }
}


/* =========================================================
   PAUSE COMPANY JOBS
========================================================= */

async function pauseCompanyJobs(
  supabase,
  companyId
) {
  const employerIds =
    new Set();


  const {
    data: company,
    error: companyError
  } = await supabase
    .from('companies')
    .select('owner_user_id')
    .eq('id', companyId)
    .maybeSingle();


  if (companyError) {
    console.error(
      'Unable to read company owner:',
      companyError
    );
  }


  if (company?.owner_user_id) {
    employerIds.add(
      String(
        company.owner_user_id
      )
    );
  }


  const {
    data: members,
    error: memberError
  } = await supabase
    .from('company_members')
    .select('user_id')
    .eq(
      'company_id',
      companyId
    );


  if (memberError) {
    console.error(
      'Unable to read company members:',
      memberError
    );
  }


  for (const member of members || []) {
    if (member.user_id) {
      employerIds.add(
        String(member.user_id)
      );
    }
  }


  const ids =
    [...employerIds];


  if (!ids.length) {
    return 0;
  }


  const {
    data,
    error
  } = await supabase
    .from('jobs')
    .update({
      status: 'paused',
      updated_at:
        new Date()
          .toISOString()
    })
    .in(
      'employer_id',
      ids
    )
    .eq(
      'status',
      'active'
    )
    .select('id');


  /*
   * Job schema differences should not stop
   * Alygnn from deactivating a company.
   */
  if (error) {
    console.error(
      'Unable to pause jobs:',
      error
    );

    return 0;
  }


  return data?.length || 0;
}


/* =========================================================
   APPROVE / REJECT / MOVE TO PENDING
========================================================= */

async function changeVerificationStatus(
  supabase,
  admin,
  companyId,
  status,
  reason
) {
  const now =
    new Date()
      .toISOString();


  if (
    status === 'rejected' &&
    !reason
  ) {
    const error =
      new Error(
        'Enter a reason before declining the employer.'
      );

    error.status = 400;
    throw error;
  }


  const {
    data: company,
    error: companyError
  } = await supabase
    .from('companies')
    .update({
      verification_status:
        status
    })
    .eq(
      'id',
      companyId
    )
    .select(
      'id,company_name,verification_status,account_status'
    )
    .maybeSingle();


  if (companyError) {
    throw companyError;
  }


  if (!company) {
    const error =
      new Error(
        'Company was not found.'
      );

    error.status = 404;
    throw error;
  }


  await updateLatestDocument(
    supabase,
    companyId,
    status,
    reason,
    admin.id,
    now
  );


  await syncEmployerVerification(
    supabase,
    companyId,
    status,
    reason,
    admin.id,
    now
  );


  await logAdminAction(
    supabase,
    companyId,

    status === 'pending_review'
      ? 'moved_to_pending'
      : status,

    reason,

    admin.id
  );


  let pausedJobs = 0;


  if (
    status === 'pending_review' ||
    status === 'rejected'
  ) {
    pausedJobs =
      await pauseCompanyJobs(
        supabase,
        companyId
      );
  }


  return {
    company,
    paused_jobs:
      pausedJobs
  };
}


/* =========================================================
   DEACTIVATE
========================================================= */

async function deactivateCompany(
  supabase,
  admin,
  companyId,
  reason
) {
  if (!reason) {
    const error =
      new Error(
        'Enter a reason before deactivating the company.'
      );

    error.status = 400;
    throw error;
  }


  const now =
    new Date()
      .toISOString();


  const {
    data,
    error
  } = await supabase
    .from('companies')
    .update({
      account_status:
        'deactivated',

      deactivation_reason:
        reason,

      deactivated_at:
        now,

      deactivated_by:
        admin.id
    })
    .eq(
      'id',
      companyId
    )
    .select(
      'id,company_name,verification_status,account_status'
    )
    .maybeSingle();


  if (error) {
    throw error;
  }


  if (!data) {
    const notFound =
      new Error(
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
    companyId,
    'deactivated',
    reason,
    admin.id
  );


  return {
    company:
      data,

    paused_jobs:
      pausedJobs
  };
}


/* =========================================================
   REACTIVATE
========================================================= */

async function reactivateCompany(
  supabase,
  admin,
  companyId,
  reason
) {
  const now =
    new Date()
      .toISOString();


  const {
    data,
    error
  } = await supabase
    .from('companies')
    .update({
      account_status:
        'active',

      deactivation_reason:
        null,

      deactivated_at:
        null,

      deactivated_by:
        null,

      reactivated_at:
        now,

      reactivated_by:
        admin.id
    })
    .eq(
      'id',
      companyId
    )
    .select(
      'id,company_name,verification_status,account_status'
    )
    .maybeSingle();


  if (error) {
    throw error;
  }


  if (!data) {
    const notFound =
      new Error(
        'Company was not found.'
      );

    notFound.status = 404;
    throw notFound;
  }


  await logAdminAction(
    supabase,
    companyId,
    'reactivated',

    reason ||
    'Company reactivated by Alygnn admin.',

    admin.id
  );


  /*
   * We DO NOT automatically republish jobs.
   */

  return {
    company:
      data
  };
}


/* =========================================================
   HANDLER
========================================================= */

module.exports =
async function handler(
  req,
  res
) {
  applyCors(
    req,
    res
  );


  res.setHeader(
    'Cache-Control',
    'no-store'
  );


  if (
    req.method === 'OPTIONS'
  ) {
    return res
      .status(204)
      .end();
  }


  try {
    const supabase =
      serviceClient();


    const admin =
      await requireAdmin(
        req,
        supabase
      );


    /* =========================
       GET
    ========================= */

    if (
      req.method === 'GET'
    ) {
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
          await loadDeactivatedReviews(
            supabase
          );


        return sendJson(
          res,
          200,
          {
            success: true,
            status:
              'deactivated',
            reviews
          }
        );
      }


      const allowed =
        new Set([
          'pending_review',
          'approved',
          'rejected'
        ]);


      const status =
        allowed.has(
          requestedStatus
        )
          ? requestedStatus
          : 'pending_review';


      const reviews =
        await loadDocumentReviews(
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


    /* =========================
       PATCH
    ========================= */

    if (
      req.method === 'PATCH'
    ) {
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
       * VERIFICATION STATUS
       */

      if (
        [
          'approved',
          'rejected',
          'pending_review'
        ].includes(action)
      ) {
        const result =
          await changeVerificationStatus(
            supabase,
            admin,
            companyId,
            action,
            reason
          );


        return sendJson(
          res,
          200,
          {
            success: true,
            company_id:
              companyId,

            verification_status:
              action,

            ...result
          }
        );
      }


      /*
       * DEACTIVATE
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
       * REACTIVATE
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
