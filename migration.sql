-- ============================================
-- MIGRATION SCRIPT FOR ENHANCED FEATURES
-- Run this on your existing database
-- ============================================

-- Add new columns to users table
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS use_anonymous BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS display_name VARCHAR(255),
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- Create index for anonymous users
CREATE INDEX IF NOT EXISTS idx_users_anonymous ON users(use_anonymous);

-- Add updated_at to markets if not exists
ALTER TABLE markets 
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- Create pending_markets table
CREATE TABLE IF NOT EXISTS pending_markets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question TEXT NOT NULL,
    description TEXT,
    category VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    close_date TIMESTAMP NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    data_source VARCHAR(255),
    resolution_criteria TEXT NOT NULL,
    created_by UUID REFERENCES users(id),
    rejection_reason TEXT,
    approved_at TIMESTAMP,
    approved_by UUID REFERENCES users(id),
    CONSTRAINT valid_pending_status CHECK (status IN ('pending', 'approved', 'rejected')),
    CONSTRAINT valid_dates_pending CHECK (close_date > created_at)
);

-- Create indexes for pending_markets
CREATE INDEX IF NOT EXISTS idx_pending_markets_status ON pending_markets(status);
CREATE INDEX IF NOT EXISTS idx_pending_markets_creator ON pending_markets(created_by);
CREATE INDEX IF NOT EXISTS idx_pending_markets_created ON pending_markets(created_at);

-- Create prediction_updates table
CREATE TABLE IF NOT EXISTS prediction_updates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prediction_id UUID REFERENCES predictions(id) ON DELETE CASCADE,
    old_prediction NUMERIC(5,2) NOT NULL,
    new_prediction NUMERIC(5,2) NOT NULL,
    reasoning TEXT NOT NULL,
    sources TEXT,
    updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT valid_old_prediction CHECK (old_prediction >= 0 AND old_prediction <= 100),
    CONSTRAINT valid_new_prediction CHECK (new_prediction >= 0 AND new_prediction <= 100)
);

-- Create indexes for prediction_updates
CREATE INDEX IF NOT EXISTS idx_prediction_updates_prediction ON prediction_updates(prediction_id);
CREATE INDEX IF NOT EXISTS idx_prediction_updates_created ON prediction_updates(updated_at);

-- Add comment on new tables
COMMENT ON TABLE pending_markets IS 'User-proposed markets awaiting admin approval';
COMMENT ON TABLE prediction_updates IS 'History of prediction changes with reasoning';

-- Update existing users to have default anonymous settings
UPDATE users 
SET use_anonymous = FALSE, 
    display_name = NULL,
    updated_at = NOW()
WHERE use_anonymous IS NULL;

-- Function to auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Add triggers for updated_at on users
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at 
    BEFORE UPDATE ON users 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Add triggers for updated_at on markets
DROP TRIGGER IF EXISTS update_markets_updated_at ON markets;
CREATE TRIGGER update_markets_updated_at 
    BEFORE UPDATE ON markets 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Add triggers for updated_at on predictions
DROP TRIGGER IF EXISTS update_predictions_updated_at ON predictions;
CREATE TRIGGER update_predictions_updated_at 
    BEFORE UPDATE ON predictions 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Add triggers for updated_at on comments
DROP TRIGGER IF EXISTS update_comments_updated_at ON comments;
CREATE TRIGGER update_comments_updated_at 
    BEFORE UPDATE ON comments 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Grant permissions (adjust if needed for your setup)
-- GRANT ALL ON pending_markets TO postgres;
-- GRANT ALL ON prediction_updates TO postgres;

-- Verify migration
DO $$
BEGIN
    RAISE NOTICE 'Migration completed successfully!';
    RAISE NOTICE 'New tables created: pending_markets, prediction_updates';
    RAISE NOTICE 'New columns added to users: use_anonymous, display_name, updated_at';
    RAISE NOTICE 'Triggers added for automatic updated_at timestamps';
END $$;