const fs = require('fs');
const path = require('path');

const dataDir = process.argv[2];
if (!dataDir) { console.error('Usage: node seed.js <path-to-data-dir>'); process.exit(1); }

function esc(v) { return v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`; }
function escJ(v) { return v == null ? 'NULL' : esc(JSON.stringify(v)); }

const lines = [];

// Levels
const listPaths = JSON.parse(fs.readFileSync(path.join(dataDir, '_list.json'), 'utf8'));
listPaths.forEach((lp, i) => {
    try {
        const l = JSON.parse(fs.readFileSync(path.join(dataDir, `${lp}.json`), 'utf8'));
        lines.push(`INSERT OR REPLACE INTO levels (path,name,author,creators,verifier,verification,showcase,thumbnail,id,percentToQualify,percentFinished,length,rating,lastUpd,isVerified,isMain,isFuture,tags,records,run,sort_order) VALUES (${esc(lp)},${esc(l.name)},${esc(l.author)},${escJ(l.creators??null)},${esc(l.verifier)},${esc(l.verification)},${esc(l.showcase)},${esc(l.thumbnail)},${esc(l.id)},${l.percentToQualify??'NULL'},${l.percentFinished??'NULL'},${l.length??'NULL'},${l.rating??'NULL'},${esc(l.lastUpd)},${l.isVerified?1:0},${l.isMain?1:0},${l.isFuture?1:0},${escJ(l.tags??[])},${escJ(l.records??[])},${l.run!=null?escJ(l.run):'NULL'},${i});`);
    } catch(e) { console.warn(`Skip level ${lp}: ${e.message}`); }
});

// Pending
try {
    const pending = JSON.parse(fs.readFileSync(path.join(dataDir, '_pending.json'), 'utf8'));
    lines.push(`DELETE FROM pending;`);
    pending.forEach((p, i) => {
        lines.push(`INSERT INTO pending (name,placement,link,sort_order) VALUES (${esc(p.name)},${esc(p.placement)},${esc(p.link)},${i});`);
    });
} catch(e) { console.warn(`Skip pending: ${e.message}`); }

// Editors
try {
    const eds = JSON.parse(fs.readFileSync(path.join(dataDir, '_editors.json'), 'utf8'));
    lines.push(`DELETE FROM editors;`);
    eds.forEach((e, i) => lines.push(`INSERT INTO editors (name,role,sort_order) VALUES (${esc(e.name)},${esc(e.role)},${i});`));
} catch(e) { console.warn(`Skip editors: ${e.message}`); }
// Config blobs
for (const [file, key] of [['_recentChanges.json','recent_changes'],['_levelMonth.json','level_month'],['_levelVerif.json','level_verif']]) {
    try {
        const raw = fs.readFileSync(path.join(dataDir, file), 'utf8');
        JSON.parse(raw);
        lines.push(`INSERT OR REPLACE INTO config (key,value) VALUES (${esc(key)},${esc(raw)});`);
    } catch(e) { console.warn(`Skip ${file}: ${e.message}`); }
}

fs.writeFileSync('seed.sql', lines.join('\n') + '\n');
console.log(`Written ${lines.length} statements to seed.sql`);
