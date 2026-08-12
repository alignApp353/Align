'use strict';

const { createClient } = require('@supabase/supabase-js');

function sendJson(res, status, payload) {
  res.status(status).json(payload);
}

function getAccessToken(req) {
  const value = req.headers.authorization || '';

  return value.startsWith('Bearer ')
    ? value.slice(7).trim()
    : null;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');

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
      error: 'Server configuration is incomplete.'
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
    return sendJson(res, 401, {
      success: false,
      error: 'Your login session is invalid or has expired.'
    });
  }

  try {
    // First look for a company owned directly by this employer.
    const {
      data: ownedCompany,
      error: ownerError
    } = await supabase
      .from('companies')
      .select(
        'id,account_number,company_name,legal_name,verification_status,owner_user_id'
      )
      .eq('owner_user_id', user.id)
      .limit(1)
      .maybeSingle();

    if (ownerError) {
      // Some versions of the companies table may not have legal_name.
      const fallback = await supabase
        .from('companies')
        .select(
          'id,account_number,company_name,verification_status,owner_user_id'
        )
        .eq('owner_user_id', user.id)
        .limit(1)
        .maybeSingle();

      if (fallback.error) {
        throw fallback.error;
      }

      if (fallback.data) {
        return sendJson(res, 200, {
          success: true,
          company: {
            id: fallback.data.id,
            accountNumber:
              fallback.data.account_number || null,
            name:
              fallback.data.company_name || null,
            verificationStatus:
              fallback.data.verification_status ||
              'pending_review'
          }
        });
      }
    }

    if (ownedCompany) {
      return sendJson(res, 200, {
        success: true,
        company: {
          id: ownedCompany.id,
          accountNumber:
            ownedCompany.account_number || null,
          name:
            ownedCompany.company_name ||
            ownedCompany.legal_name ||
            null,
          verificationStatus:
            ownedCompany.verification_status ||
            'pending_review'
        }
      });
    }

    // Fallback for invited or member employer accounts.
    const {
      data: membership,
      error: membershipError
    } = await supabase
      .from('company_members')
      .select(
        'company_id,role,membership_status'
      )
      .eq('user_id', user.id)
      .in(
        'membership_status',
        ['active', 'pending', 'suspended']
      )
      .limit(1)
      .maybeSingle();

    if (membershipError) {
      throw membershipError;
    }

    if (membership?.company_id) {
      const {
        data: memberCompany,
        error: companyError
      } = await supabase
        .from('companies')
        .select(
          'id,account_number,company_name,verification_status'
        )
        .eq('id', membership.company_id)
        .maybeSingle();

      if (companyError) {
        throw companyError;
      }

      if (memberCompany) {
        return sendJson(res, 200, {
          success: true,
          company: {
            id: memberCompany.id,
            accountNumber:
              memberCompany.account_number || null,
            name:
              memberCompany.company_name || null,
            verificationStatus:
              memberCompany.verification_status ||
              'pending_review'
          }
        });
      }
    }

    // Last fallback for older employer verification records.
    const {
      data: verification,
      error: verificationError
    } = await supabase
      .from('employer_verifications')
      .select(
        'company_id,company_name,verification_status'
      )
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle();

    if (
      !verificationError &&
      verification?.company_id
    ) {
      return sendJson(res, 200, {
        success: true,
        company: {
          id: verification.company_id,
          accountNumber: null,
          name:
            verification.company_name || null,
          verificationStatus:
            verification.verification_status ||
            'pending_review'
        }
      });
    }

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
