'use strict';

const { createClient } = require('@supabase/supabase-js');

const ALLOWED_ORIGINS = new Set([
  'https://localhost',
  'http://localhost',
  'capacitor://localhost',
  'https://alygnn.com',
  'https://www.alygnn.com'
]);

function applyCors(req, res) {
  const origin = req.headers.origin || '';

  if (
    ALLOWED_ORIGINS.has(origin) ||
    origin.endsWith('.vercel.app')
  ) {
    res.setHeader(
      'Access-Control-Allow-Origin',
      origin
    );
  }

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type'
  );

  res.setHeader(
    'Access-Control-Allow-Credentials',
    'true'
  );

  res.setHeader(
    'Vary',
    'Origin'
  );
}

function sendJson(res, status, payload) {
  return res.status(status).json(payload);
}

function getAccessToken(req) {
  const value =
    req.headers.authorization || '';

  if (!value.startsWith('Bearer ')) {
    return null;
  }

  return value.slice(7).trim();
}

module.exports = async function handler(
  req,
  res
) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return sendJson(res, 405, {
      success: false,
      error: 'Method not allowed.'
    });
  }

  if (
    !process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    return sendJson(res, 500, {
      success: false,
      error:
        'Server configuration is incomplete.'
    });
  }

  const token = getAccessToken(req);

  if (!token) {
    return sendJson(res, 401, {
      success: false,
      error: 'You must be signed in.'
    });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    }
  );

  const {
    data: { user },
    error: userError
  } = await supabase.auth.getUser(token);

  if (userError || !user) {
    console.error(
      'resolve-company auth error:',
      userError
    );

    return sendJson(res, 401, {
      success: false,
      error:
        'Your login session is invalid or expired.'
    });
  }

  try {
    /*
     * 1. Look for a company directly owned
     *    by the signed-in employer.
     */
    const {
      data: ownedCompany,
      error: ownerError
    } = await supabase
      .from('companies')
      .select(
        `
        id,
        account_number,
        company_name,
        verification_status,
        owner_user_id
        `
      )
      .eq('owner_user_id', user.id)
      .limit(1)
      .maybeSingle();

    if (ownerError) {
      console.error(
        'Owner company lookup failed:',
        ownerError
      );
    }

    if (ownedCompany?.id) {
      return sendJson(res, 200, {
        success: true,
        source: 'owner',
        company: {
          id: ownedCompany.id,
          accountNumber:
            ownedCompany.account_number ||
            null,
          name:
            ownedCompany.company_name ||
            null,
          verificationStatus:
            ownedCompany.verification_status ||
            'pending_review'
        }
      });
    }

    /*
     * 2. Look for a company membership.
     */
    const {
      data: membership,
      error: membershipError
    } = await supabase
      .from('company_members')
      .select(
        `
        company_id,
        role,
        membership_status
        `
      )
      .eq('user_id', user.id)
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
      console.error(
        'Membership lookup failed:',
        membershipError
      );
    }

    if (membership?.company_id) {
      const {
        data: memberCompany,
        error: companyError
      } = await supabase
        .from('companies')
        .select(
          `
          id,
          account_number,
          company_name,
          verification_status
          `
        )
        .eq(
          'id',
          membership.company_id
        )
        .maybeSingle();

      if (companyError) {
        console.error(
          'Member company lookup failed:',
          companyError
        );
      }

      if (memberCompany?.id) {
        return sendJson(res, 200, {
          success: true,
          source: 'membership',
          company: {
            id: memberCompany.id,
            accountNumber:
              memberCompany.account_number ||
              null,
            name:
              memberCompany.company_name ||
              null,
            verificationStatus:
              memberCompany.verification_status ||
              'pending_review'
          }
        });
      }
    }

    /*
     * 3. Fallback to employer_verifications.
     */
    const {
      data: verification,
      error: verificationError
    } = await supabase
      .from('employer_verifications')
      .select(
        `
        company_id,
        company_name,
        verification_status
        `
      )
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle();

    if (verificationError) {
      console.error(
        'Verification lookup failed:',
        verificationError
      );
    }

    if (verification?.company_id) {
      return sendJson(res, 200, {
        success: true,
        source: 'verification',
        company: {
          id: verification.company_id,
          accountNumber: null,
          name:
            verification.company_name ||
            null,
          verificationStatus:
            verification.verification_status ||
            'pending_review'
        }
      });
    }

    console.error(
      'No company found for employer:',
      user.id
    );

    return sendJson(res, 404, {
      success: false,
      error:
        'No company workspace is connected to this employer account.'
    });
  } catch (error) {
    console.error(
      'resolve-company failed:',
      error
    );

    return sendJson(res, 500, {
      success: false,
      error:
        error?.message ||
        'Unable to resolve your company workspace.'
    });
  }
};
