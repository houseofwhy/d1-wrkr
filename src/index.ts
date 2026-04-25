const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { ...CORS, 'Content-Type': 'application/json' },
	});
}

function err(msg, status) {
	return json({ error: msg }, status);
}

async function sha256(text) {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function authed(req, db) {
	const h = req.headers.get('Authorization');
	if (!h?.startsWith('Bearer ')) return false;
	const hash = await sha256(h.slice(7).trim());
	const row = await db.prepare('SELECT id FROM editor_keys WHERE key_hash = ?').bind(hash).first();
	return row !== null;
}

function parseLevel(row) {
	return {
		...row,
		isVerified: row.isVerified === 1,
		isMain: row.isMain === 1,
		isFuture: row.isFuture === 1,
		creators: row.creators ? JSON.parse(row.creators) : null,
		tags: row.tags ? JSON.parse(row.tags) : [],
		records: row.records ? JSON.parse(row.records) : [],
		run: row.run ? JSON.parse(row.run) : null,
	};
}

export default {
	async fetch(req, env) {
		const { pathname } = new URL(req.url);

		if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

		// ── PUBLIC READ ──

		if (pathname === '/api/list' && req.method === 'GET') {
			const { results } = await env.DB.prepare('SELECT * FROM levels ORDER BY sort_order ASC').all();
			return json(results.map(parseLevel));
		}

		if (pathname === '/api/pending' && req.method === 'GET') {
			const { results } = await env.DB.prepare('SELECT * FROM pending ORDER BY sort_order ASC').all();
			return json(results);
		}

		if (pathname === '/api/editors' && req.method === 'GET') {
			const { results } = await env.DB.prepare('SELECT * FROM editors ORDER BY sort_order ASC').all();
			return json(results);
		}

		if (pathname === '/api/recent-changes' && req.method === 'GET') {
			const row = await env.DB.prepare("SELECT value FROM config WHERE key = 'recent_changes'").first();
			return json(row ? JSON.parse(row.value) : []);
		}

		if (pathname === '/api/level-month' && req.method === 'GET') {
			const row = await env.DB.prepare("SELECT value FROM config WHERE key = 'level_month'").first();
			if (!row) return err('Not found', 404);
			return json(JSON.parse(row.value));
		}

		if (pathname === '/api/level-verif' && req.method === 'GET') {
			const row = await env.DB.prepare("SELECT value FROM config WHERE key = 'level_verif'").first();
			if (!row) return err('Not found', 404);
			return json(JSON.parse(row.value));
		}

		// ── AUTH ──

		if (pathname === '/api/auth/validate' && req.method === 'GET') {
			if (!await authed(req, env.DB)) return err('Unauthorized', 401);
			return json({ ok: true });
		}

		// ── WRITE (require auth) ──

		if (method === 'POST' && path === '/api/levels/move') {
			if (!await authed(req, env.DB)) return err('Unauthorized', 401);
			const { path: lPath, newPosition } = await req.json().catch(() => ({}));
			if (!lPath || !newPosition) return err('Missing fields', 400);
			const current = await env.DB.prepare('SELECT sort_order FROM levels WHERE path = ?').bind(lPath).first();
			if (!current) return err('Level not found', 404);

			await env.DB.prepare('UPDATE levels SET sort_order = sort_order - 1 WHERE sort_order > ?').bind(current.sort_order).run();

			const { results: allOrders } = await env.DB.prepare('SELECT sort_order FROM levels ORDER BY sort_order').all();
			const targetSortOrder = newPosition <= allOrders.length
				? allOrders[newPosition - 1].sort_order
				: (allOrders.length > 0 ? allOrders[allOrders.length - 1].sort_order + 1 : 0);

			await env.DB.prepare('UPDATE levels SET sort_order = sort_order + 1 WHERE sort_order >= ?').bind(targetSortOrder).run();
			await env.DB.prepare('UPDATE levels SET sort_order = ? WHERE path = ?').bind(targetSortOrder, lPath).run();

			return json({ ok: true });
		}

		if (method === 'PUT' && path === '/api/levels') {
			if (!await authed(req, env.DB)) return err('Unauthorized', 401);
			const body = await req.json().catch(() => null);
			if (!body) return err('Invalid JSON', 400);
			const { insertAt, ...level } = body;
			if (!insertAt || insertAt < 1) return err('insertAt must be >= 1', 400);
			if (!level.path || !level.name) return err('Missing required fields', 400);

			const existing = await env.DB.prepare('SELECT sort_order FROM levels WHERE path = ?').bind(level.path).first();
			if (existing !== null) {
				await env.DB.prepare('UPDATE levels SET sort_order = sort_order - 1 WHERE sort_order > ?').bind(existing.sort_order).run();
			}

			const { results: allOrders } = await env.DB.prepare('SELECT sort_order FROM levels ORDER BY sort_order').all();
			const targetSortOrder = insertAt <= allOrders.length
				? allOrders[insertAt - 1].sort_order
				: (allOrders.length > 0 ? allOrders[allOrders.length - 1].sort_order + 1 : 0);

			await env.DB.prepare('UPDATE levels SET sort_order = sort_order + 1 WHERE sort_order >= ?').bind(targetSortOrder).run();

			await env.DB.prepare(`
				INSERT OR REPLACE INTO levels (path, name, author, creators, verifier,
					isVerified, verification, showcase, thumbnail, lastUpd,
					percentToQualify, records, run, length, rating,
					percentFinished, isMain, isFuture, tags, id, sort_order)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).bind(
				level.path,
				level.name,
				level.author ?? '',
				JSON.stringify(level.creators ?? []),
				level.verifier ?? '',
				level.isVerified ? 1 : 0,
				level.verification ?? '',
				level.showcase ?? '',
				level.thumbnail ?? null,
				level.lastUpd ?? '',
				level.percentToQualify ?? 1,
				JSON.stringify(level.records ?? []),
				JSON.stringify(level.run ?? []),
				level.length ?? 0,
				level.rating ?? 1,
				level.percentFinished ?? 100,
				level.isMain ? 1 : 0,
				level.isFuture ? 1 : 0,
				JSON.stringify(level.tags ?? []),
				level.id ?? 'private',
				targetSortOrder
			).run();

			return json({ ok: true });
		}

		if (method === 'POST' && path === '/api/levels/move') {
			if (!await authed(req, env.DB)) return err('Unauthorized', 401);
			const { path: lPath, newPosition } = await req.json().catch(() => ({}));
			if (!lPath || !newPosition) return err('Missing fields', 400);
			const current = await env.DB.prepare('SELECT sort_order FROM levels WHERE path = ?').bind(lPath).first();
			if (!current) return err('Level not found', 404);

			// Remove from current position, closing the gap
			await env.DB.prepare('UPDATE levels SET sort_order = sort_order - 1 WHERE sort_order > ?').bind(current.sort_order).run();

			// Look up the actual sort_order at the target rank (in the list after removal)
			const { results: allOrders } = await env.DB.prepare('SELECT sort_order FROM levels ORDER BY sort_order').all();
			const targetSortOrder = newPosition <= allOrders.length
				? allOrders[newPosition - 1].sort_order
				: (allOrders.length > 0 ? allOrders[allOrders.length - 1].sort_order + 1 : 0);

			// Shift levels at >= targetSortOrder up to make room
			await env.DB.prepare('UPDATE levels SET sort_order = sort_order + 1 WHERE sort_order >= ?').bind(targetSortOrder).run();
			await env.DB.prepare('UPDATE levels SET sort_order = ? WHERE path = ?').bind(targetSortOrder, lPath).run();

			return json({ ok: true });
		}

		if (pathname.startsWith('/api/levels/') && req.method === 'DELETE') {
			if (!await authed(req, env.DB)) return err('Unauthorized', 401);
			const path = decodeURIComponent(pathname.slice('/api/levels/'.length));
			const level = await env.DB.prepare('SELECT sort_order FROM levels WHERE path = ?').bind(path).first();
			if (!level) return err('Level not found', 404);
			await env.DB.batch([
				env.DB.prepare('DELETE FROM levels WHERE path = ?').bind(path),
				env.DB.prepare('UPDATE levels SET sort_order = sort_order - 1 WHERE sort_order > ?').bind(level.sort_order),
			]);
			return json({ ok: true });
		}

		if (pathname === '/api/pending' && req.method === 'PUT') {
			if (!await authed(req, env.DB)) return err('Unauthorized', 401);
			const body = await req.json();
			await env.DB.prepare('INSERT INTO pending (name,placement,link,sort_order) VALUES (?,?,?,?)').bind(body.name, body.placement, body.link ?? null, body.sort_order ?? 0).run();
			return json({ ok: true });
		}

		if (pathname.startsWith('/api/pending/') && req.method === 'DELETE') {
			if (!await authed(req, env.DB)) return err('Unauthorized', 401);
			const id = pathname.slice('/api/pending/'.length);
			await env.DB.prepare('DELETE FROM pending WHERE id = ?').bind(id).run();
			return json({ ok: true });
		}

		if (pathname === '/api/config' && req.method === 'PUT') {
			if (!await authed(req, env.DB)) return err('Unauthorized', 401);
			const body = await req.json();
			await env.DB.prepare('INSERT INTO config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(body.key, JSON.stringify(body.value)).run();
			return json({ ok: true });
		}

		if (pathname === '/api/admin/bootstrap' && req.method === 'POST') {
			const count = await env.DB.prepare('SELECT COUNT(*) as c FROM editor_keys').first();
			if (count && count.c > 0) return err('Already bootstrapped', 403);
			const body = await req.json();
			const hash = await sha256(body.key);
			await env.DB.prepare('INSERT INTO editor_keys (editor_name, key_hash) VALUES (?,?)').bind(body.editor_name, hash).run();
			return json({ ok: true });
		}

		if (pathname === '/api/admin/add-key' && req.method === 'POST') {
			if (!await authed(req, env.DB)) return err('Unauthorized', 401);
			const body = await req.json();
			const hash = await sha256(body.key);
			await env.DB.prepare('INSERT INTO editor_keys (editor_name, key_hash) VALUES (?,?)').bind(body.editor_name, hash).run();
			return json({ ok: true });
		}

		return err('Not found', 404);
	},
};