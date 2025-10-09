-- create_snapshots.sql
-- Creates market_snapshots and index (and optional daily rollup view) WITHOUT altering existing tables.

DO $$
DECLARE
  id_type text;
BEGIN
  -- Detect the data type of markets.id so we match it exactly.
  SELECT data_type
    INTO id_type
  FROM information_schema.columns
  WHERE table_name = 'markets'
    AND column_name = 'id'
  LIMIT 1;

  IF id_type IS NULL THEN
    RAISE EXCEPTION 'Table "markets" (or its column "id") not found.';
  END IF;

  -- Create market_snapshots with a matching FK type
  IF id_type = 'uuid' THEN
    EXECUTE $CT$
      CREATE TABLE IF NOT EXISTS market_snapshots (
        id           uuid PRIMARY KEY,
        market_id    uuid NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
        at           timestamptz NOT NULL DEFAULT now(),
        line         double precision NOT NULL,
        pover        double precision NOT NULL,
        punder       double precision NOT NULL,
        sample_size  integer NOT NULL
      );
    $CT$;
  ELSIF id_type IN ('text','character varying','varchar') THEN
    EXECUTE $CT$
      CREATE TABLE IF NOT EXISTS market_snapshots (
        id           text PRIMARY KEY,
        market_id    text NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
        at           timestamptz NOT NULL DEFAULT now(),
        line         double precision NOT NULL,
        pover        double precision NOT NULL,
        punder       double precision NOT NULL,
        sample_size  integer NOT NULL
      );
    $CT$;
  ELSE
    RAISE EXCEPTION 'Unsupported type for markets.id: %', id_type;
  END IF;

  -- Create the time-range index (safe if already exists)
  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_snapshots_market_time ON market_snapshots(market_id, at)';
END $$;

-- (Optional) Daily rollup materialized view for long-range charts.
-- Safe to run even if it already exists.
CREATE MATERIALIZED VIEW IF NOT EXISTS market_snapshot_daily AS
SELECT
  market_id,
  date_trunc('day', at) AS day,
  AVG(line)   AS line_avg,
  AVG(pover)  AS pover_avg,
  AVG(punder) AS punder_avg,
  COUNT(*)    AS n
FROM market_snapshots
GROUP BY 1, 2;

-- Optional helper index for refreshing/queries on the MV
CREATE INDEX IF NOT EXISTS idx_market_snapshot_daily ON market_snapshot_daily (market_id, day);
