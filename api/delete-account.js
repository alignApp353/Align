import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  'https://auth.alygnn.com';

const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }

  if (!SUPABASE_SECRET_KEY) {
    console.error('Missing Supabase server secret key.');

    return res.status(500).json({
      success: false,
      error: 'Server configuration error.'
    });
  }

  const authorization = req.headers.authorization || '';

  if (!authorization.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'Not authenticated.'
    });
  }

  const accessToken = authorization.slice(7).trim();

  if (!accessToken) {
    return res.status(401).json({
      success: false,
      error: 'Not authenticated.'
    });
  }

  const admin = createClient(
    SUPABASE_URL,
    SUPABASE_SECRET_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    }
  );

  try {
    /*
      IMPORTANT:
      Never trust a user ID sent from the browser.

      We verify the access token and get the user ID
      directly from Supabase.
    */
    const {
      data: { user },
      error: userError
    } = await admin.auth.getUser(accessToken);

    if (userError || !user) {
      console.error('Delete account auth error:', userError);

      return res.status(401).json({
        success: false,
        error: 'Your session is invalid or expired. Please sign in again.'
      });
    }

    /*
      Permanently delete the Supabase Auth user.

      false = HARD DELETE
      We do NOT want a soft-deleted login account.
    */
    const { error: deleteError } =
      await admin.auth.admin.deleteUser(
        user.id,
        false
      );

    if (deleteError) {
      console.error(
        'Supabase account deletion error:',
        deleteError
      );

      return res.status(500).json({
        success: false,
        error:
          deleteError.message ||
          'Unable to delete your account.'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Account permanently deleted.'
    });

  } catch (error) {
    console.error('Delete account error:', error);

    return res.status(500).json({
      success: false,
      error: 'Unable to delete your account.'
    });
  }
}
