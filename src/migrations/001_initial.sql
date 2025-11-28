-- create assets table
create table IF NOT EXISTS assets
(
    id             INTEGER
        primary key autoincrement,
    kind           TEXT           not null,
    name           TEXT,
    source_url     TEXT           not null,
    example_prompt TEXT,
    min            REAL default 1 not null,
    max            REAL default 1 not null,
    local_path     TEXT,
    created_at     TEXT           not null,
    updated_at     TEXT           not null,
    check (kind IN ('model', 'lora'))
);

-- create assets indices
create index IF NOT EXISTS idx_assets_kind
    on assets (kind);

-- create the assets_images table
create table IF NOT EXISTS assets_images
(
    id         INTEGER
        primary key autoincrement,
    asset_id   TEXT              not null
        references assets
            on delete cascade,
    url        TEXT              not null,
    is_nsfw    INTEGER default 0 not null,
    width      INTEGER,
    height     INTEGER,
    meta       TEXT,
    created_at TEXT              not null
);

-- create the assets_images indices
create index IF NOT EXISTS idx_assets_images_asset_id
    on assets_images (asset_id);

-- create jobs table
create table IF NOT EXISTS jobs
(
    uuid       TEXT
        primary key,
    status     TEXT not null,
    progress   REAL not null,
    request    TEXT not null,
    result     TEXT,
    error      TEXT,
    webhookUrl TEXT,
    webhookKey TEXT,
    created_at TEXT
);

-- create jobs indices
create index IF NOT EXISTS idx_jobs_status
    on jobs (status);