'use strict';

const { createClient } = require('@supabase/supabase-js');

function sendJson(res, status, payload) {
  return res.status(status).json(payload);
}

function getAccessToken(req) {
  const value = String(req.headers.authorization || '');

  return value.toLowerCase().startsWith('bearer ')
    ? value.slice(7).trim()
    : '';
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
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    }
  );
}

function isMissingSchemaError(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '').toLowerCase();

  return (
    code === '42P01' ||
    code === '42703' ||
    code === 'PGRST204' ||
    code === 'PGRST205' ||
    message.includes('does not exist') ||
    message.includes('could not find the') ||
    message.includes('schema cache')
  );
}

async function safeDeleteBy(
  supabase,
  table,
  column,
  value
) {
  const { error } = await supabase
    .from(table)
    .delete()
    .eq(column, value);

  if (error && !isMissingSchemaError(error)) {
    throw new Error(
      `${table}.${column} cleanup failed: ${error.message}`
    );
  }
}

async function safeNullBy(
  supabase,
  table,
  column,
  value
) {
  const { error } = await supabase
    .from(table)
    .update({
      [column]: null
    })
    .eq(column, value);

  if (error && !isMissingSchemaError(error)) {
    console.warn(
      `Could not clear ${table}.${column}:`,
      error.message
    );
  }
}

async function safeSelectIds(
  supabase,
  table,
  select,
  column,
  value
) {
  const { data, error } = await supabase
    .from(table)
    .select(select)
    .eq(column, value);

  if (error) {
    if (isMissingSchemaError(error)) {
      return [];
    }

    throw new Error(
      `${table}.${column} lookup failed: ${error.message}`
    );
  }

  return data || [];
}

async function listAllFiles(
  storageBucket,
  rootPrefix
) {
  const files = [];

  const folders = [
    String(rootPrefix || '')
      .replace(/^\/+|\/+$/g, '')
  ];

  let safetyCount = 0;

  while (
    folders.length &&
    safetyCount < 10000
  ) {
    const folder = folders.shift();

    let offset = 0;

    while (safetyCount < 10000) {
      const {
        data,
        error
      } = await storageBucket.list(
        folder,
        {
          limit: 100,
          offset,
          sortBy: {
            column: 'name',
            order: 'asc'
          }
        }
      );

      if (error) {
        console.warn(
          `Could not list storage folder "${folder}":`,
          error.message
        );

        break;
      }

      const rows = data || [];

      if (!rows.length) {
        break;
      }

      for (const item of rows) {
        safetyCount += 1;

        const path = folder
          ? `${folder}/${item.name}`
          : item.name;

        if (
          item.id ||
          item.metadata
        ) {
          files.push(path);
        } else {
          folders.push(path);
        }
      }

      if (rows.length < 100) {
        break;
      }

      offset += rows.length;
    }
  }

  return files;
}

async function removePaths(
  storageBucket,
  paths
) {
  const unique = [
    ...new Set(
      (paths || []).filter(Boolean)
    )
  ];

  for (
    let i = 0;
    i < unique.length;
    i += 100
  ) {
    const batch = unique.slice(
      i,
      i + 100
    );

    const { error } =
      await storageBucket.remove(batch);

    if (error) {
      throw new Error(
        `Could not remove stored account files: ${error.message}`
      );
    }
  }
}

async function cleanupStorage(
  supabase,
  userId,
  profile,
  ownedCompanyIds
) {
  /*
   * Candidate resumes
   */
  const resumeBucket =
    supabase.storage.from('resumes');

  const resumePaths =
    await listAllFiles(
      resumeBucket,
      userId
    );

  if (profile?.resume_file_path) {
    resumePaths.push(
      profile.resume_file_path
    );
  }

  if (resumePaths.length) {
    await removePaths(
      resumeBucket,
      resumePaths
    );
  }

  /*
   * Employer verification files
   */
  const employerBucket =
    supabase.storage.from(
      'employer-verification-documents'
    );

  const employerPaths = [];

  if (
    profile?.hiring_blueprint
      ?.irs_document_path
  ) {
    employerPaths.push(
      profile.hiring_blueprint
        .irs_document_path
    );
  }

  const verificationDocs =
    await safeSelectIds(
      supabase,
      'employer_verification_documents',
      'storage_path',
      'uploaded_by',
      userId
    );

  for (const row of verificationDocs) {
    if (row.storage_path) {
      employerPaths.push(
        row.storage_path
      );
    }
  }

  /*
   * Older storage layout:
   * <user-id>/...
   */
  employerPaths.push(
    ...(
      await listAllFiles(
        employerBucket,
        userId
      )
    )
  );

  /*
   * Newer company-scoped layout:
   * <company-id>/...
   */
  for (
    const companyId
    of ownedCompanyIds
  ) {
    employerPaths.push(
      ...(
        await listAllFiles(
          employerBucket,
          companyId
        )
      )
    );
  }

  if (employerPaths.length) {
    await removePaths(
      employerBucket,
      employerPaths
    );
  }
}

async function cleanupCandidateData(
  supabase,
  userId
) {
  const candidateTables = [
    [
      'applications',
      'candidate_id'
    ],
    [
      'skipped_jobs',
      'candidate_id'
    ],
    [
      'saved_jobs',
      'candidate_id'
    ],
    [
      'liked_jobs',
      'candidate_id'
    ],
    [
      'job_likes',
      'candidate_id'
    ],
    [
      'swipes',
      'candidate_id'
    ],
    [
      'swipe_actions',
      'candidate_id'
    ],
    [
      'password_change_codes',
      'user_id'
    ]
  ];

  for (
    const [
      table,
      column
    ] of candidateTables
  ) {
    await safeDeleteBy(
      supabase,
      table,
      column,
      userId
    );
  }
}

async function deleteJobDependents(
  supabase,
  jobIds
) {
  for (const jobId of jobIds) {
    await safeDeleteBy(
      supabase,
      'applications',
      'job_id',
      jobId
    );

    await safeDeleteBy(
      supabase,
      'skipped_jobs',
      'job_id',
      jobId
    );

    await safeDeleteBy(
      supabase,
      'saved_jobs',
      'job_id',
      jobId
    );

    await safeDeleteBy(
      supabase,
      'liked_jobs',
      'job_id',
      jobId
    );

    await safeDeleteBy(
      supabase,
      'job_likes',
      'job_id',
      jobId
    );

    await safeDeleteBy(
      supabase,
      'swipes',
      'job_id',
      jobId
    );

    await safeDeleteBy(
      supabase,
      'swipe_actions',
      'job_id',
      jobId
    );
  }
}

async function cleanupJobsOwnedByUser(
  supabase,
  userId
) {
  const ownershipColumns = [
    'employer_id',
    'created_by',
    'user_id',
    'owner_id'
  ];

  const jobIds = new Set();

  for (
    const column
    of ownershipColumns
  ) {
    const rows =
      await safeSelectIds(
        supabase,
        'jobs',
        'id',
        column,
        userId
      );

    rows.forEach(row => {
      if (row?.id) {
        jobIds.add(row.id);
      }
    });
  }

  await deleteJobDependents(
    supabase,
    [...jobIds]
  );

  for (
    const column
    of ownershipColumns
  ) {
    await safeDeleteBy(
      supabase,
      'jobs',
      column,
      userId
    );
  }
}

async function cleanupCompanyData(
  supabase,
  userId
) {
  const ownedCompanies =
    await safeSelectIds(
      supabase,
      'companies',
      'id',
      'owner_user_id',
      userId
    );

  const ownedCompanyIds =
    ownedCompanies
      .map(row => row?.id)
      .filter(Boolean);

  /*
   * Remove reviewer / approver
   * references first.
   */
  await safeNullBy(
    supabase,
    'company_members',
    'approved_by',
    userId
  );

  await safeNullBy(
    supabase,
    'employer_verifications',
    'reviewed_by',
    userId
  );

  await safeNullBy(
    supabase,
    'employer_verification_documents',
    'reviewed_by',
    userId
  );

  /*
   * Remove activity log rows
   * that identify this user.
   */
  await safeDeleteBy(
    supabase,
    'company_activity_log',
    'actor_user_id',
    userId
  );

  await safeDeleteBy(
    supabase,
    'company_activity_log',
    'target_user_id',
    userId
  );

  /*
   * If this person is simply a member
   * of another company, remove membership.
   */
  await safeDeleteBy(
    supabase,
    'company_members',
    'user_id',
    userId
  );

  /*
   * If they OWN a company,
   * clean that company too.
   */
  for (
    const companyId
    of ownedCompanyIds
  ) {
    const companyJobs =
      await safeSelectIds(
        supabase,
        'jobs',
        'id',
        'company_id',
        companyId
      );

    await deleteJobDependents(
      supabase,
      companyJobs
        .map(row => row?.id)
        .filter(Boolean)
    );

    await safeDeleteBy(
      supabase,
      'jobs',
      'company_id',
      companyId
    );

    await safeDeleteBy(
      supabase,
      'employer_verification_documents',
      'company_id',
      companyId
    );

    await safeDeleteBy(
      supabase,
      'employer_verifications',
      'company_id',
      companyId
    );

    await safeDeleteBy(
      supabase,
      'company_activity_log',
      'company_id',
      companyId
    );

    await safeDeleteBy(
      supabase,
      'company_blueprints',
      'company_id',
      companyId
    );

    await safeDeleteBy(
      supabase,
      'company_members',
      'company_id',
      companyId
    );

    await safeDeleteBy(
      supabase,
      'companies',
      'id',
      companyId
    );
  }

  return ownedCompanyIds;
}

module.exports =
async function handler(
  req,
  res
) {
  res.setHeader(
    'Cache-Control',
    'no-store'
  );

  if (req.method === 'OPTIONS') {
    res.setHeader(
      'Allow',
      'POST, OPTIONS'
    );

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
        error:
          'Method not allowed.'
      }
    );
  }

  let supabase;

  try {
    supabase =
      serviceClient();
  } catch (error) {
    console.error(
      'Delete account configuration error:',
      error
    );

    return sendJson(
      res,
      500,
      {
        success: false,
        error:
          'Account deletion is not configured on the server.'
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
          'You must be signed in to delete your account.'
      }
    );
  }

  const {
    data: {
      user
    },
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

  try {
    /*
     * Load the profile first.
     */
    const {
      data: profile,
      error: profileError
    } =
      await supabase
        .from('profiles')
        .select('*')
        .eq(
          'id',
          user.id
        )
        .maybeSingle();

    if (
      profileError &&
      !isMissingSchemaError(
        profileError
      )
    ) {
      console.warn(
        'Could not read profile before deletion:',
        profileError.message
      );
    }

    /*
     * Find any company this
     * user owns.
     */
    const ownedCompanies =
      await safeSelectIds(
        supabase,
        'companies',
        'id',
        'owner_user_id',
        user.id
      );

    const ownedCompanyIds =
      ownedCompanies
        .map(
          row => row?.id
        )
        .filter(Boolean);

    /*
     * 1. Delete Storage files.
     */
    await cleanupStorage(
      supabase,
      user.id,
      profile || null,
      ownedCompanyIds
    );

    /*
     * 2. Delete candidate data.
     */
    await cleanupCandidateData(
      supabase,
      user.id
    );

    /*
     * 3. Delete jobs owned
     * by this account.
     */
    await cleanupJobsOwnedByUser(
      supabase,
      user.id
    );

    /*
     * 4. Delete company relationships.
     */
    await cleanupCompanyData(
      supabase,
      user.id
    );

    /*
     * 5. Delete verification records.
     */
    await safeDeleteBy(
      supabase,
      'employer_verification_documents',
      'uploaded_by',
      user.id
    );

    await safeDeleteBy(
      supabase,
      'employer_verifications',
      'user_id',
      user.id
    );

    await safeDeleteBy(
      supabase,
      'employer_entitlements',
      'employer_id',
      user.id
    );

    /*
     * 6. Delete public profile.
     */
    await safeDeleteBy(
      supabase,
      'profiles',
      'id',
      user.id
    );

    /*
     * 7. Permanently delete
     * the Supabase Auth account.
     *
     * false = HARD delete.
     */
    const {
      error: deleteUserError
    } =
      await supabase.auth.admin
        .deleteUser(
          user.id,
          false
        );

    if (deleteUserError) {
      console.error(
        'Supabase Auth deletion failed:',
        deleteUserError
      );

      return sendJson(
        res,
        500,
        {
          success: false,
          error:
            'Database error deleting user. ' +
            'A remaining database reference is still attached to this account. ' +
            'Check the Vercel function log for the exact foreign-key constraint.'
        }
      );
    }

    return sendJson(
      res,
      200,
      {
        success: true
      }
    );
  } catch (error) {
    console.error(
      'Delete account failed:',
      error
    );

    return sendJson(
      res,
      500,
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'We could not delete your account.'
      }
    );
  }
};
