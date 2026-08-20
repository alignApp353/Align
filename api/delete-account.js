'use strict';

const { createClient } = require('@supabase/supabase-js');

/* =========================================================
   BASIC HELPERS
========================================================= */

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


/* =========================================================
   DATABASE HELPERS
========================================================= */

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


/* =========================================================
   STORAGE HELPERS
========================================================= */

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


/* =========================================================
   STORAGE CLEANUP
========================================================= */

async function cleanupStorage(
  supabase,
  userId,
  profile,
  ownedCompanyIds
) {

  /* ---------------------------------------------------------
     CANDIDATE RESUMES
  --------------------------------------------------------- */

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


  /* ---------------------------------------------------------
     EMPLOYER VERIFICATION DOCUMENTS
  --------------------------------------------------------- */

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


  /* Older user-ID based folders */

  employerPaths.push(
    ...(
      await listAllFiles(
        employerBucket,
        userId
      )
    )
  );


  /* Company based folders */

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


/* =========================================================
   CANDIDATE CLEANUP
========================================================= */

async function cleanupCandidateData(
  supabase,
  userId
) {
  const candidateTables = [

    ['applications', 'candidate_id'],

    ['skipped_jobs', 'candidate_id'],

    /*
     * IMPORTANT:
     * AI match records
     */
    ['job_matches', 'candidate_id'],

    /*
     * IMPORTANT:
     * Candidate interview records
     */
    ['interviews', 'candidate_id'],

    ['saved_jobs', 'candidate_id'],

    ['liked_jobs', 'candidate_id'],

    ['job_likes', 'candidate_id'],

    ['swipes', 'candidate_id'],

    ['swipe_actions', 'candidate_id'],

    ['password_change_codes', 'user_id']
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


/* =========================================================
   DELETE RECORDS CONNECTED TO JOBS
========================================================= */

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
      'job_matches',
      'job_id',
      jobId
    );

    await safeDeleteBy(
      supabase,
      'interviews',
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


/* =========================================================
   EMPLOYER JOB CLEANUP
========================================================= */

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

  /*
   * Delete everything underneath jobs first.
   */

  await deleteJobDependents(
    supabase,
    [...jobIds]
  );


  /*
   * Then delete the jobs themselves.
   */

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


/* =========================================================
   COMPANY CLEANUP
========================================================= */

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


  /* ---------------------------------------------------------
     REMOVE REVIEWER REFERENCES
  --------------------------------------------------------- */

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


  /* ---------------------------------------------------------
     ACTIVITY LOGS
  --------------------------------------------------------- */

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


  /* ---------------------------------------------------------
     COMPANY MEMBERSHIP
  --------------------------------------------------------- */

  await safeDeleteBy(
    supabase,
    'company_members',
    'user_id',
    userId
  );


  /* ---------------------------------------------------------
     OWNED COMPANIES
  --------------------------------------------------------- */

  for (
    const companyId
    of ownedCompanyIds
  ) {

    /*
     * Find company jobs.
     */

    const companyJobs =
      await safeSelectIds(
        supabase,
        'jobs',
        'id',
        'company_id',
        companyId
      );


    /*
     * Delete job child records.
     */

    await deleteJobDependents(
      supabase,
      companyJobs
        .map(row => row?.id)
        .filter(Boolean)
    );


    /*
     * Delete company jobs.
     */

    await safeDeleteBy(
      supabase,
      'jobs',
      'company_id',
      companyId
    );


    /*
     * Verification documents
     */

    await safeDeleteBy(
      supabase,
      'employer_verification_documents',
      'company_id',
      companyId
    );


    /*
     * Employer verification
     */

    await safeDeleteBy(
      supabase,
      'employer_verifications',
      'company_id',
      companyId
    );


    /*
     * Company activity
     */

    await safeDeleteBy(
      supabase,
      'company_activity_log',
      'company_id',
      companyId
    );


    /*
     * Company AI / blueprint
     */

    await safeDeleteBy(
      supabase,
      'company_blueprints',
      'company_id',
      companyId
    );


    /*
     * Members
     */

    await safeDeleteBy(
      supabase,
      'company_members',
      'company_id',
      companyId
    );


    /*
     * Company itself
     */

    await safeDeleteBy(
      supabase,
      'companies',
      'id',
      companyId
    );
  }

  return ownedCompanyIds;
}


/* =========================================================
   MAIN API HANDLER
========================================================= */

module.exports =
async function handler(
  req,
  res
) {

  res.setHeader(
    'Cache-Control',
    'no-store'
  );


  /* ---------------------------------------------------------
     OPTIONS
  --------------------------------------------------------- */

  if (req.method === 'OPTIONS') {

    res.setHeader(
      'Allow',
      'POST, OPTIONS'
    );

    return res
      .status(204)
      .end();
  }


  /* ---------------------------------------------------------
     ONLY POST IS ALLOWED
  --------------------------------------------------------- */

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


  /* ---------------------------------------------------------
     CREATE SERVER SUPABASE CLIENT
  --------------------------------------------------------- */

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


  /* ---------------------------------------------------------
     GET USER TOKEN
  --------------------------------------------------------- */

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


  /* ---------------------------------------------------------
     VERIFY USER
  --------------------------------------------------------- */

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


  /* =========================================================
     BEGIN ACCOUNT DELETION
  ========================================================= */

  try {

    console.log(
      'Starting account deletion:',
      user.id
    );


    /* -------------------------------------------------------
       LOAD PROFILE
    ------------------------------------------------------- */

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


    /* -------------------------------------------------------
       FIND COMPANIES OWNED BY USER
    ------------------------------------------------------- */

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


    /* -------------------------------------------------------
       1. STORAGE
    ------------------------------------------------------- */

    console.log(
      'Cleaning storage...'
    );

    await cleanupStorage(
      supabase,
      user.id,
      profile || null,
      ownedCompanyIds
    );


    /* -------------------------------------------------------
       2. CANDIDATE DATA
    ------------------------------------------------------- */

    console.log(
      'Cleaning candidate data...'
    );

    await cleanupCandidateData(
      supabase,
      user.id
    );


    /* -------------------------------------------------------
       3. EMPLOYER JOB DATA
    ------------------------------------------------------- */

    console.log(
      'Cleaning employer jobs...'
    );

    await cleanupJobsOwnedByUser(
      supabase,
      user.id
    );


    /* -------------------------------------------------------
       4. COMPANY DATA
    ------------------------------------------------------- */

    console.log(
      'Cleaning company data...'
    );

    await cleanupCompanyData(
      supabase,
      user.id
    );


    /* -------------------------------------------------------
       5. OTHER VERIFICATION DATA
    ------------------------------------------------------- */

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


    /* -------------------------------------------------------
       6. PROFILE
    ------------------------------------------------------- */

    console.log(
      'Deleting profile...'
    );

    await safeDeleteBy(
      supabase,
      'profiles',
      'id',
      user.id
    );


    /* -------------------------------------------------------
       7. DELETE SUPABASE AUTH USER
    ------------------------------------------------------- */

    console.log(
      'Deleting Supabase Auth user...'
    );

    const {
      error: deleteUserError
    } =
      await supabase.auth.admin
        .deleteUser(
          user.id,
          false
        );


    /* -------------------------------------------------------
       AUTH DELETE FAILED
    ------------------------------------------------------- */

    if (deleteUserError) {

      console.error(
        'Supabase Auth deletion failed:',
        deleteUserError
      );

      console.error(
        'Supabase Auth deletion message:',
        deleteUserError.message
      );

      console.error(
        'Supabase Auth deletion status:',
        deleteUserError.status
      );

      console.error(
        'Supabase Auth deletion code:',
        deleteUserError.code
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


    /* -------------------------------------------------------
       SUCCESS
    ------------------------------------------------------- */

    console.log(
      'Account permanently deleted:',
      user.id
    );

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

    console.error(
      'Delete account error message:',
      error?.message
    );

    console.error(
      'Delete account error code:',
      error?.code
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
