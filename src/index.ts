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
		const url = new URL(req.url);
		const path = url.pathname;
		const method = req.method;

		if (method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: CORS });
		}

		if (method === 'GET' && path === '/api/list') {
			const { results } = await env.DB.prepare(
				'SELECT * FROM levels ORDER BY sort_order'
			).all();
			return json(results.map(parseLevel));
		}

		if (method === 'GET' && path === '/api/list/main') {
			const { results } = await env.DB.prepare(
				'SELECT * FROM levels WHERE isMain = 1 ORDER BY sort_order'
			).all();
			return json(results.map(parseLevel));
		}

		if (method === 'GET' && path === '/api/list/future') {
			const { results } = await env.DB.prepare(
				'SELECT * FROM levels WHERE isFuture = 1 ORDER BY sort_order'
			).all();
			return json(results.map(parseLevel));
		}

		if (method === 'GET' && path === '/api/pending') {
			const { results } = await env.DB.prepare(
				'SELECT * FROM pending ORDER BY placement'
			).all();
			return json(results);
		}

		if (method === 'GET' && path === '/api/editors') {
			const { results } = await env.DB.prepare(
				'SELECT name FROM editor_keys'
			).all();
			return json(results.map(r => r.name));
		}

		if (method === 'GET' && path === '/api/recent-changes') {
			const row = await env.DB.prepare(
				"SELECT value FROM config WHERE key = 'recentChanges'"
			).first();
			return json(row ? JSON.parse(row.value) : []);
		}

		if (method === 'GET' && path === '/api/level-month') {
			const row = await env.DB.prepare(
				"SELECT value FROM config WHERE key = 'levelMonth'"
			).first();
			return json(row ? JSON.parse(row.value) : null);
		}

		if (method === 'GET' && path === '/api/level-verif') {
			const row = await env.DB.prepare(
				"SELECT value FROM config WHERE key = 'levelVerif'"
			).first();
			return json(row ? JSON.parse(row.value) : null);
		}

		if (method === 'GET' && path === '/api/auth/validate') {
			if (!await authed(req, env.DB)) return err('Unauthorized', 401);
			return json({ ok: true });
		}

		const posMatch = path.match(/^\/api\/levels\/(\d+)$/);
		if (method === 'GET' && posMatch) {
			const position = parseInt(posMatch[1], 10);
			if (position < 1) return err('Position must be >= 1', 400);
			const row = await env.DB.prepare(
				'SELECT * FROM levels ORDER BY sort_order LIMIT 1 OFFSET ?'
			).bind(position - 1).first();
			if (!row) return err('No level at that position', 404);
			return json(parseLevel(row));
		}

		if (method === 'PUT' && path === '/api/levels') {
			if (!await authed(req, env.DB)) return err('Unauthorized', 401);
			const body = await req.json().catch(() => null);
			if (!body) return err('Invalid JSON', 400);
			const { insertAt, ...level } = body;
			if (!insertAt || insertAt < 1) return err('insertAt must be >= 1', 400);
			if (!level.path || !level.name) return err('Missing required fields', 400);

			const existing = await env.DB.prepare(
				'SELECT sort_order FROM levels WHERE path = ?'
			).bind(level.path).first();
			if (existing !== null) {
				await env.DB.prepare(
					'UPDATE levels SET sort_order = sort_order - 1 WHERE sort_order > ?'
				).bind(existing.sort_order).run();
			}

			const { results: allOrders } = await env.DB.prepare(
				'SELECT sort_order FROM levels ORDER BY sort_order'
			).all();
			const targetSortOrder = insertAt <= allOrders.length
				? allOrders[insertAt - 1].sort_order
				: (allOrders.length > 0 ? allOrders[allOrders.length - 1].sort_order + 1 : 0);

			await env.DB.prepare(
				'UPDATE levels SET sort_order = sort_order + 1 WHERE sort_order >= ?'
			).bind(targetSortOrder).run();

			await env.DB.prepare(`
                INSERT OR REPLACE INTO levels
                    (path, name, author, creators, verifier, isVerified, verification, showcase,
                     thumbnail, lastUpd, percentToQualify, records, run, length, rating,
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
			const current = await env.DB.prepare(
				'SELECT sort_order FROM levels WHERE path = ?'
			).bind(lPath).first();
			if (!current) return err('Level not found', 404);

			await env.DB.prepare(
				'UPDATE levels SET sort_order = sort_order - 1 WHERE sort_order > ?'
			).bind(current.sort_order).run();

			const { results: allOrders } = await env.DB.prepare(
				'SELECT sort_order FROM levels ORDER BY sort_order'
			).all();
			const targetSortOrder = newPosition <= allOrders.length
				? allOrders[newPosition - 1].sort_order
				: (allOrders.length > 0 ? allOrders[allOrders.length - 1].sort_order + 1 : 0);

			await env.DB.prepare(
				'UPDATE levels SET sort_order = sort_order + 1 WHERE sort_order >= ?'
			).bind(targetSortOrder).run();
			await env.DB.prepare(
				'UPDATE levels SET sort_order = ? WHERE path = ?'
			).bind(targetSortOrder, lPath).run();

			return json({ ok: true });
		}

		const delLevelMatch = path.match(/^\/api\/levels\/(.+)$/);
		if (method === 'DELETE' && delLevelMatch) {
			if (!await authed(req, env.DB)) return err('Unauthorized', 401);
			const lPath = decodeURIComponent(delLevelMatch[1]);
			const lvl = await env.DB.prepare(
				'SELECT sort_order FROM levels WHERE path = ?'
			).bind(lPath).first();
			if (!lvl) return err('Level not found', 404);
			await env.DB.prepare('DELETE FROM levels WHERE path = ?').bind(lPath).run();
			await env.DB.prepare(
				'UPDATE levels SET sort_order = sort_order - 1 WHERE sort_order > ?'
			).bind(lvl.sort_order).run();
			return json({ ok: true });
		}

		if (method === 'PUT' && path === '/api/pending') {
			if (!await authed(req, env.DB)) return err('Unauthorized', 401);
			const body = await req.json().catch(() => null);
			if (!body || !body.name) return err('Missing fields', 400);
			await env.DB.prepare(
				'INSERT OR REPLACE INTO pending (name, placement, link) VALUES (?, ?, ?)'
			).bind(body.name, body.placement ?? '', body.link ?? '').run();
			return json({ ok: true });
		}

		const delPendingMatch = path.match(/^\/api\/pending\/(.+)$/);
		if (method === 'DELETE' && delPendingMatch) {
			if (!await authed(req, env.DB)) return err('Unauthorized', 401);
			const id = decodeURIComponent(delPendingMatch[1]);
			await env.DB.prepare('DELETE FROM pending WHERE name = ?').bind(id).run();
			return json({ ok: true });
		}

		if (method === 'PUT' && path === '/api/config') {
			if (!await authed(req, env.DB)) return err('Unauthorized', 401);
			const body = await req.json().catch(() => null);
			if (!body || !body.key) return err('Missing key', 400);
			await env.DB.prepare(
				'INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)'
			).bind(body.key, JSON.stringify(body.value)).run();
			return json({ ok: true });
		}

		if (method === 'POST' && path === '/api/admin/bootstrap') {
			const existing = await env.DB.prepare(
				'SELECT COUNT(*) as c FROM editor_keys'
			).first();
			if (existing.c > 0) return err('Already bootstrapped', 403);
			const body = await req.json().catch(() => null);
			if (!body?.key || !body?.name) return err('Missing fields', 400);
			const hash = await sha256(body.key);
			await env.DB.prepare(
				'INSERT INTO editor_keys (name, key_hash) VALUES (?, ?)'
			).bind(body.name, hash).run();
			return json({ ok: true });
		}

		if (method === 'POST' && path === '/api/admin/add-key') {
			if (!await authed(req, env.DB)) return err('Unauthorized', 401);
			const body = await req.json().catch(() => null);
			if (!body?.key || !body?.name) return err('Missing fields', 400);
			const hash = await sha256(body.key);
			await env.DB.prepare(
				'INSERT OR REPLACE INTO editor_keys (name, key_hash) VALUES (?, ?)'
			).bind(body.name, hash).run();
			return json({ ok: true });
		}

		return err('Not found', 404);
	},
};