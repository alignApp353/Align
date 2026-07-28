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

const PERSONAL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'yahoo.com',
  'ymail.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'mail.com',
  'zoho.com'
]);

function cleanDomain(url = '') {
  return String(url)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split(':')[0]
    .trim();
}

function randomAccountNumber() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  let value = 'ALY-';

  for (let i = 0; i < 6; i++) {
    value += chars[Math.floor(Math.random() * chars.length)];
  }

  return value;
}

async function uniqueAccountNumber() {
  while (true) {

    const account = randomAccountNumber();

    const { data } = await supabase
      .from('companies')
      .select('id')
      .eq('account_number', account)
      .maybeSingle();

    if (!data) return account;

  }
}
function sendJson(res, statusCode, payload) {
  res.status(statusCode).json(payload);
}

function getAccessToken(req) {
  const authorization = req.headers.authorization || '';

  if (!authorization.startsWith('Bearer ')) {
    return null;
  }

  return authorization.slice(7).trim();
}

function cleanText(value, maxLength = 5000) {
  return String(value ?? '')
    .trim()
    .slice(0, maxLength);
}

function validatePayload(body) {
  const payload = {
    company_name: cleanText(body.company_name, 160),
    website: cleanText(body.website, 500),
    business_phone: cleanText(body.business_phone, 40),
    industry: cleanText(body.industry, 120),
    company_size: cleanText(body.company_size, 40),
    headquarters: cleanText(body.headquarters, 160),
    ein_last4: cleanText(body.ein_last4, 4),

    company_description: cleanText(body.company_description, 5000),
    company_values: cleanText(body.company_values, 5000),
    work_environment: cleanText(body.work_environment, 5000),

    ideal_candidate: cleanText(body.ideal_candidate, 5000),
    roles_hired: cleanText(body.roles_hired, 5000),
    required_skills: cleanText(body.required_skills, 5000),
    poor_fit: cleanText(body.poor_fit, 5000),

    writing_tone: cleanText(body.writing_tone, 80),
    writing_emphasis: cleanText(body.writing_emphasis, 5000),
    avoid_words: cleanText(body.avoid_words, 5000),

    recommendation_style: cleanText(body.recommendation_style, 40),

    weight_skills: Number(body.weight_skills),
    weight_culture: Number(body.weight_culture),
    weight_experience: Number(body.weight_experience),
    weight_availability: Number(body.weight_availability),
    weight_location: Number(body.weight_location),
    weight_education: Number(body.weight_education),

    authorized: body.authorized === true
  };

  const requiredFields = [
    ['company_name', 'Company name'],
    ['website', 'Company website'],
    ['business_phone', 'Business phone'],
    ['industry', 'Industry'],
    ['company_size', 'Company size'],
    ['headquarters', 'Headquarters'],
    ['company_description', 'Company description'],
    ['company_values', 'Company values'],
    ['work_environment', 'Work environment'],
    ['ideal_candidate', 'Ideal candidate'],
    ['roles_hired', 'Positions hired'],
    ['required_skills', 'Required skills'],
    ['poor_fit', 'Poor-fit criteria'],
    ['writing_tone', 'Writing tone'],
    ['writing_emphasis', 'Writing emphasis'],
    ['recommendation_style', 'Recommendation style']
  ];

  for (const [key, label] of requiredFields) {
    if (!payload[key]) {
      throw new Error(`${label} is required.`);
    }
  }

  if (!payload.authorized) {
    throw new Error(
      'You must confirm that you are authorized to recruit for this company.'
    );
  }

  if (payload.ein_last4 && !/^\d{4}$/.test(payload.ein_last4)) {
    throw new Error('EIN last four digits must contain exactly four numbers.');
  }

  let websiteUrl;

  try {
    websiteUrl = new URL(
      payload.website.startsWith('http')
        ? payload.website
        : `https://${payload.website}`
    );
  } catch {
    throw new Error('Please enter a valid company website.');
  }

  if (!['http:', 'https:'].includes(websiteUrl.protocol)) {
    throw new Error('Company website must use HTTP or HTTPS.');
  }

  payload.website = websiteUrl.href;
  payload.website_domain = cleanDomain(websiteUrl.hostname);

  const weights = [
    payload.weight_skills,
    payload.weight_culture,
    payload.weight_experience,
    payload.weight_availability,
    payload.weight_location,
    payload.weight_education
  ];

  if (
    weights.some(
      weight =>
        !Number.isInteger(weight) ||
        weight < 0 ||
        weight > 100
    )
  ) {
    throw new Error('Every AI matching weight must be a whole number from 0 to 100.');
  }

  const totalWeight = weights.reduce((total, weight) => total + weight, 0);

  if (totalWeight !== 100) {
    throw new Error(
      `AI matching weights must total 100%. They currently total ${totalWeight}%.`
    );
  }

  return payload;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');

    return sendJson(res, 405, {
      success: false,
      error: 'Method not allowed.'
    });
  }

  if (
    !process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    console.error('Missing Supabase server environment variables.');

    return sendJson(res, 500, {
      success: false,
      error: 'Server configuration is incomplete.'
    });
  }

  const accessToken = getAccessToken(req);

  if (!accessToken) {
    return sendJson(res, 401, {
      success: false,
      error: 'You must be signed in to create a company.'
    });
  }

  let payload;

  try {
    payload = validatePayload(req.body || {});
  } catch (error) {
    return sendJson(res, 400, {
      success: false,
      error: error.message
    });
  }

  const {
    data: { user },
    error: userError
  } = await supabase.auth.getUser(accessToken);

  if (userError || !user) {
    return sendJson(res, 401, {
      success: false,
      error: 'Your login session is invalid or has expired.'
    });
  }

  if (!user.email_confirmed_at) {
    return sendJson(res, 403, {
      success: false,
      error: 'Please confirm your company email before continuing.'
    });
  }

  const email = String(user.email || '').trim().toLowerCase();
  const emailDomain = email.split('@')[1] || '';

  if (!emailDomain) {
    return sendJson(res, 400, {
      success: false,
      error: 'Your account does not have a valid email address.'
    });
  }

  if (PERSONAL_DOMAINS.has(emailDomain)) {
    return sendJson(res, 403, {
      success: false,
      error: 'Please use a company email address instead of a personal email.'
    });
  }
    let createdCompanyId = null;

  try {
    const { data: existingOwnedCompany, error: existingCompanyError } =
      await supabase
        .from('companies')
        .select('id, account_number, company_name, verification_status')
        .eq('owner_user_id', user.id)
        .maybeSingle();

    if (existingCompanyError) {
      throw new Error(
        `Unable to check your existing company: ${existingCompanyError.message}`
      );
    }

    if (existingOwnedCompany) {
      return sendJson(res, 409, {
        success: false,
        error: 'You already own a company workspace.',
        company: {
          id: existingOwnedCompany.id,
          accountNumber: existingOwnedCompany.account_number,
          name: existingOwnedCompany.company_name,
          verificationStatus: existingOwnedCompany.verification_status
        }
      });
    }

    const { data: existingMembership, error: membershipCheckError } =
      await supabase
        .from('company_members')
        .select(`
          id,
          role,
          membership_status,
          company_id,
          companies (
            account_number,
            company_name,
            verification_status
          )
        `)
        .eq('user_id', user.id)
        .in('membership_status', ['pending', 'active', 'suspended'])
        .limit(1)
        .maybeSingle();

    if (membershipCheckError) {
      throw new Error(
        `Unable to check your company membership: ${membershipCheckError.message}`
      );
    }

    if (existingMembership) {
      const joinedCompany = Array.isArray(existingMembership.companies)
        ? existingMembership.companies[0]
        : existingMembership.companies;

      return sendJson(res, 409, {
        success: false,
        error: 'Your account is already connected to a company workspace.',
        company: {
          id: existingMembership.company_id,
          accountNumber: joinedCompany?.account_number || null,
          name: joinedCompany?.company_name || null,
          verificationStatus:
            joinedCompany?.verification_status || 'pending_review'
        }
      });
    }

    const emailDomainMatchesWebsite =
      emailDomain === payload.website_domain;

    const verificationStatus = emailDomainMatchesWebsite
      ? 'approved'
      : 'pending_review';

    const verificationReasons = [];

    if (!emailDomainMatchesWebsite) {
      verificationReasons.push('email_website_domain_mismatch');
    }

    if (payload.business_phone.replace(/\D/g, '').length < 10) {
      verificationReasons.push('business_phone_needs_review');
    }

    if (payload.company_description.length < 40) {
      verificationReasons.push('company_description_too_short');
    }

    const finalVerificationStatus =
      verificationReasons.length === 0
        ? verificationStatus
        : 'pending_review';

    const accountNumber = await uniqueAccountNumber();

    const { data: company, error: companyError } = await supabase
      .from('companies')
      .insert({
        account_number: accountNumber,
        company_name: payload.company_name,
        verified_domain: emailDomainMatchesWebsite
          ? emailDomain
          : null,
        verification_status: finalVerificationStatus,
        owner_user_id: user.id,
        website: payload.website,
        business_phone: payload.business_phone,
        industry: payload.industry,
        company_size: payload.company_size,
        headquarters: payload.headquarters
      })
      .select(`
        id,
        account_number,
        company_name,
        verification_status,
        verified_domain
      `)
      .single();

    if (companyError || !company) {
      throw new Error(
        companyError?.message || 'Unable to create the company workspace.'
      );
    }

    createdCompanyId = company.id;
        const { error: ownerMembershipError } = await supabase
      .from('company_members')
      .insert({
        company_id: company.id,
        user_id: user.id,
        role: 'owner',
        membership_status: 'active',
        approved_by: user.id,
        approved_at: new Date().toISOString()
      });

    if (ownerMembershipError) {
      throw new Error(
        `Unable to create the owner membership: ${ownerMembershipError.message}`
      );
    }

    const { error: blueprintError } = await supabase
      .from('company_blueprints')
      .insert({
        company_id: company.id,

        company_description: payload.company_description,
        company_values: payload.company_values,
        work_environment: payload.work_environment,

        ideal_candidate: payload.ideal_candidate,
        roles_hired: payload.roles_hired,
        required_skills: payload.required_skills,
        poor_fit: payload.poor_fit,

        writing_tone: payload.writing_tone,
        writing_emphasis: payload.writing_emphasis,
        avoid_words: payload.avoid_words || null,

        recommendation_style: payload.recommendation_style,

        weight_skills: payload.weight_skills,
        weight_culture: payload.weight_culture,
        weight_experience: payload.weight_experience,
        weight_availability: payload.weight_availability,
        weight_location: payload.weight_location,
        weight_education: payload.weight_education
      });

    if (blueprintError) {
      throw new Error(
        `Unable to save the AI Hiring Blueprint: ${blueprintError.message}`
      );
    }

    const { error: activityError } = await supabase
      .from('company_activity_log')
      .insert({
        company_id: company.id,
        actor_user_id: user.id,
        action: 'company_created',
        target_user_id: user.id,
        details: {
          company_name: company.company_name,
          account_number: company.account_number,
          verification_status: company.verification_status,
          verification_reasons: verificationReasons,
          email_domain: emailDomain,
          website_domain: payload.website_domain
        }
      });

    if (activityError) {
      throw new Error(
        `Unable to create the company activity record: ${activityError.message}`
      );
    }

    return sendJson(res, 201, {
      success: true,
      company: {
        id: company.id,
        accountNumber: company.account_number,
        name: company.company_name,
        verificationStatus: company.verification_status,
        verifiedDomain: company.verified_domain
      },
      verification: {
        approved: company.verification_status === 'approved',
        reasons: verificationReasons
      }
    });
      } catch (error) {
    console.error('create-company error:', error);

    if (createdCompanyId) {
      try {
        await supabase
          .from('companies')
          .delete()
          .eq('id', createdCompanyId);
      } catch (cleanupError) {
        console.error(
          'Failed to clean up partially created company:',
          cleanupError
        );
      }
    }

    return sendJson(res, 500, {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'An unexpected error occurred while creating the company.'
    });
  }
};
