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

function parseLevel(row: Record<string, unknown>) {
	return {
		...row,
		isVerified: row.isVerified === 1,
		tags: row.tags ? JSON.parse(row.tags as string) : [],
		records: row.records ? JSON.parse(row.records as string) : [],
		run: row.run ? JSON.parse(row.run as string) : null,
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
			const body = await req.json() as Record<string, unknown>;
			const path = body.path as string;
			await env.DB.prepare(`
                INSERT INTO levels (path,name,author,verifier,verification,showcase,thumbnail,id,
                    percentToQualify,percentFinished,length,rating,lastUpd,isVerified,tags,records,run,sort_order)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(path) DO UPDATE SET
                    name=excluded.name,author=excluded.author,verifier=excluded.verifier,
                    verification=excluded.verification,showcase=excluded.showcase,thumbnail=excluded.thumbnail,
                    id=excluded.id,percentToQualify=excluded.percentToQualify,
                    percentFinished=excluded.percentFinished,length=excluded.length,rating=excluded.rating,
                    lastUpd=excluded.lastUpd,isVerified=excluded.isVerified,tags=excluded.tags,
                    records=excluded.records,run=excluded.run,sort_order=excluded.sort_order
            `).bind(
				path, body.name, body.author, body.verifier, body.verification, body.showcase,
				body.thumbnail, body.id, body.percentToQualify, body.percentFinished,
				body.length, body.rating, body.lastUpd, body.isVerified ? 1 : 0,
				JSON.stringify(body.tags ?? []), JSON.stringify(body.records ?? []),
				body.run != null ? JSON.stringify(body.run) : null, body.sort_order ?? 0
			).run();
			return json({ ok: true });
		}

		if (pathname.startsWith('/api/levels/') && req.method === 'DELETE') {
			if (!await authed(req, env.DB)) return err('Unauthorized', 401);
			const path = decodeURIComponent(pathname.slice('/api/levels/'.length));
			await env.DB.prepare('DELETE FROM levels WHERE path = ?').bind(path).run();
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
	},
};
