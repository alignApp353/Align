'use strict';

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com',
  'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'zoho.com', 'gmx.com',
  'gmx.us', 'mail.com', 'yandex.com', 'hey.com', 'fastmail.com',
  'tutanota.com', 'tuta.com'
]);

const ALLOWED_TONES = new Set([
  'Professional', 'Friendly', 'Direct', 'Energetic', 'Formal', 'Modern'
]);

const ALLOWED_RECOMMENDATION_STYLES = new Set(['strict', 'balanced', 'broad']);

function send(res, status, body) {
  res.status(status).json(body);
}

function text(value, maxLength = 5000) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function normalizeWebsite(value) {
  const raw = text(value, 500);
  if (!raw) throw new Error('Company website is required.');

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error('Enter a complete business website, such as https://yourcompany.com.');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Company website must use http or https.');
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const labels = host.split('.');
  const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
  const hasValidLabels =
    labels.length >= 2 &&
    labels.every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)
    );
  const hasValidTld = /^[a-z]{2,63}$/i.test(labels[labels.length - 1] || '');

  if (
    !hasValidLabels ||
    !hasValidTld ||
    host === 'localhost' ||
    isIpv4 ||
    url.username ||
    url.password
  ) {
    throw new Error('Enter a complete business website, such as https://yourcompany.com.');
  }

  url.hash = '';
  return url.toString();
}

function hostnameFromWebsite(website) {
  return new URL(website).hostname.toLowerCase().replace(/^www\./, '');
}

function emailDomain(email) {
  return String(email || '').toLowerCase().split('@')[1] || '';
}

function domainsMatch(emailHost, websiteHost) {
  return emailHost === websiteHost ||
    emailHost.endsWith(`.${websiteHost}`) ||
    websiteHost.endsWith(`.${emailHost}`);
}

function phoneDigits(value) {
  return String(value ?? '').replace(/\D/g, '').slice(0, 20);
}

function einDigits(value) {
  return String(value ?? '').replace(/\D/g, '').slice(0, 9);
}

function hashEin(ein, secret) {
  return crypto.createHmac('sha256', secret).update(ein).digest('hex');
}

function integer(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 100) {
    throw new Error(`${name} must be a whole number from 0 to 100.`);
  }
  return number;
}

function generateAccountNumber() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return `ALY-${code}`;
}

function requireField(payload, key, label, maxLength = 5000) {
  const value = text(payload[key], maxLength);
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

function buildVerifiedPayload(rawPayload, user, einHashSecret) {
  const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};

  const companyName = requireField(payload, 'company_name', 'Legal company name', 180);
  const hasDba = payload.has_dba === true || payload.has_dba === 'true';
  const dbaName = hasDba ? requireField(payload, 'dba_name', 'DBA / trade name', 180) : null;
  const website = normalizeWebsite(payload.website);
  const businessPhone = phoneDigits(payload.business_phone);
  if (businessPhone.length < 10) throw new Error('Enter a valid business phone number.');

  const ein = einDigits(payload.ein);
  if (!/^\d{9}$/.test(ein)) throw new Error('Enter a valid 9-digit EIN.');

  const industry = requireField(payload, 'industry', 'Industry', 120);
  const companySize = requireField(payload, 'company_size', 'Company size', 50);
  const headquarters = requireField(payload, 'headquarters', 'Headquarters', 180);
  const companyDescription = requireField(payload, 'company_description', 'Company description');
  const companyValues = requireField(payload, 'company_values', 'Core values');
  const workEnvironment = requireField(payload, 'work_environment', 'Work environment');
  const idealCandidate = requireField(payload, 'ideal_candidate', 'Ideal candidate');
  const rolesHired = requireField(payload, 'roles_hired', 'Positions usually hired');
  const requiredSkills = requireField(payload, 'required_skills', 'Required skills');
  const poorFit = requireField(payload, 'poor_fit', 'Poor-fit description');
  const writingTone = requireField(payload, 'writing_tone', 'Company voice', 50);
  const writingEmphasis = requireField(payload, 'writing_emphasis', 'Writing emphasis');
  const avoidWords = text(payload.avoid_words);
  const recommendationStyle = requireField(payload, 'recommendation_style', 'Recommendation style', 30);

  if (!ALLOWED_TONES.has(writingTone)) throw new Error('Select a valid company voice.');
  if (!ALLOWED_RECOMMENDATION_STYLES.has(recommendationStyle)) {
    throw new Error('Select a valid recommendation style.');
  }
  if (payload.authorized !== true) {
    throw new Error('You must confirm that you are authorized to represent this company.');
  }

  const weights = {
    weight_skills: integer(payload.weight_skills, 'Skills weight'),
    weight_culture: integer(payload.weight_culture, 'Culture weight'),
    weight_experience: integer(payload.weight_experience, 'Experience weight'),
    weight_availability: integer(payload.weight_availability, 'Availability weight'),
    weight_location: integer(payload.weight_location, 'Location weight'),
    weight_education: integer(payload.weight_education, 'Education weight')
  };

  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (total !== 100) throw new Error(`AI matching weights must total 100%. They currently total ${total}%.`);

  const userEmail = String(user.email || '').trim().toLowerCase();
  const userDomain = emailDomain(userEmail);
  if (!userDomain) throw new Error('Your account does not have a valid email address.');
  if (PERSONAL_EMAIL_DOMAINS.has(userDomain)) {
    throw new Error('Use a company email address to create an employer workspace.');
  }

  const websiteDomain = hostnameFromWebsite(website);
  const checks = {
    business_email: true,
    website: Boolean(websiteDomain),
    business_phone: businessPhone.length >= 10,
    blueprint_complete: true,
    domain_match: domainsMatch(userDomain, websiteDomain),
    authorization: true
  };

  const reviewReasons = [];
  if (!checks.domain_match) reviewReasons.push('email_domain_does_not_match_website');

  return {
    company: {
      company_name: companyName,
      dba_name: dbaName,
      ein_last4: ein.slice(-4),
      ein_hash: hashEin(ein, einHashSecret),
      verified_domain: checks.domain_match ? userDomain : null,
      verification_status: reviewReasons.length ? 'pending_review' : 'approved',
      owner_user_id: user.id,
      website,
      business_phone: businessPhone,
      industry,
      company_size: companySize,
      headquarters
    },
    blueprint: {
      company_description: companyDescription,
      company_values: companyValues,
      work_environment: workEnvironment,
      ideal_candidate: idealCandidate,
      roles_hired: rolesHired,
      required_skills: requiredSkills,
      poor_fit: poorFit,
      writing_tone: writingTone,
      writing_emphasis: writingEmphasis,
      avoid_words: avoidWords || null,
      recommendation_style: recommendationStyle,
      ...weights
    },
    checks,
    reviewReasons,
    userEmail
  };
}

async function createUniqueCompany(admin, companyData) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const accountNumber = generateAccountNumber();
    const { data, error } = await admin
      .from('companies')
      .insert({ ...companyData, account_number: accountNumber })
      .select('id, account_number, company_name, verification_status')
      .single();

    if (!error) return data;
    if (error.code !== '23505') throw error;
  }

  throw new Error('Unable to generate a unique company account number. Please try again.');
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { success: false, error: 'Method not allowed.' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const einHashSecret = process.env.EIN_HASH_SECRET;
  if (!supabaseUrl || !serviceRoleKey || !einHashSecret) {
    console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or EIN_HASH_SECRET');
    return send(res, 500, { success: false, error: 'Server configuration is incomplete.' });
  }

  const authorization = String(req.headers.authorization || '');
  const accessToken = authorization.startsWith('Bearer ')
    ? authorization.slice(7).trim()
    : '';

  if (!accessToken) {
    return send(res, 401, { success: false, error: 'Your session has expired. Sign in again.' });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  let createdCompanyId = null;

  try {
    const { data: authData, error: authError } = await admin.auth.getUser(accessToken);
    const user = authData?.user;
    if (authError || !user) {
      return send(res, 401, { success: false, error: 'Your session is invalid. Sign in again.' });
    }

    if (!user.email_confirmed_at) {
      return send(res, 403, { success: false, error: 'Confirm your company email before continuing.' });
    }

    const { data: existingMembership, error: membershipLookupError } = await admin
      .from('company_members')
      .select('company_id, role, membership_status')
      .eq('user_id', user.id)
      .in('membership_status', ['pending', 'active', 'suspended'])
      .limit(1)
      .maybeSingle();

    if (membershipLookupError) throw membershipLookupError;
    if (existingMembership) {
      return send(res, 409, {
        success: false,
        error: 'Your account already belongs to a company workspace.',
        code: 'COMPANY_MEMBERSHIP_EXISTS'
      });
    }

    const { data: existingOwnedCompany, error: ownerLookupError } = await admin
      .from('companies')
      .select('id, account_number, verification_status')
      .eq('owner_user_id', user.id)
      .limit(1)
      .maybeSingle();

    if (ownerLookupError) throw ownerLookupError;
    if (existingOwnedCompany) {
      return send(res, 409, {
        success: false,
        error: 'You already created a company workspace.',
        code: 'COMPANY_ALREADY_EXISTS',
        company: {
          id: existingOwnedCompany.id,
          accountNumber: existingOwnedCompany.account_number,
          verificationStatus: existingOwnedCompany.verification_status
        }
      });
    }

    const verified = buildVerifiedPayload(req.body, user, einHashSecret);
    const company = await createUniqueCompany(admin, verified.company);
    createdCompanyId = company.id;

    const { error: memberError } = await admin.from('company_members').insert({
      company_id: company.id,
      user_id: user.id,
      role: 'owner',
      membership_status: 'active',
      approved_by: user.id,
      approved_at: new Date().toISOString()
    });
    if (memberError) throw memberError;

    const { error: blueprintError } = await admin.from('company_blueprints').insert({
      company_id: company.id,
      ...verified.blueprint
    });
    if (blueprintError) throw blueprintError;

    const { error: activityError } = await admin.from('company_activity_log').insert({
      company_id: company.id,
      actor_user_id: user.id,
      action: 'company_created',
      target_user_id: user.id,
      details: {
        account_number: company.account_number,
        verification_status: company.verification_status,
        verification_checks: verified.checks,
        review_reasons: verified.reviewReasons,
        business_email: verified.userEmail
      }
    });
    if (activityError) throw activityError;

    return send(res, 201, {
      success: true,
      company: {
        id: company.id,
        name: company.company_name,
        accountNumber: company.account_number,
        verificationStatus: company.verification_status
      },
      verification: {
        checks: verified.checks,
        reviewReasons: verified.reviewReasons
      }
    });
  } catch (error) {
    console.error('create-company failed:', error);

    if (createdCompanyId) {
      const { error: cleanupError } = await admin
        .from('companies')
        .delete()
        .eq('id', createdCompanyId);
      if (cleanupError) console.error('create-company cleanup failed:', cleanupError);
    }

    const message = error instanceof Error ? error.message : 'Unable to create the company workspace.';
    const clientError = /required|valid|must|company email|authorized|weights|already/i.test(message);
    return send(res, clientError ? 400 : 500, {
      success: false,
      error: clientError ? message : 'Unable to create the company workspace. Please try again.'
    });
  }
};
