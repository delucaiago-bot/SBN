// Manda el aviso push de una versión publicada (lo ejecuta .github/workflows/aviso.yml).
// Sin dependencias: firma el JWT de la cuenta de servicio con el crypto de Node y llama a la API
// HTTP v1 de Firebase Cloud Messaging.
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const TOPIC = 'actualizaciones';
const ASSET = /^sbn-tecnicos-(.+)-(\d+)\.apk$/;

function release(tag) {
  // Al publicar, los APK pueden tardar unos segundos en aparecer: se reintenta.
  for (let i = 0; i < 10; i++) {
    const r = JSON.parse(execFileSync('gh', ['release', 'view', tag, '--repo', process.env.REPO, '--json', 'assets,body']).toString());
    const apk = r.assets.map(a => a.name.match(ASSET)).find(Boolean);
    if (apk) return { versionName: apk[1], versionCode: apk[2], notes: r.body || '' };
    execFileSync('sleep', ['6']);
  }
  throw new Error(`La release ${tag} no tiene un APK sbn-tecnicos-<versión>-<código>.apk`);
}

async function accessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error('No se ha podido obtener el token de Firebase: ' + JSON.stringify(json));
  return json.access_token;
}

async function main() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('Falta el secreto FIREBASE_SERVICE_ACCOUNT');
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const r = release(process.env.TAG);
  console.log(`Aviso de la versión ${r.versionName} (código ${r.versionCode})`);

  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + (await accessToken(sa)), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        topic: TOPIC,
        // Mensaje de datos: la app decide si avisa (solo si es más nueva que la instalada).
        data: { type: 'update', versionCode: r.versionCode, versionName: r.versionName, notes: r.notes.slice(0, 2000) },
        // Alta prioridad para que llegue aunque el móvil esté en reposo; se guarda hasta 4 semanas.
        android: { priority: 'HIGH', ttl: '2419200s' },
      },
    }),
  });
  const out = await res.text();
  if (!res.ok) throw new Error('Firebase ha rechazado el aviso: ' + out);
  console.log('Aviso enviado: ' + out);
}

main().catch(e => { console.error(e.message); process.exit(1); });
