const USERNAME = /^[a-z0-9_]{3,24}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SESSION_TOKEN = /^[a-f0-9]{64}$/;
const MINUTE = 60_000;
const SESSION_AGE = 30 * 24 * 60 * MINUTE;
const BODY_LIMIT = 8192;
const PAGE_SIZE = 40;
const encoder = new TextEncoder();

class ApiError extends Error {
  constructor(status, message, headers) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function asHex(bytes) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(value) {
  return Uint8Array.from(value.match(/../g), (byte) => parseInt(byte, 16));
}

function randomHex(length) {
  return asHex(crypto.getRandomValues(new Uint8Array(length)));
}

async function hash(value) {
  return asHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-512',
    salt: fromHex(salt),
    // Worker's Web Crypto API caps PBKDF2 at 100,000 iterations.
    iterations: 100_000,
  }, key, 256);
  return asHex(bits);
}

function hashesMatch(first, second) {
  let difference = 0;
  for (let index = 0; index < first.length; index += 1) {
    difference |= first.charCodeAt(index) ^ second.charCodeAt(index);
  }
  return difference === 0;
}

function enforceOrigin(request, url) {
  const origin = request.headers.get('Origin');
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if ((origin !== null && origin !== url.origin) || fetchSite === 'cross-site') {
    throw new ApiError(403, 'هذا الطلب غير مسموح به.');
  }
}

async function readJson(request) {
  const contentType = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json' || !request.body) {
    throw new ApiError(415, 'تعذّر قراءة نوع البيانات المرسلة.');
  }
  if (Number(request.headers.get('Content-Length')) > BODY_LIMIT) {
    throw new ApiError(413, 'البيانات المرسلة أكبر من الحد المسموح.');
  }

  const reader = request.body.getReader();
  const buffer = new Uint8Array(BODY_LIMIT);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.length > BODY_LIMIT) {
        await reader.cancel();
        throw new ApiError(413, 'البيانات المرسلة أكبر من الحد المسموح.');
      }
      buffer.set(value, length);
      length += value.length;
    }
  } finally {
    reader.releaseLock();
  }

  try {
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {
    // Syntax and encoding failures use the same localized response.
  }
  throw new ApiError(400, 'البيانات المرسلة غير صالحة.');
}

function usernameValue(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function textValue(value, min, max, error) {
  if (typeof value !== 'string' || value.includes('\0')) throw new ApiError(400, error);
  const clean = value.trim();
  const length = Array.from(clean).length;
  if (length < min || length > max) throw new ApiError(400, error);
  return clean;
}

function validPassword(password) {
  if (typeof password !== 'string') return false;
  const length = Array.from(password).length;
  return length >= 10 && length <= 128;
}

function displayName(value) {
  return textValue(value, 1, 50, 'اكتب اسمًا للعرض لا يتجاوز ٥٠ حرفًا.');
}

function profile(row) {
  return {
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    accepting: row.accepting === 1,
  };
}

function cookieName(url) {
  return url.protocol === 'https:' ? '__Host-hamsa_session' : 'hamsa_session';
}

function sessionCookie(url, token, age = SESSION_AGE) {
  const security = url.protocol === 'https:' ? '; Secure' : '';
  return `${cookieName(url)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(age / 1000)}${security}`;
}

async function sessionTokenHash(request, url) {
  const prefix = `${cookieName(url)}=`;
  const cookie = request.headers.get('Cookie')?.split(';').map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix));
  const token = cookie?.slice(prefix.length);
  return token && SESSION_TOKEN.test(token) ? hash(token) : null;
}

async function signedInUser(request, url, db) {
  const tokenHash = await sessionTokenHash(request, url);
  if (!tokenHash) return null;
  return db.prepare(`
    SELECT u.id, u.username, u.display_name, u.bio, u.accepting
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).bind(tokenHash, Date.now()).first();
}

async function requireUser(request, url, db) {
  const user = await signedInUser(request, url, db);
  if (!user) throw new ApiError(401, 'سجّل الدخول للمتابعة.');
  return user;
}

async function newSession(now) {
  const token = randomHex(32);
  const tokenHash = await hash(token);
  return { token, tokenHash, expiresAt: now + SESSION_AGE };
}

async function rateSecret(db) {
  const name = 'rate_limit_secret';
  let row = await db.prepare('SELECT value FROM app_settings WHERE name = ?').bind(name).first();
  if (!row) {
    const secret = randomHex(32);
    await db.prepare('INSERT INTO app_settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO NOTHING')
      .bind(name, secret).run();
    row = await db.prepare('SELECT value FROM app_settings WHERE name = ?').bind(name).first();
  }
  return row.value;
}

async function limitRequests(request, db, rules) {
  // Cloudflare sets this header at the edge. The local adapter may pass the socket address.
  const client = request.headers.get('CF-Connecting-IP')?.slice(0, 64) || 'local';
  const secret = await rateSecret(db);
  const now = Date.now();
  const statements = await Promise.all(rules.map(async ({ scope, duration, limit }) => {
    const bucket = await hash(`${secret}\n${scope}\n${client}`);
    return db.prepare(`
      INSERT INTO rate_limits (bucket, expires_at, attempts) VALUES (?, ?, 1)
      ON CONFLICT(bucket) DO UPDATE SET
        expires_at = CASE WHEN rate_limits.expires_at <= ? THEN excluded.expires_at ELSE rate_limits.expires_at END,
        attempts = CASE WHEN rate_limits.expires_at <= ? THEN 1 ELSE rate_limits.attempts + 1 END
      WHERE rate_limits.expires_at <= ? OR rate_limits.attempts < ?
    `).bind(bucket, now + duration, now, now, now, limit);
  }));
  // Remove a bounded batch of expired records without a separate cleanup job.
  statements.push(db.prepare(`
    DELETE FROM rate_limits WHERE bucket IN (
      SELECT bucket FROM rate_limits WHERE expires_at <= ? LIMIT 32
    )
  `).bind(now));
  const results = await db.batch(statements);
  const denied = rules.find((_, index) => results[index].meta.changes === 0);
  if (denied) {
    throw new ApiError(429, 'تكرّرت المحاولة كثيرًا. جرّب بعد قليل.', {
      'Retry-After': String(Math.ceil(denied.duration / 1000)),
    });
  }
}

async function register(request, url, db) {
  const data = await readJson(request);
  const username = usernameValue(data.username);
  if (!USERNAME.test(username)) {
    throw new ApiError(400, 'استخدم من ٣ إلى ٢٤ حرفًا إنجليزيًا أو رقمًا أو شرطة سفلية لاسم المستخدم.');
  }
  if (!validPassword(data.password)) {
    throw new ApiError(400, 'اختر كلمة مرور من ١٠ إلى ١٢٨ حرفًا.');
  }

  const name = displayName(data.displayName);
  await limitRequests(request, db, [{ scope: 'register', duration: 60 * MINUTE, limit: 8 }]);
  const user = { id: crypto.randomUUID(), username, display_name: name, bio: '', accepting: 1 };
  const salt = randomHex(16);
  const now = Date.now();
  const [digest, session] = await Promise.all([
    passwordHash(data.password, salt),
    newSession(now),
  ]);
  const [insertUser] = await db.batch([
    db.prepare(`
      INSERT INTO users (id, username, display_name, password_salt, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(username) DO NOTHING
    `).bind(user.id, user.username, user.display_name, salt, digest, now),
    db.prepare(`
      INSERT INTO sessions (token_hash, user_id, expires_at)
      SELECT ?, id, ? FROM users WHERE id = ?
    `).bind(session.tokenHash, session.expiresAt, user.id),
  ]);
  if (insertUser.meta.changes === 0) throw new ApiError(409, 'اسم المستخدم مستخدم بالفعل.');
  return json({ user: profile(user) }, 201, { 'Set-Cookie': sessionCookie(url, session.token) });
}

async function login(request, url, db) {
  const data = await readJson(request);
  const username = usernameValue(data.username);
  if (!USERNAME.test(username) || !validPassword(data.password)) {
    throw new ApiError(401, 'اسم المستخدم أو كلمة المرور غير صحيحة.');
  }
  await limitRequests(request, db, [
    { scope: 'login', duration: 15 * MINUTE, limit: 20 },
    { scope: `login:${username}`, duration: 15 * MINUTE, limit: 8 },
  ]);
  const user = await db.prepare(`
    SELECT id, username, display_name, bio, accepting, password_salt, password_hash
    FROM users WHERE username = ?
  `).bind(username).first();
  const digest = await passwordHash(data.password, user?.password_salt ?? '00000000000000000000000000000000');
  if (!user || !hashesMatch(digest, user.password_hash)) {
    throw new ApiError(401, 'اسم المستخدم أو كلمة المرور غير صحيحة.');
  }

  const now = Date.now();
  const [session, previous] = await Promise.all([
    newSession(now),
    sessionTokenHash(request, url),
  ]);
  await db.batch([
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(session.tokenHash, user.id, session.expiresAt),
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(previous),
    db.prepare(`
      DELETE FROM sessions WHERE token_hash IN (
        SELECT token_hash FROM sessions WHERE expires_at <= ? LIMIT 32
      )
    `).bind(now),
  ]);
  return json({ user: profile(user) }, 200, { 'Set-Cookie': sessionCookie(url, session.token) });
}

async function logout(request, url, db) {
  const tokenHash = await sessionTokenHash(request, url);
  if (tokenHash) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(url, '', 0) });
}

async function profileByUsername(db, value) {
  const username = usernameValue(value);
  if (!USERNAME.test(username)) throw new ApiError(404, 'لم نعثر على هذا الحساب.');
  const user = await db.prepare('SELECT id, username, display_name, bio, accepting FROM users WHERE username = ?')
    .bind(username).first();
  if (!user) throw new ApiError(404, 'لم نعثر على هذا الحساب.');
  return user;
}

function pageCursor(url) {
  const value = url.searchParams.get('cursor');
  if (value === null) return [Number.MAX_SAFE_INTEGER, ''];
  const [time, id, extra] = value.split(':');
  const timestamp = Number(time);
  if (extra !== undefined || !/^\d{1,15}$/.test(time) || !UUID.test(id) || !Number.isSafeInteger(timestamp)) {
    throw new ApiError(400, 'تعذّر فتح هذه الصفحة.');
  }
  return [timestamp, id];
}

function messageSummary(row) {
  return { id: row.id, body: row.body, answer: row.answer, answeredAt: new Date(row.answered_at).toISOString() };
}

function nextPage(rows, timeColumn) {
  if (rows.length <= PAGE_SIZE) return null;
  const last = rows[PAGE_SIZE - 1];
  return `${last[timeColumn]}:${last.id}`;
}

async function publicProfile(url, db, username) {
  const user = await profileByUsername(db, username);
  const [time, id] = pageCursor(url);
  const { results } = await db.prepare(`
    SELECT id, body, answer, answered_at FROM messages
    WHERE recipient_id = ? AND answered_at IS NOT NULL AND (answered_at, id) < (?, ?)
    ORDER BY answered_at DESC, id DESC LIMIT ?
  `).bind(user.id, time, id, PAGE_SIZE + 1).all();
  return json({
    profile: profile(user),
    answers: results.slice(0, PAGE_SIZE).map(messageSummary),
    nextCursor: nextPage(results, 'answered_at'),
  });
}

async function sendMessage(request, db, username) {
  const data = await readJson(request);
  const body = textValue(data.body, 1, 500, 'اكتب رسالة من حرف واحد إلى ٥٠٠ حرف.');
  if (data.website) return json({ ok: true }, 201);
  const user = await profileByUsername(db, username);
  if (!user.accepting) throw new ApiError(403, 'هذا الحساب أوقف استقبال الرسائل مؤقتًا.');
  await limitRequests(request, db, [
    { scope: 'messages', duration: 10 * MINUTE, limit: 12 },
    { scope: `messages:${user.id}`, duration: 10 * MINUTE, limit: 6 },
  ]);
  const result = await db.prepare(`
    INSERT INTO messages (id, recipient_id, body, created_at)
    SELECT ?, id, ?, ? FROM users WHERE id = ? AND accepting = 1
  `).bind(crypto.randomUUID(), body, Date.now(), user.id).run();
  if (result.meta.changes === 0) throw new ApiError(403, 'هذا الحساب أوقف استقبال الرسائل مؤقتًا.');
  return json({ ok: true }, 201);
}

async function inbox(request, url, db) {
  const user = await requireUser(request, url, db);
  const [time, id] = pageCursor(url);
  const { results } = await db.prepare(`
    SELECT id, body, answer, created_at, answered_at FROM messages
    WHERE recipient_id = ? AND (created_at, id) < (?, ?)
    ORDER BY created_at DESC, id DESC LIMIT ?
  `).bind(user.id, time, id, PAGE_SIZE + 1).all();
  return json({
    messages: results.slice(0, PAGE_SIZE).map((row) => ({
      id: row.id,
      body: row.body,
      answer: row.answer,
      createdAt: new Date(row.created_at).toISOString(),
      answeredAt: row.answered_at === null ? null : new Date(row.answered_at).toISOString(),
    })),
    nextCursor: nextPage(results, 'created_at'),
  });
}

async function answerMessage(request, url, db, id) {
  const user = await requireUser(request, url, db);
  const data = await readJson(request);
  const answer = textValue(data.answer, 1, 500, 'اكتب ردًا من حرف واحد إلى ٥٠٠ حرف.');
  const result = await db.prepare(`
    UPDATE messages SET answer = ?, answered_at = COALESCE(answered_at, ?)
    WHERE id = ? AND recipient_id = ?
  `).bind(answer, Date.now(), id, user.id).run();
  if (result.meta.changes === 0) throw new ApiError(404, 'لم نعثر على هذه الرسالة.');
  return json({ ok: true });
}

async function deleteMessage(request, url, db, id) {
  const user = await requireUser(request, url, db);
  const result = await db.prepare('DELETE FROM messages WHERE id = ? AND recipient_id = ?')
    .bind(id, user.id).run();
  if (result.meta.changes === 0) throw new ApiError(404, 'لم نعثر على هذه الرسالة.');
  return json({ ok: true });
}

async function updateProfile(request, url, db) {
  const user = await requireUser(request, url, db);
  const data = await readJson(request);
  const name = displayName(data.displayName);
  const bio = textValue(data.bio, 0, 250, 'اكتب نبذة لا تتجاوز ٢٥٠ حرفًا.');
  if (typeof data.accepting !== 'boolean') throw new ApiError(400, 'اختر حالة استقبال الرسائل.');
  const accepting = data.accepting ? 1 : 0;
  await db.prepare('UPDATE users SET display_name = ?, bio = ?, accepting = ? WHERE id = ?')
    .bind(name, bio, accepting, user.id).run();
  return json({ user: profile({ ...user, display_name: name, bio, accepting }) });
}

async function route(request, url, db) {
  const path = url.pathname;
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD') enforceOrigin(request, url);
  if (method === 'POST' && path === '/api/register') return register(request, url, db);
  if (method === 'POST' && path === '/api/login') return login(request, url, db);
  if (method === 'POST' && path === '/api/logout') return logout(request, url, db);
  if (method === 'GET' && path === '/api/session') {
    const user = await signedInUser(request, url, db);
    return json({ user: user ? profile(user) : null });
  }
  if (method === 'PATCH' && path === '/api/profile') return updateProfile(request, url, db);
  if (method === 'GET' && path === '/api/inbox') return inbox(request, url, db);

  const profilePath = path.match(/^\/api\/profile\/([a-z0-9_]{3,24})(\/messages)?$/i);
  if (profilePath) {
    const [, username, messages] = profilePath;
    if (method === 'GET' && !messages) return publicProfile(url, db, username);
    if (method === 'POST' && messages) return sendMessage(request, db, username);
  }
  const inboxPath = path.match(/^\/api\/inbox\/([a-f0-9-]+)(\/answer)?$/);
  if (inboxPath && UUID.test(inboxPath[1])) {
    const [, id, answer] = inboxPath;
    if (method === 'POST' && answer) return answerMessage(request, url, db, id);
    if (method === 'DELETE' && !answer) return deleteMessage(request, url, db, id);
  }
  throw new ApiError(404, 'هذه الصفحة غير موجودة.');
}

export async function handleApi(request, env) {
  try {
    return await route(request, new URL(request.url), env.DB);
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status, error.headers);
    console.error('Hamsa API request failed:', error.name);
    return json({ error: 'حدث خطأ مؤقت. حاول مجددًا بعد قليل.' }, 500);
  }
}
