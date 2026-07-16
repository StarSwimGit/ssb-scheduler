// Business card OCR via Anthropic Claude. Used by the Admin & Procurement
// Directory module to auto-fill contact/company details from a photo.
//
// Deploy: place at /netlify/functions/scan.js in the scheduler repo. Requires
// ANT_KEY environment variable set in the scheduler's Netlify project
// (Site configuration → Environment variables). Same key you had on
// ssbsystem.netlify.app.
exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  const ANT_KEY = process.env.ANT_KEY;
  if (!ANT_KEY) {
    return json(500, { error: 'ANT_KEY environment variable is not set in Netlify.' });
  }
  let body;
  try { body = JSON.parse(event.body); }
  catch { return json(400, { error: 'Invalid request body' }); }
  // Accept both {image, mime} (merged app) and {imageBase64, mimeType} (legacy)
  const imageBase64 = body.image || body.imageBase64;
  const mimeType = body.mime || body.mimeType || 'image/jpeg';
  if (!imageBase64) {
    return json(400, { error: 'Missing image data' });
  }
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANT_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
            { type: 'text', text: `Extract all contact information from this business card image. Reply ONLY with a valid JSON object, no markdown, no explanation, no code fences. Use exactly these keys:
{
  "name": "full name of the person",
  "title": "job title or designation",
  "email": "personal/direct email",
  "phone": "personal/direct phone",
  "company_name": "company or organisation name",
  "company_email": "company general email",
  "company_phone": "company general phone",
  "address": "full address"
}
If a field is not present, use an empty string "". Extract everything you can see.` }
          ]
        }]
      })
    });
    const data = await response.json();
    if (!response.ok) {
      return json(response.status, { error: data.error?.message || 'Anthropic API error' });
    }
    // Parse the model's JSON output. Strip fences defensively even though we ask for none.
    const raw = (data.content?.[0]?.text || '').trim().replace(/^```(?:json)?/, '').replace(/```$/, '').trim();
    let parsed = {};
    try { parsed = JSON.parse(raw); }
    catch {
      // If model returned narration, return an error the caller can display.
      return json(502, { error: 'Could not parse scan result. Try a clearer image.' });
    }
    // Ensure all expected fields exist
    const fields = ['name','title','email','phone','company_name','company_email','company_phone','address'];
    fields.forEach(f => { if (typeof parsed[f] !== 'string') parsed[f] = ''; });
    return json(200, parsed);
  } catch (err) {
    return json(500, { error: err.message });
  }
};

function json(status, obj) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
