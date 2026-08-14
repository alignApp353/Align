'use strict';

const { createClient } = require('@supabase/supabase-js');


function sendJson(res, status, payload) {
  return res.status(status).json(payload);
}


function getAccessToken(req) {
  const value =
    String(
      req.headers.authorization || ''
    );

  return value.startsWith('Bearer ')
    ? value.slice(7).trim()
    : null;
}


function shapeCompany(company) {
  if (!company) {
    return null;
  }

  return {
    id:
      company.id || null,

    accountNumber:
      company.account_number || null,

    name:
      company.company_name ||
      company.legal_name ||
      null,

    verificationStatus:
      company.verification_status ||
      'pending_review',

    accountStatus:
      company.account_status ||
      'active',

    deactivationReason:
      company.deactivation_reason ||
      null,

    deactivatedAt:
      company.deactivated_at ||
      null
  };
}


module.exports =
async function handler(
  req,
  res
) {

  /*
   * Capacitor runs app pages from
   * https://localhost
   */
  const allowedOrigins =
    new Set([
      'https://alygnn.com',
      'https://www.alygnn.com',
      'https://localhost',
      'http://localhost',
      'capacitor://localhost'
    ]);


  const origin =
    String(
      req.headers.origin || ''
    ).trim();


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
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type'
  );


  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, OPTIONS'
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


  if (
    req.method !== 'GET'
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
        error:'Method not allowed.'
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
      .getUser(token);


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
     * =====================================================
     * 1. OWNER LOOKUP
     * =====================================================
     */

    const {
      data:ownedCompany,
      error:ownerError
    } =
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
            'deactivation_reason',
            'deactivated_at',
            'owner_user_id'
          ].join(',')
        )
        .eq(
          'owner_user_id',
          user.id
        )
        .limit(1)
        .maybeSingle();


    if (!ownerError && ownedCompany) {

      return sendJson(
        res,
        200,
        {
          success:true,
          source:'owner',
          company:
            shapeCompany(
              ownedCompany
            )
        }
      );
    }


    /*
     * Some schemas may not have legal_name.
     * Retry without it if necessary.
     */

    if (ownerError) {

      const fallback =
        await supabase
          .from('companies')
          .select(
            [
              'id',
              'account_number',
              'company_name',
              'verification_status',
              'account_status',
              'deactivation_reason',
              'deactivated_at',
              'owner_user_id'
            ].join(',')
          )
          .eq(
            'owner_user_id',
            user.id
          )
          .limit(1)
          .maybeSingle();


      if (fallback.error) {
        throw fallback.error;
      }


      if (fallback.data) {

        return sendJson(
          res,
          200,
          {
            success:true,
            source:'owner',
            company:
              shapeCompany(
                fallback.data
              )
          }
        );
      }
    }


    /*
     * =====================================================
     * 2. COMPANY MEMBER LOOKUP
     * =====================================================
     */

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
          user.id
        )
        .in(
          'membership_status',
          [
            'active',
            'pending',
            'suspended'
          ]
        )
        .limit(1)
        .maybeSingle();


    if (membershipError) {
      throw membershipError;
    }


    if (
      membership?.company_id
    ) {

      const {
        data:memberCompany,
        error:companyError
      } =
        await supabase
          .from('companies')
          .select(
            [
              'id',
              'account_number',
              'company_name',
              'verification_status',
              'account_status',
              'deactivation_reason',
              'deactivated_at'
            ].join(',')
          )
          .eq(
            'id',
            membership.company_id
          )
          .maybeSingle();


      if (companyError) {
        throw companyError;
      }


      if (memberCompany) {

        return sendJson(
          res,
          200,
          {
            success:true,
            source:'membership',
            membership:{
              role:
                membership.role ||
                null,

              status:
                membership.membership_status ||
                null
            },

            company:
              shapeCompany(
                memberCompany
              )
          }
        );
      }
    }


    /*
     * =====================================================
     * 3. OLDER VERIFICATION RECORD FALLBACK
     * =====================================================
     */

    const {
      data:verification,
      error:verificationError
    } =
      await supabase
        .from(
          'employer_verifications'
        )
        .select(
          [
            'company_id',
            'company_name',
            'verification_status'
          ].join(',')
        )
        .eq(
          'user_id',
          user.id
        )
        .limit(1)
        .maybeSingle();


    if (
      !verificationError &&
      verification?.company_id
    ) {

      /*
       * Even for an old verification row,
       * resolve the real company so we can
       * read account_status.
       */

      const {
        data:verifiedCompany,
        error:verifiedCompanyError
      } =
        await supabase
          .from('companies')
          .select(
            [
              'id',
              'account_number',
              'company_name',
              'verification_status',
              'account_status',
              'deactivation_reason',
              'deactivated_at'
            ].join(',')
          )
          .eq(
            'id',
            verification.company_id
          )
          .maybeSingle();


      if (verifiedCompanyError) {
        throw verifiedCompanyError;
      }


      if (verifiedCompany) {

        return sendJson(
          res,
          200,
          {
            success:true,
            source:
              'employer_verification',

            company:
              shapeCompany(
                verifiedCompany
              )
          }
        );
      }


      /*
       * Last-resort compatibility response.
       * No company row means there is no
       * account_status available.
       */

      return sendJson(
        res,
        200,
        {
          success:true,
          source:
            'employer_verification_legacy',

          company:{
            id:
              verification.company_id,

            accountNumber:
              null,

            name:
              verification.company_name ||
              null,

            verificationStatus:
              verification.verification_status ||
              'pending_review',

            accountStatus:
              'active',

            deactivationReason:
              null,

            deactivatedAt:
              null
          }
        }
      );
    }


    /*
     * =====================================================
     * NO COMPANY
     * =====================================================
     */

    return sendJson(
      res,
      404,
      {
        success:false,
        error:
          'No company workspace is connected to this employer account.'
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
          error?.message ||
          'Unable to resolve your company workspace.'
      }
    );
  }
};
