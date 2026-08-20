// /api/notify-password-change.js
//
// Sends the confirmation email after a user's password
// has successfully been changed.

const ALLOWED_ORIGINS = new Set([
  'https://localhost',
  'http://localhost',
  'capacitor://localhost',
  'https://alygnn.com',
  'https://www.alygnn.com'
]);

function applyCors(req, res) {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader(
    'Access-Control-Allow-Methods',
    'POST, OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  );
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }

  const { email } = req.body || {};

  if (!email) {
    return res.status(400).json({
      success: false,
      error: 'Missing email'
    });
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',

      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },

      body: JSON.stringify({
        from: 'Alygnn <admin@alygnn.com>',
        reply_to: 'noreply@alygnn.com',
        to: email,
        subject: 'Your Alygnn password was changed',

        html: `
          <div style="
            margin: 0;
            padding: 32px 20px;
            background: #F6F8F7;
            font-family: Arial, sans-serif;
            color: #1A2530;
          ">

            <div style="
              max-width: 520px;
              margin: 0 auto;
              background: #ffffff;
              border: 1px solid #DDE3E8;
              border-radius: 18px;
              padding: 32px;
            ">

              <h2 style="
                margin: 0 0 16px;
                font-size: 24px;
                line-height: 1.3;
                color: #1A2530;
              ">
                Your password was changed
              </h2>

              <p style="
                margin: 0 0 16px;
                font-size: 14px;
                line-height: 1.6;
                color: #4A5968;
              ">
                Your password was just changed on your Alygnn account
                (${email}).
              </p>

              <p style="
                margin: 0 0 16px;
                font-size: 14px;
                line-height: 1.6;
                color: #4A5968;
              ">
                If this was you, no action is needed.
              </p>

              <p style="
                margin: 0;
                font-size: 14px;
                line-height: 1.6;
                color: #4A5968;
              ">
                If you didn't make this change, reset your password immediately
                and contact the Alygnn team at

                <a
                  href="mailto:contact@alygnn.com"
                  style="color: #5D7FA3;"
                >
                  contact@alygnn.com
                </a>.
              </p>

              <div style="
                border-top: 1px solid #DDE3E8;
                margin-top: 28px;
                padding-top: 18px;
              ">

                <p style="
                  margin: 0 0 10px;
                  font-size: 12px;
                  line-height: 1.6;
                  color: #9BA8B3;
                ">
                  This is an automated security email from the Alygnn team.
                  Replies to this message are not monitored.
                </p>

                <p style="
                  margin: 0;
                  font-size: 12px;
                  line-height: 1.7;
                  color: #9BA8B3;
                ">
                  © 2026 Alygnn. All Rights Reserved.
                  <br>

                  <a
                    href="https://alygnn.com/terms.html"
                    style="color: #5D7FA3; text-decoration: none;"
                  >
                    Terms of Service
                  </a>

                  &nbsp;|&nbsp;

                  <a
                    href="https://alygnn.com/privacy.html"
                    style="color: #5D7FA3; text-decoration: none;"
                  >
                    Privacy Policy
                  </a>

                  &nbsp;|&nbsp;

                  <a
                    href="mailto:contact@alygnn.com"
                    style="color: #5D7FA3; text-decoration: none;"
                  >
                    Contact Us
                  </a>
                </p>

              </div>

            </div>

          </div>
        `
      })
    });

    if (!response.ok) {
      const errText = await response.text();

      console.error('Resend error:', errText);

      return res.status(500).json({
        success: false,
        error: 'Failed to send email'
      });
    }

    return res.status(200).json({
      success: true
    });

  } catch (err) {
    console.error('Password change notification error:', err);

    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}
