'use strict';

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

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

const ALLOWED_VOICES = new Set([
  'Professional',
  'Friendly',
  'Modern',
  'Direct',
  'Formal',
  'Energetic'
]);

const COMPANY_PRIORITY_LIMIT = 5;
const CANDIDATE_PRIORITY_LIMIT = 5;

function setCors(res) {
  /*
   * Capacitor Android/iOS pages load from https://localhost.
   * Authorization is Bearer-token based, not cookie based, so wildcard
   * origin is safe for CORS while the JWT still protects the endpoint.
   */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'POST, OPTIONS'
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

function sendJson(res, status, payload) {
  setCors(res);
  return res.status(status).json(payload);
}

function cleanText(value, max = 5000) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function cleanDomain(url = '') {
  return String(url)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split(':')[0]
    .trim();
}

function getAccessToken(req) {
  const value =
    req.headers.authorization || '';

  return value.startsWith('Bearer ')
    ? value.slice(7).trim()
    : null;
}

function uniqueStringArray(value, maxItems = 20) {
  if (!Array.isArray(value)) {
    return [];
  }

  const output = [];
  const seen = new Set();

  for (const raw of value) {
    const item = cleanText(raw, 100);
    const key = item.toLowerCase();

    if (!item || seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(item);

    if (output.length >= maxItems) {
      break;
    }
  }

  return output;
}

function validateExactRanking(value, limit, label) {
  const cleaned =
    uniqueStringArray(value, limit + 5);

  if (cleaned.length !== limit) {
    throw new Error(
      `${label} must contain exactly ${limit} unique items.`
    );
  }

  return cleaned;
}

function randomAccountNumber() {
  const chars =
    'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  let value = 'ALY-';

  for (let i = 0; i < 6; i += 1) {
    value +=
      chars[
        Math.floor(
          Math.random() * chars.length
        )
      ];
  }

  return value;
}

async function uniqueAccountNumber() {
  for (let attempts = 0; attempts < 20; attempts += 1) {
    const account =
      randomAccountNumber();

    const { data, error } =
      await supabase
        .from('companies')
        .select('id')
        .eq('account_number', account)
        .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      return account;
    }
  }

  throw new Error(
    'Unable to generate a unique company account number.'
  );
}

function hashEin(ein) {
  const secret =
    process.env.EIN_HASH_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  return crypto
    .createHmac('sha256', secret)
    .update(ein)
    .digest('hex');
}

function validatePayload(body) {
  const companyVoice =
    uniqueStringArray(
      body.company_voice,
      3
    ).filter(value =>
      ALLOWED_VOICES.has(value)
    );

  const payload = {
    company_name:
      cleanText(body.company_name, 160),

    website:
      cleanText(body.website, 500),

    business_phone:
      cleanText(body.business_phone, 40),

    industry:
      cleanText(body.industry, 120),

    company_size:
      cleanText(body.company_size, 40),

    headquarters:
      cleanText(body.headquarters, 160),

    has_dba:
      body.has_dba === true,

    dba_name:
      cleanText(body.dba_name, 160),

    authorized:
      body.authorized === true,

    company_voice:
      companyVoice,

    company_priorities:
      validateExactRanking(
        body.company_priorities,
        COMPANY_PRIORITY_LIMIT,
        'Company strengths'
      ),

    candidate_priorities:
      validateExactRanking(
        body.candidate_priorities,
        CANDIDATE_PRIORITY_LIMIT,
        'Hiring priorities'
      ),

    ai_summary:
      cleanText(body.ai_summary, 1500)
  };

  const required = [
    ['company_name', 'Company name'],
    ['website', 'Company website'],
    ['business_phone', 'Business phone'],
    ['industry', 'Industry'],
    ['company_size', 'Company size'],
    ['headquarters', 'Headquarters']
  ];

  for (const [key, label] of required) {
    if (!payload[key]) {
      throw new Error(
        `${label} is required.`
      );
    }
  }

  if (
    payload.has_dba &&
    !payload.dba_name
  ) {
    throw new Error(
      'DBA or trade name is required.'
    );
  }

  if (
    payload.company_voice.length < 1 ||
    payload.company_voice.length > 3
  ) {
    throw new Error(
      'Choose between 1 and 3 Company Voice options.'
    );
  }

  if (!payload.authorized) {
    throw new Error(
      'You must confirm that you are authorized to recruit for this company.'
    );
  }

  const ein =
    cleanText(body.ein, 20)
      .replace(/\D/g, '');

  if (!/^\d{9}$/.test(ein)) {
    throw new Error(
      'Enter a valid 9-digit EIN.'
    );
  }

  payload.ein_last4 =
    ein.slice(-4);

  payload.ein_hash =
    hashEin(ein);

  let websiteUrl;

  try {
    websiteUrl = new URL(
      payload.website.startsWith('http')
        ? payload.website
        : `https://${payload.website}`
    );
  } catch {
    throw new Error(
      'Please enter a valid company website.'
    );
  }

  if (
    !['http:', 'https:'].includes(
      websiteUrl.protocol
    )
  ) {
    throw new Error(
      'Company website must use HTTP or HTTPS.'
    );
  }

  payload.website =
    websiteUrl.href;

  payload.website_domain =
    cleanDomain(
      websiteUrl.hostname
    );

  if (
    payload.business_phone
      .replace(/\D/g, '')
      .length < 10
  ) {
    throw new Error(
      'Enter a valid business phone number.'
    );
  }

  return payload;
}

async function insertBlueprint(
  companyId,
  payload
) {
  const modern = {
    company_id: companyId,
    company_voice:
      payload.company_voice,
    company_priorities:
      payload.company_priorities,
    candidate_priorities:
      payload.candidate_priorities,
    ai_summary:
      payload.ai_summary || null
  };

  const modernResult =
    await supabase
      .from('company_blueprints')
      .insert(modern);

  if (!modernResult.error) {
    return;
  }

  const schemaMissing =
    /column|schema cache|could not find/i
      .test(
        modernResult.error.message || ''
      );

  if (!schemaMissing) {
    throw new Error(
      `Unable to save the AI Hiring Blueprint: ${modernResult.error.message}`
    );
  }

  const legacy = {
    company_id: companyId,
    company_description:
      payload.ai_summary ||
      'AI Hiring Blueprint created during employer onboarding.',
    company_values:
      payload.company_priorities.join(', '),
    work_environment:
      'Defined through ranked company strengths.',
    ideal_candidate:
      payload.candidate_priorities.join(', '),
    roles_hired:
      'Configured per job posting.',
    required_skills:
      payload.candidate_priorities.join(', '),
    poor_fit:
      'Evaluated against ranked hiring priorities.',
    writing_tone:
      payload.company_voice.join(', '),
    writing_emphasis:
      payload.company_priorities.join(', '),
    avoid_words: null,
    recommendation_style: 'ranked',
    weight_skills: 25,
    weight_culture: 20,
    weight_experience: 15,
    weight_availability: 10,
    weight_location: 10,
    weight_education: 20
  };

  const legacyResult =
    await supabase
      .from('company_blueprints')
      .insert(legacy);

  if (legacyResult.error) {
    throw new Error(
      `Unable to save the AI Hiring Blueprint: ${legacyResult.error.message}`
    );
  }
}

module.exports =
  async function handler(req, res) {
    setCors(res);

    if (req.method === 'OPTIONS') {
      return res
        .status(204)
        .end();
    }

    if (req.method !== 'POST') {
      res.setHeader(
        'Allow',
        'POST, OPTIONS'
      );

      return sendJson(
        res,
        405,
        {
          success: false,
          error: 'Method not allowed.'
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
          success: false,
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
          success: false,
          error:
            'You must be signed in to create a company.'
        }
      );
    }

    let payload;

    try {
      payload =
        validatePayload(
          req.body || {}
        );
    } catch (error) {
      return sendJson(
        res,
        400,
        {
          success: false,
          error:
            error.message
        }
      );
    }

    const {
      data: { user },
      error: userError
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
          success: false,
          error:
            'Your login session is invalid or has expired.'
        }
      );
    }

    if (!user.email_confirmed_at) {
      return sendJson(
        res,
        403,
        {
          success: false,
          error:
            'Please confirm your account email before continuing.'
        }
      );
    }

    /*
     * Alygnn employer signup now allows Gmail, Outlook, Yahoo,
     * iCloud, company-domain addresses, etc.
     * Email domain is NOT used to block company creation.
     */
    const accountEmail =
      String(
        user.email || ''
      )
        .trim()
        .toLowerCase();

    const accountEmailDomain =
      (
        accountEmail.split('@')[1] ||
        ''
      ).toLowerCase();

    let createdCompanyId =
      null;

    try {
      const {
        data: owned,
        error: ownedError
      } =
        await supabase
          .from('companies')
          .select(
            'id,account_number,company_name,verification_status'
          )
          .eq(
            'owner_user_id',
            user.id
          )
          .maybeSingle();

      if (ownedError) {
        throw ownedError;
      }

      if (owned) {
        return sendJson(
          res,
          409,
          {
            success: false,
            error:
              'You already own a company workspace.',
            company: {
              id: owned.id,
              accountNumber:
                owned.account_number,
              name:
                owned.company_name,
              verificationStatus:
                owned.verification_status
            }
          }
        );
      }

      const {
        data: membership,
        error: membershipError
      } =
        await supabase
          .from('company_members')
          .select(
            `
            id,
            role,
            membership_status,
            company_id,
            companies(
              account_number,
              company_name,
              verification_status
            )
            `
          )
          .eq(
            'user_id',
            user.id
          )
          .in(
            'membership_status',
            [
              'pending',
              'active',
              'suspended'
            ]
          )
          .limit(1)
          .maybeSingle();

      if (membershipError) {
        throw membershipError;
      }

      if (membership) {
        const joined =
          Array.isArray(
            membership.companies
          )
            ? membership.companies[0]
            : membership.companies;

        return sendJson(
          res,
          409,
          {
            success: false,
            error:
              'Your account is already connected to a company workspace.',
            company: {
              id:
                membership.company_id,
              accountNumber:
                joined?.account_number ||
                null,
              name:
                joined?.company_name ||
                null,
              verificationStatus:
                joined?.verification_status ||
                'pending_review'
            }
          }
        );
      }

      /*
       * Every new Alygnn employer is manually reviewed.
       * Personal-vs-company email domain no longer affects eligibility.
       */
      const verificationStatus =
        'pending_review';

      const verificationReasons =
        [];

      const accountNumber =
        await uniqueAccountNumber();

      const companyInsert = {
        account_number:
          accountNumber,
        company_name:
          payload.company_name,
        verified_domain:
          null,
        verification_status:
          verificationStatus,
        owner_user_id:
          user.id,
        website:
          payload.website,
        business_phone:
          payload.business_phone,
        industry:
          payload.industry,
        company_size:
          payload.company_size,
        headquarters:
          payload.headquarters
      };

      const {
        data: company,
        error: companyError
      } =
        await supabase
          .from('companies')
          .insert(
            companyInsert
          )
          .select(
            `
            id,
            account_number,
            company_name,
            verification_status,
            verified_domain
            `
          )
          .single();

      if (
        companyError ||
        !company
      ) {
        throw new Error(
          companyError?.message ||
          'Unable to create the company workspace.'
        );
      }

      createdCompanyId =
        company.id;

      const {
        error: memberError
      } =
        await supabase
          .from('company_members')
          .insert({
            company_id:
              company.id,
            user_id:
              user.id,
            role:
              'owner',
            membership_status:
              'active',
            approved_by:
              user.id,
            approved_at:
              new Date()
                .toISOString()
          });

      if (memberError) {
        throw new Error(
          `Unable to create the owner membership: ${memberError.message}`
        );
      }

      await insertBlueprint(
        company.id,
        payload
      );

      const verificationRow = {
        user_id:
          user.id,
        company_id:
          company.id,
        company_name:
          payload.company_name,
        email_domain:
          accountEmailDomain ||
          null,
        website:
          payload.website,
        business_phone:
          payload.business_phone,
        industry:
          payload.industry,
        company_size:
          payload.company_size,
        headquarters:
          payload.headquarters,
        ein_last4:
          payload.ein_last4,
        authorized:
          true,
        blueprint_complete:
          true,
        verification_status:
          'pending_review',
        verification_flags:
          verificationReasons,
        reviewed_by:
          null,
        reviewed_at:
          null,
        rejection_reason:
          null,
        updated_at:
          new Date()
            .toISOString()
      };

      const {
        error: queueError
      } =
        await supabase
          .from(
            'employer_verifications'
          )
          .upsert(
            verificationRow,
            {
              onConflict:
                'user_id'
            }
          );

      if (queueError) {
        throw new Error(
          `Unable to add the employer to the verification queue: ${queueError.message}`
        );
      }

      const details = {
        company_name:
          company.company_name,
        account_number:
          company.account_number,
        verification_status:
          company.verification_status,
        verification_reasons:
          verificationReasons,
        account_email_domain:
          accountEmailDomain ||
          null,
        website_domain:
          payload.website_domain,
        company_voice:
          payload.company_voice,
        company_priorities:
          payload.company_priorities,
        candidate_priorities:
          payload.candidate_priorities,
        ein_last4:
          payload.ein_last4,
        ein_hash:
          payload.ein_hash,
        dba_name:
          payload.dba_name ||
          null
      };

      const {
        error: activityError
      } =
        await supabase
          .from(
            'company_activity_log'
          )
          .insert({
            company_id:
              company.id,
            actor_user_id:
              user.id,
            action:
              'company_created',
            target_user_id:
              user.id,
            details
          });

      if (activityError) {
        throw new Error(
          `Unable to create the company activity record: ${activityError.message}`
        );
      }

      return sendJson(
        res,
        201,
        {
          success: true,
          company: {
            id:
              company.id,
            accountNumber:
              company.account_number,
            name:
              company.company_name,
            verificationStatus:
              company.verification_status,
            verifiedDomain:
              company.verified_domain
          },
          verification: {
            approved: false,
            reasons:
              verificationReasons
          }
        }
      );
    } catch (error) {
      console.error(
        'create-company error:',
        error
      );

      if (createdCompanyId) {
        try {
          await supabase
            .from('companies')
            .delete()
            .eq(
              'id',
              createdCompanyId
            );
        } catch (cleanupError) {
          console.error(
            'cleanup failed:',
            cleanupError
          );
        }
      }

      return sendJson(
        res,
        500,
        {
          success: false,
          error:
            error.message ||
            'Unable to create the company workspace.'
        }
      );
    }
  };
