export async function getGoogleAccessToken(env) {
  const cached = await env.MIXOLOGY.get('google_oauth_token', { type: 'json' });
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.access_token && cached.exp && cached.exp - 60 > now) {
    return cached.access_token;
  }

  const { client_email, private_key } = JSON.parse(env.GOOGLE_SA_JSON || '{}');
  if (!client_email || !private_key) throw new Error('Missing GOOGLE_SA_JSON (client_email/private_key)');

  const iat = now;
  const exp = iat + 3600;
  const scope = 'https://www.googleapis.com/auth/spreadsheets.readonly';
  const aud = 'https://oauth2.googleapis.com/token';

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iss: client_email, scope, aud, iat, exp };

  const jwt = await signJwtRS256(header, payload, private_key);

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt
  });

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!resp.ok) throw new Error(`oauth2 token ${resp.status}`);
  const data = await resp.json();

  await env.MIXOLOGY.put('google_oauth_token', JSON.stringify({
    access_token: data.access_token,
    exp: now + Math.max(0, Math.min(3600, (data.expires_in || 3600)))
  }), { expirationTtl: 3500 });

  return data.access_token;
}

async function signJwtRS256(header, payload, pemPrivateKey) {
  const enc = new TextEncoder();
  const input = `${b64urlFromString(JSON.stringify(header))}.${b64urlFromString(JSON.stringify(payload))}`;

  const key = await importPkcs8PrivateKey(pemPrivateKey);
  const sig = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    enc.encode(input)
  );
  return `${input}.${b64urlBytes(new Uint8Array(sig))}`;
}

async function importPkcs8PrivateKey(pem) {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/g, '')
                 .replace(/-----END PRIVATE KEY-----/g, '')
                 .replace(/\s+/g, '');
  const bin = b64ToArrayBuffer(b64);
  return crypto.subtle.importKey(
    'pkcs8',
    bin,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

function b64urlFromString(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64ToArrayBuffer(b64) {
  const binStr = atob(b64);
  const len = binStr.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binStr.charCodeAt(i);
  return bytes.buffer;
}
