'use strict';

const { createClient } = require('@supabase/supabase-js');


function applyCors(req, res) {

  const allowedOrigins = new Set([
    'https://alygnn.com',
    'https://www.alygnn.com',
    'http://localhost:3000',
    'http://localhost:5173',
    'capacitor://localhost',
    'https://localhost'
  ]);

  const origin =
    String(req.headers.origin || '')
      .trim();


  if (
    allowedOrigins.has(origin) ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)
  ) {

    res.setHeader(
      'Access-Control-Allow-Origin',
      origin
    );
  }


  res.setHeader(
    'Vary',
    'Origin'
  );

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, PATCH, OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type'
  );

  res.setHeader(
    'Access-Control-Max-Age',
    '86400'
  );
}


function sendJson(
  res,
  status,
  payload
) {

  res
    .status(status)
    .json(payload);
}


function bearerToken(req) {

  const header =
    String(
      req.headers.authorization || ''
    );


  return header
    .toLowerCase()
    .startsWith('bearer ')

      ? header.slice(7).trim()

      : '';
}


function adminEmails() {

  return new Set(

    String(
      process.env.ALYGNN_ADMIN_EMAILS || ''
    )

      .split(',')

      .map(
        value =>
          value
            .trim()
            .toLowerCase()
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

        persistSession:false,

        autoRefreshToken:false
      }
    }
  );
}


async function requireAdmin(
  req,
  supabase
) {

  const token =
    bearerToken(req);


  if (!token) {

    const error =
      new Error(
        'Sign in before opening the admin review page.'
      );

    error.status = 401;

    throw error;
  }


  const {
    data,
    error
  } =
    await supabase.auth.getUser(token);


  const user =
    data?.user;


  if (
    error ||
    !user
  ) {

    const authError =
      new Error(
        'Your login session is invalid or expired.'
      );

    authError.status = 401;

    throw authError;
  }


  const allowed =
    adminEmails();


  const email =
    String(
      user.email || ''
    ).toLowerCase();


  if (
    !allowed.size ||
    !allowed.has(email)
  ) {

    const permissionError =
      new Error(
        'This account is not authorized to review employers.'
      );

    permissionError.status = 403;

    throw permissionError;
  }


  return user;
}


async function createDocumentUrl(
  supabase,
  document
) {

  if (
    !document?.storage_path
  ) {

    return '';
  }


  const {
    data,
    error
  } =
    await supabase.storage

      .from(
        'employer-verification-documents'
      )

      .createSignedUrl(
        document.storage_path,
        300
      );


  if (error) {

    console.error(
      'Unable to create document URL:',
      error
    );

    return '';
  }


  return (
    data?.signedUrl || ''
  );
}


async function getVerificationExtras(
  supabase,
  companyIds,
  userIds
) {

  const byCompany =
    new Map();

  const byUser =
    new Map();


  if (companyIds.length) {

    const {
      data,
      error
    } =
      await supabase

        .from(
          'employer_verifications'
        )

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

        .in(
          'company_id',
          companyIds
        );


    if (!error) {

      for (
        const row
        of data || []
      ) {

        if (row.company_id) {

          byCompany.set(
            row.company_id,
            row
          );
        }


        if (row.user_id) {

          byUser.set(
            row.user_id,
            row
          );
        }
      }
    }
  }


  /*
   * Some older employer_verifications rows
   * were created without company_id.
   *
   * Look them up by user_id too.
   */

  const missingUserIds =
    userIds.filter(
      id => !byUser.has(id)
    );


  if (missingUserIds.length) {

    const {
      data,
      error
    } =
      await supabase

        .from(
          'employer_verifications'
        )

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

        .in(
          'user_id',
          missingUserIds
        );


    if (!error) {

      for (
        const row
        of data || []
      ) {

        if (row.user_id) {

          byUser.set(
            row.user_id,
            row
          );
        }


        if (row.company_id) {

          byCompany.set(
            row.company_id,
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


async function loadReviews(
  supabase,
  status
) {

  /*
   * IMPORTANT:
   *
   * The document table is now the source
   * of truth for the admin review queue.
   */

  const {
    data:documents,
    error:documentError
  } =
    await supabase

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

      .eq(
        'review_status',
        status
      )

      .order(
        'created_at',
        {
          ascending:false
        }
      );


  if (documentError) {

    throw documentError;
  }


  if (
    !documents ||
    !documents.length
  ) {

    return [];
  }


  /*
   * Only show the newest document
   * for each company.
   */

  const latestByCompany =
    new Map();


  for (
    const document
    of documents
  ) {

    if (
      !latestByCompany.has(
        document.company_id
      )
    ) {

      latestByCompany.set(
        document.company_id,
        document
      );
    }
  }


  const latestDocuments =
    Array.from(
      latestByCompany.values()
    );


  const companyIds =
    [
      ...new Set(
        latestDocuments
          .map(
            document =>
              document.company_id
          )
          .filter(Boolean)
      )
    ];


  const userIds =
    [
      ...new Set(
        latestDocuments
          .map(
            document =>
              document.uploaded_by
          )
          .filter(Boolean)
      )
    ];


  const {
    data:companies,
    error:companyError
  } =
    await supabase

      .from('companies')

      .select(
        [
          'id',
          'company_name',
          'owner_user_id',
          'website',
          'business_phone',
          'industry',
          'company_size',
          'headquarters',
          'verification_status',
          'created_at'
        ].join(',')
      )

      .in(
        'id',
        companyIds
      );


  if (companyError) {

    throw companyError;
  }


  const companyMap =
    new Map(
      (companies || [])
        .map(
          company => [
            company.id,
            company
          ]
        )
    );


  const extras =
    await getVerificationExtras(
      supabase,
      companyIds,
      userIds
    );


  const reviews =
    [];


  for (
    const document
    of latestDocuments
  ) {

    const company =
      companyMap.get(
        document.company_id
      ) || {};


    const verification =
      extras.byCompany.get(
        document.company_id
      )

      ||

      extras.byUser.get(
        document.uploaded_by
      )

      ||

      {};


    const documentUrl =
      await createDocumentUrl(
        supabase,
        document
      );


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

      rejection_reason:
        document.rejection_reason
        ||
        verification.rejection_reason
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
        documentUrl
    });
  }


  return reviews;
}


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


    /*
     * ==========================
     * GET ADMIN REVIEW QUEUE
     * ==========================
     */

    if (
      req.method === 'GET'
    ) {

      const allowedStatuses =
        new Set([
          'pending_review',
          'approved',
          'rejected'
        ]);


      const requestedStatus =
        String(
          req.query.status
          ||
          'pending_review'
        );


      const status =
        allowedStatuses.has(
          requestedStatus
        )

          ? requestedStatus

          : 'pending_review';


      const reviews =
        await loadReviews(
          supabase,
          status
        );


      return sendJson(
        res,
        200,
        {
          success:true,
          reviews
        }
      );
    }


    /*
     * ==========================
     * APPROVE / DECLINE
     * ==========================
     */

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


      const decision =
        String(
          body.decision || ''
        ).trim();


      const reason =
        String(
          body.reason || ''
        ).trim();


      if (!companyId) {

        return sendJson(
          res,
          400,
          {
            success:false,
            error:
              'A company ID is required.'
          }
        );
      }


      if (
        ![
          'approved',
          'rejected'
        ].includes(
          decision
        )
      ) {

        return sendJson(
          res,
          400,
          {
            success:false,
            error:
              'Decision must be approved or rejected.'
          }
        );
      }


      if (
        decision === 'rejected'
        &&
        !reason
      ) {

        return sendJson(
          res,
          400,
          {
            success:false,
            error:
              'Enter a reason before declining the employer.'
          }
        );
      }


      const now =
        new Date()
          .toISOString();


      /*
       * Update the REAL company status.
       */

      const {
        error:companyError
      } =
        await supabase

          .from('companies')

          .update({
            verification_status:
              decision
          })

          .eq(
            'id',
            companyId
          );


      if (companyError) {

        throw companyError;
      }


      /*
       * Update the verification PDF.
       */

      const {
        error:documentError
      } =
        await supabase

          .from(
            'employer_verification_documents'
          )

          .update({

            review_status:
              decision,

            rejection_reason:
              decision === 'rejected'
                ? reason
                : null,

            reviewed_by:
              admin.id,

            reviewed_at:
              now
          })

          .eq(
            'company_id',
            companyId
          )

          .eq(
            'review_status',
            'pending_review'
          );


      if (documentError) {

        throw documentError;
      }


      /*
       * Keep employer_verifications
       * synchronized if a row exists.
       *
       * This table is no longer required
       * for the admin queue to work.
       */

      const {
        error:verificationError
      } =
        await supabase

          .from(
            'employer_verifications'
          )

          .update({

            verification_status:
              decision,

            reviewed_by:
              admin.id,

            reviewed_at:
              now,

            rejection_reason:
              decision === 'rejected'
                ? reason
                : null,

            updated_at:
              now
          })

          .eq(
            'company_id',
            companyId
          );


      if (verificationError) {

        console.error(
          'Could not sync employer_verifications:',
          verificationError
        );
      }


      return sendJson(
        res,
        200,
        {
          success:true,

          company_id:
            companyId,

          verification_status:
            decision
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
        success:false,
        error:
          'Method not allowed.'
      }
    );


  }catch(error) {

    console.error(
      'Employer verification admin error:',
      error
    );


    return sendJson(
      res,
      error.status || 500,
      {
        success:false,
        error:
          error.message
          ||
          'Unable to process the employer review.'
      }
    );
  }
};
