// /api/send-password-code.js
//
// Sends a 6-digit verification code by email. The code itself is
// generated and stored by the client (account-settings.html), this
// route's only job is delivering it via Resend.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }

  const { email, code } = req.body || {};

  if (!email || !code) {
    return res.status(400).json({
      success: false,
      error: 'Missing email or code'
    });
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },

      body: JSON.stringify({
        from: 'Alygnn <noreply@alygnn.com>',
        reply_to: 'noreply@alygnn.com',
        to: email,
        subject: 'Your Alygnn verification code',

        html: `
          <div style="
            margin:0;
            padding:32px 20px;
            background:#F6F8F7;
            font-family:Arial,sans-serif;
            color:#1A2530;
          ">

            <div style="
              max-width:520px;
              margin:0 auto;
              background:#ffffff;
              border:1px solid #DDE3E8;
              border-radius:18px;
              padding:32px;
            ">

              <p style="
                margin:0 0 22px;
                font-size:15px;
                line-height:1.6;
                color:#1A2530;
              ">
                Use this code to confirm your password change:
              </p>

              <div style="
                font-size:32px;
                font-weight:700;
                letter-spacing:8px;
                color:#1A2530;
                margin:0 0 24px;
              ">
                ${code}
              </div>

              <p style="
                margin:0;
                font-size:14px;
                line-height:1.6;
                color:#4A5968;
              ">
                This code expires in 10 minutes. If you didn't request
                this, you can safely ignore this email.
              </p>

              <div style="
                border-top:1px solid #DDE3E8;
                margin-top:28px;
                padding-top:18px;
              ">

                <p style="
                  margin:0 0 10px;
                  font-size:12px;
                  line-height:1.6;
                  color:#9BA8B3;
                ">
                  This is an automated security email from the Alygnn team.
                  Replies to this message are not monitored.
                </p>

                <p style="
                  margin:0;
                  font-size:12px;
                  line-height:1.7;
                  color:#9BA8B3;
                ">
                  © 2026 Alygnn. All Rights Reserved.
                  <br>

                  <a
                    href="https://alygnn.com/terms.html"
                    style="color:#5D7FA3;text-decoration:none;"
                  >
                    Terms of Service
                  </a>

                  &nbsp;|&nbsp;

                  <a
                    href="https://alygnn.com/privacy.html"
                    style="color:#5D7FA3;text-decoration:none;"
                  >
                    Privacy Policy
                  </a>

                  &nbsp;|&nbsp;

                  <a
                    href="mailto:contact@alygnn.com"
                    style="color:#5D7FA3;text-decoration:none;"
                  >
                    Contact Us
                  </a>
                </p>

              </div>

            </div>
          </div>
        `,
      }),
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
    console.error('Send password code error:', err);

    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}
