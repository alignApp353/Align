'use strict';

const {
  createClient
} = require('@supabase/supabase-js');


function applyCors(req, res) {

  const allowedOrigins =
    new Set([
      'https://alygnn.com',
      'https://www.alygnn.com',
      'http://localhost',
      'https://localhost',
      'capacitor://localhost'
    ]);


  const origin =
    String(
      req.headers.origin || ''
    )
    .trim();


  if (
    allowedOrigins.has(origin) ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i
      .test(origin)
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
    'GET, OPTIONS'
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



function getAccessToken(req) {

  const value =
    String(
      req.headers.authorization || ''
    );


  return value
    .toLowerCase()
    .startsWith('bearer ')
      ? value.slice(7).trim()
      : null;

}



function normalizeStatus(value) {

  const status =
    String(
      value || ''
    )
    .trim()
    .toLowerCase();


  if (
    [
      'approved',
      'pending_review',
      'rejected'
    ].includes(status)
  ) {

    return status;

  }


  return '';

}



async function getCompanyByOwner(
  supabase,
  userId
) {

  /*
   * First attempt includes account_status.
   */

  const first =
    await supabase
      .from('companies')
      .select(
        [
          'id',
          'account_number',
          'company_name',
          'legal_name',
          'verification_status',
          'account_status',
          'owner_user_id',
          'website',
          'business_phone',
          'industry',
          'company_size',
          'headquarters'
        ].join(',')
      )
      .eq(
        'owner_user_id',
        userId
      )
      .order(
        'created_at',
        {
          ascending:false
        }
      )
      .limit(1)
      .maybeSingle();


  if (!first.error) {

    return first.data || null;

  }


  /*
   * Fallback in case older database versions
   * do not contain legal_name/account_status.
   */

  const fallback =
    await supabase
      .from('companies')
      .select(
        [
          'id',
          'account_number',
          'company_name',
          'verification_status',
          'owner_user_id',
          'website',
          'business_phone',
          'industry',
          'company_size',
          'headquarters'
        ].join(',')
      )
      .eq(
        'owner_user_id',
        userId
      )
      .order(
        'created_at',
        {
          ascending:false
        }
      )
      .limit(1)
      .maybeSingle();


  if (fallback.error) {

    throw fallback.error;

  }


  return fallback.data || null;

}



async function getCompanyByMembership(
  supabase,
  userId
) {

  const {
    data:membership,
    error:membershipError
  } =
    await supabase
      .from('company_members')
      .select(
        'company_id,role,membership_status'
      )
      .eq(
        'user_id',
        userId
      )
      .in(
        'membership_status',
        [
          'active',
          'pending',
          'suspended'
        ]
      )
      .order(
        'created_at',
        {
          ascending:false
        }
      )
      .limit(1)
      .maybeSingle();


  if (membershipError) {

    throw membershipError;

  }


  if (
    !membership?.company_id
  ) {

    return null;

  }


  const first =
    await supabase
      .from('companies')
      .select(
        [
          'id',
          'account_number',
          'company_name',
          'legal_name',
          'verification_status',
          'account_status',
          'owner_user_id',
          'website',
          'business_phone',
          'industry',
          'company_size',
          'headquarters'
        ].join(',')
      )
      .eq(
        'id',
        membership.company_id
      )
      .maybeSingle();


  if (!first.error) {

    return first.data || null;

  }


  const fallback =
    await supabase
      .from('companies')
      .select(
        [
          'id',
          'account_number',
          'company_name',
          'verification_status',
          'owner_user_id',
          'website',
          'business_phone',
          'industry',
          'company_size',
          'headquarters'
        ].join(',')
      )
      .eq(
        'id',
        membership.company_id
      )
      .maybeSingle();


  if (fallback.error) {

    throw fallback.error;

  }


  return fallback.data || null;

}



/*
 * The uploaded verification document is what the
 * Alygnn admin actually reviews.
 *
 * We check the newest document so an approval,
 * rejection, or return-to-pending action is reflected
 * immediately throughout the employer app.
 */

async function getLatestDocumentStatus(
  supabase,
  companyId
) {

  if (!companyId) {

    return null;

  }


  const {
    data,
    error
  } =
    await supabase
      .from(
        'employer_verification_documents'
      )
      .select(
        [
          'id',
          'company_id',
          'review_status',
          'reviewed_at',
          'created_at'
        ].join(',')
      )
      .eq(
        'company_id',
        companyId
      )
      .order(
        'created_at',
        {
          ascending:false
        }
      )
      .limit(1)
      .maybeSingle();


  if (error) {

    console.error(
      'Could not read verification document:',
      error
    );


    return null;

  }


  return data || null;

}



async function getLegacyVerification(
  supabase,
  userId,
  companyId
) {

  let query =
    supabase
      .from(
        'employer_verifications'
      )
      .select(
        [
          'user_id',
          'company_id',
          'company_name',
          'verification_status',
          'rejection_reason'
        ].join(',')
      );


  if (companyId) {

    query =
      query.eq(
        'company_id',
        companyId
      );

  } else {

    query =
      query.eq(
        'user_id',
        userId
      );

  }


  const {
    data,
    error
  } =
    await query
      .limit(1)
      .maybeSingle();


  if (error) {

    console.warn(
      'Legacy verification lookup failed:',
      error
    );


    return null;

  }


  return data || null;

}



function effectiveVerificationStatus({
  company,
  document,
  legacy
}) {

  const companyStatus =
    normalizeStatus(
      company?.verification_status
    );


  const documentStatus =
    normalizeStatus(
      document?.review_status
    );


  const legacyStatus =
    normalizeStatus(
      legacy?.verification_status
    );


  /*
   * IMPORTANT:
   *
   * The newest verification document is the item
   * actually reviewed in the Trust & Safety queue.
   *
   * Therefore it wins whenever it has a valid status.
   */

  if (documentStatus) {

    return documentStatus;

  }


  if (companyStatus) {

    return companyStatus;

  }


  if (legacyStatus) {

    return legacyStatus;

  }


  return 'pending_review';

}



function companyResponse(
  company,
  verificationStatus
) {

  return {

    id:
      company.id,

    accountNumber:
      company.account_number
      ||
      null,

    name:
      company.company_name
      ||
      company.legal_name
      ||
      null,

    verificationStatus,

    accountStatus:
      String(
        company.account_status
        ||
        'active'
      )
      .toLowerCase(),

    website:
      company.website
      ||
      '',

    businessPhone:
      company.business_phone
      ||
      '',

    industry:
      company.industry
      ||
      '',

    companySize:
      company.company_size
      ||
      '',

    headquarters:
      company.headquarters
      ||
      ''

  };

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


  /*
   * Never cache employer verification state.
   */
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate'
  );


  if (
    req.method ===
    'OPTIONS'
  ) {

    return res
      .status(204)
      .end();

  }


  if (
    req.method !==
    'GET'
  ) {

    res.setHeader(
      'Allow',
      'GET, OPTIONS'
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

  }


  if (
    !process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {

    return sendJson(
      res,
      500,
      {
        success:false,
        error:
          'Server configuration is incomplete.'
      }
    );

  }


  const token =
    getAccessToken(req);


  if (!token) {

    return sendJson(
      res,
      401,
      {
        success:false,
        error:
          'You must be signed in.'
      }
    );

  }


  const supabase =
    createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth:{
          persistSession:false,
          autoRefreshToken:false
        }
      }
    );


  const {
    data:{
      user
    },
    error:userError
  } =
    await supabase.auth
      .getUser(
        token
      );


  if (
    userError ||
    !user
  ) {

    return sendJson(
      res,
      401,
      {
        success:false,
        error:
          'Your login session is invalid or has expired.'
      }
    );

  }


  try {

    /*
     * 1. Find the employer's actual company.
     */

    let company =
      await getCompanyByOwner(
        supabase,
        user.id
      );


    if (!company) {

      company =
        await getCompanyByMembership(
          supabase,
          user.id
        );

    }


    /*
     * Older account fallback.
     */

    if (!company) {

      const legacy =
        await getLegacyVerification(
          supabase,
          user.id,
          ''
        );


      if (
        legacy?.company_id
      ) {

        const {
          data:legacyCompany,
          error
        } =
          await supabase
            .from('companies')
            .select('*')
            .eq(
              'id',
              legacy.company_id
            )
            .maybeSingle();


        if (!error) {

          company =
            legacyCompany;

        }

      }

    }


    if (!company) {

      return sendJson(
        res,
        404,
        {
          success:false,
          error:
            'No company workspace is connected to this employer account.'
        }
      );

    }


    /*
     * 2. Read every verification source.
     */

    const [
      document,
      legacy
    ] =
      await Promise.all([

        getLatestDocumentStatus(
          supabase,
          company.id
        ),

        getLegacyVerification(
          supabase,
          user.id,
          company.id
        )

      ]);


    /*
     * 3. Determine one authoritative status.
     */

    const verificationStatus =
      effectiveVerificationStatus({
        company,
        document,
        legacy
      });


    console.log(
      'resolve-company:',
      {
        companyId:
          company.id,

        companyStatus:
          company.verification_status,

        documentStatus:
          document?.review_status,

        legacyStatus:
          legacy?.verification_status,

        effectiveStatus:
          verificationStatus,

        accountStatus:
          company.account_status
          ||
          'active'
      }
    );


    /*
     * 4. Keep the companies table synchronized too.
     */

    if (
      normalizeStatus(
        company.verification_status
      )
      !==
      verificationStatus
    ) {

      const {
        error:syncError
      } =
        await supabase
          .from('companies')
          .update({
            verification_status:
              verificationStatus
          })
          .eq(
            'id',
            company.id
          );


      if (syncError) {

        console.error(
          'Could not synchronize company verification status:',
          syncError
        );

      }

    }


    return sendJson(
      res,
      200,
      {
        success:true,

        company:
          companyResponse(
            company,
            verificationStatus
          ),

        verification:{
          status:
            verificationStatus,

          companyStatus:
            normalizeStatus(
              company.verification_status
            )
            ||
            null,

          documentStatus:
            normalizeStatus(
              document?.review_status
            )
            ||
            null,

          legacyStatus:
            normalizeStatus(
              legacy?.verification_status
            )
            ||
            null
        }

      }
    );


  } catch(error) {

    console.error(
      'resolve-company failed:',
      error
    );


    return sendJson(
      res,
      500,
      {
        success:false,

        error:
          error?.message
          ||
          'Unable to resolve your company workspace.'
      }
    );

  }

};
