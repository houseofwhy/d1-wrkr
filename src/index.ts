export interface Env {
	DB: D1Database;
}

const CORS: HeadersInit = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { ...CORS, 'Content-Type': 'application/json' },
	});
}

function err(msg: string, status: number): Response {
	return json({ error: msg }, status);
}

async function sha256(text: string): Promise<string> {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function authed(req: Request, db: D1Database): Promise<boolean> {
	const h = req.headers.get('Authorization');
	if (!h?.startsWith('Bearer ')) return false;
	const hash = await sha256(h.slice(7));
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
	async fetch(req: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(req.url);

		if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

		// ── PUBLIC READ ROUTES ──

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
			return json(row ? JSON.parse(row.value as string) : []);
		}

		if (pathname === '/api/level-month' && req.method === 'GET') {
			const row = await env.DB.prepare("SELECT value FROM config WHERE key = 'level_month'").first();
			if (!row) return err('Not found', 404);
			return json(JSON.parse(row.value as string));
		}

		if (pathname === '/api/level-verif' && req.method === 'GET') {
			const row = await env.DB.prepare("SELECT value FROM config WHERE key = 'level_verif'").first();
			if (!row) return err('Not found', 404);
			return json(JSON.parse(row.value as string));
		}

		// ── WRITE ROUTES (require auth) ──

		if (pathname === '/api/levels' && req.method === 'PUT') {
			if (!await authed(req, env.DB)) return err('Unauthorized', 401);
			const body = await req.json();
			let sortOrder;
			if (body.insertAt != null) {
				sortOrder = body.insertAt - 1;
				await env.DB.prepare('UPDATE levels SET sort_order = sort_order + 1 WHERE sort_order >= ?').bind(sortOrder).run();
			} else {
				const maxRow = await env.DB.prepare('SELECT MAX(sort_order) as m FROM levels').first();
				sortOrder = (maxRow?.m ?? -1) + 1;
			}
			await env.DB.prepare(`
				INSERT INTO levels (path,name,author,creators,verifier,verification,showcase,thumbnail,id,
									percentToQualify,percentFinished,length,rating,lastUpd,isVerified,isMain,isFuture,tags,records,run,sort_order)
				VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
					ON CONFLICT(path) DO UPDATE SET
					name=excluded.name,author=excluded.author,creators=excluded.creators,
					verifier=excluded.verifier,verification=excluded.verification,
					showcase=excluded.showcase,thumbnail=excluded.thumbnail,id=excluded.id,
					percentToQualify=excluded.percentToQualify,percentFinished=excluded.percentFinished,
					length=excluded.length,rating=excluded.rating,lastUpd=excluded.lastUpd,
					isVerified=excluded.isVerified,isMain=excluded.isMain,isFuture=excluded.isFuture,
					tags=excluded.tags,records=excluded.records,run=excluded.run,sort_order=excluded.sort_order
			).bind(
				body.path, body.name, body.author ?? null,
				body.creators ? JSON.stringify(body.creators) : null,
				body.verifier ?? null, body.verification ?? null, body.showcase ?? null,
				body.thumbnail ?? null, body.id ?? null,
				body.percentToQualify ?? null, body.percentFinished ?? null,
				body.length ?? null, body.rating ?? null, body.lastUpd ?? null,
				body.isVerified ? 1 : 0, body.isMain ? 1 : 0, body.isFuture ? 1 : 0,
				JSON.stringify(body.tags ?? []), JSON.stringify(body.records ?? []),
				body.run != null ? JSON.stringify(body.run) : null, sortOrder
			).run();
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
			await env.DB.prepare(
				'INSERT INTO pending (name,placement,link,sort_order) VALUES (?,?,?,?)'
			).bind(body.name, body.placement, body.link ?? null, body.sort_order ?? 0).run();
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
			const body = await req.json() as { key: string; value: unknown };
			await env.DB.prepare(
				'INSERT INTO config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
			).bind(body.key, JSON.stringify(body.value)).run();
			return json({ ok: true });
		}

		// First key bootstrap — only works when table is empty
		if (pathname === '/api/admin/bootstrap' && req.method === 'POST') {
			const count = await env.DB.prepare('SELECT COUNT(*) as c FROM editor_keys').first<{ c: number }>();
			if (count && count.c > 0) return err('Already bootstrapped', 403);
			const body = await req.json() as { editor_name: string; key: string };
			const hash = await sha256(body.key);
			await env.DB.prepare('INSERT INTO editor_keys (editor_name, key_hash) VALUES (?,?)').bind(body.editor_name, hash).run();
			return json({ ok: true });
		}

		if (pathname === '/api/admin/add-key' && req.method === 'POST') {
			if (!await authed(req, env.DB)) return err('Unauthorized', 401);
			const body = await req.json() as { editor_name: string; key: string };
			const hash = await sha256(body.key);
			await env.DB.prepare('INSERT INTO editor_keys (editor_name, key_hash) VALUES (?,?)').bind(body.editor_name, hash).run();
			return json({ ok: true });
		}

		return err('Not found', 404);

		if (pathname === '/api/auth/validate' && req.method === 'GET') {
			if (!await authed(req, env.DB)) return err('Unauthorized', 401);
			return json({ ok: true });
		}

		if (pathname === '/api/levels/move' && req.method === 'POST') {
			if (!await authed(req, env.DB)) return err('Unauthorized', 401);
			const { path, newPosition } = await req.json();
			const target = newPosition - 1;
			const level = await env.DB.prepare('SELECT sort_order FROM levels WHERE path = ?').bind(path).first();
			if (!level) return err('Level not found', 404);
			const current = level.sort_order;
			if (current === target) return json({ ok: true });
			if (current < target) {
				await env.DB.batch([
					env.DB.prepare('UPDATE levels SET sort_order = sort_order - 1 WHERE sort_order > ? AND sort_order <= ?').bind(current, target),
					env.DB.prepare('UPDATE levels SET sort_order = ? WHERE path = ?').bind(target, path),
				]);
			} else {
				await env.DB.batch([
					env.DB.prepare('UPDATE levels SET sort_order = sort_order + 1 WHERE sort_order >= ? AND sort_order < ?').bind(target, current),
					env.DB.prepare('UPDATE levels SET sort_order = ? WHERE path = ?').bind(target, path),
				]);
			}
			return json({ ok: true });
		}
	},
};
