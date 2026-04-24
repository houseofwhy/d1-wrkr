CREATE TABLE IF NOT EXISTS levels (
    path TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    author TEXT,
    verifier TEXT,
    verification TEXT,
    showcase TEXT,
    thumbnail TEXT,
    id TEXT,
    percentToQualify INTEGER,
    percentFinished INTEGER,
    length INTEGER,
    rating REAL,
    lastUpd TEXT,
    isVerified INTEGER DEFAULT 0,
    tags TEXT,
    records TEXT,
    run TEXT,
    sort_order INTEGER
);

CREATE TABLE IF NOT EXISTS pending (
    path TEXT PRIMARY KEY,
    name TEXT,
    author TEXT,
    verifier TEXT,
    verification TEXT,
    showcase TEXT,
    thumbnail TEXT,
    id TEXT,
    percentToQualify INTEGER,
    percentFinished INTEGER,
    length INTEGER,
    rating REAL,
    lastUpd TEXT,
    tags TEXT,
    records TEXT,
    run TEXT,
    sort_order INTEGER
);

CREATE TABLE IF NOT EXISTS editors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT,
    sort_order INTEGER
);

CREATE TABLE IF NOT EXISTS recent_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    change TEXT NOT NULL,
    sort_order INTEGER
);

CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS editor_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    editor_name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE
);
