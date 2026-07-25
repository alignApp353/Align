module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { resumeBase64, resumeType, resumeText } = req.body;

    // NOTE: the extracted "experience" and "education" fields below are
    // arrays of itemized entries (one per job / one per degree), not a
    // single number or string. This matches exactly what account.html's
    // Profile Details section reads from profiles.resume_data — so
    // whatever comes back here can be saved as-is and will populate the
    // Experience/Education lists on the account page automatically,
    // instead of only Skills showing up like before.
    const schemaInstructions =
      'You are a resume parser. Extract key information from this resume and return ONLY a valid JSON object with no extra text, no markdown, no code fences.\n\n' +
      'Return this exact JSON structure:\n' +
      '{"name":"full name","email":"email or empty","phone":"phone or empty","location":"city, state or empty","title":"most recent job title","summary":"2 sentence summary","skills":["skill1","skill2","skill3","skill4","skill5"],' +
      '"experience":[{"title":"job title","company":"company name","startYear":"2022","endYear":"2024 or Present"}],' +
      '"education":[{"degree":"degree name, e.g. B.A. Professional Studies","school":"school name","startYear":"2021 or empty","endYear":"2025 or Present or empty"}],' +
      '"languages":["English"],"job_types":["Full-time"],"industries":["Technology"]}\n\n' +
      'Rules:\n' +
      '- "experience" must contain ONE entry per job listed on the resume, in the order they appear. If the resume gives no dates for a job, use empty strings for startYear/endYear rather than guessing.\n' +
      '- "education" must contain ONE entry per degree/program listed. If a graduation date is "Expected" or in the future, put that year in endYear anyway — do not omit it.\n' +
      '- If there is no work experience or no education listed at all, return an empty array ([]) for that field — do not omit the key.\n' +
      '- Use "Present" (not "Current" or "Ongoing") for any job or program that is still in progress.\n' +
      '- Years must be 4-digit strings (e.g. "2022"), never full dates.';

    let messageContent;

    if (resumeBase64 && resumeType === 'application/pdf') {
      messageContent = [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: resumeBase64,
          },
        },
        {
          type: 'text',
          text: schemaInstructions,
        },
      ];
    } else {
      const text = resumeText || 'No resume content provided';
      messageContent = [
        {
          type: 'text',
          text: schemaInstructions + '\n\nResume:\n' + text,
        },
      ];
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-20240307',
        max_tokens: 1536,
        messages: [{ role: 'user', content: messageContent }],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Claude API error:', JSON.stringify(data));
      return res.status(500).json({ error: 'Claude API failed', details: data });
    }

    const text = data.content[0].text.trim();
    const clean = text.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(clean);

    // Defensive normalization: if the model ever slips and returns
    // experience_years (number) or education (string) — the old shape —
    // instead of the itemized arrays we asked for, don't let that reach
    // the client as broken data. Coerce to the new shape so downstream
    // code (align-upload.html, account.html) never has to guess which
    // format it got.
    if (!Array.isArray(parsed.experience)) {
      parsed.experience = [];
    }
    if (!Array.isArray(parsed.education)) {
      if (typeof parsed.education === 'string' && parsed.education.trim()) {
        parsed.education = [{ degree: parsed.education.trim(), school: '', startYear: '', endYear: '' }];
      } else {
        parsed.education = [];
      }
    }

    return res.status(200).json({ success: true, data: parsed });

  } catch (error) {
    console.error('Error:', error.message);
    return res.status(500).json({ error: 'Server error', details: error.message });
  }
};
