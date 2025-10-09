// ============================================
// COTERRAN FORECASTING PLATFORM
// Automated Snapshot Creation Service
// ============================================
// Create this file as: cron-snapshots.js (in backend root)
// Run with: node cron-snapshots.js

/* eslint-disable no-console */

const { Pool } = require('pg');
const cron = require('node-cron');

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') 
    ? false 
    : { rejectUnauthorized: false }
});

// Test database connection on startup
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Database connection failed:', err);
    process.exit(1);
  }
  console.log('✅ Database connected successfully');
  console.log('📊 Snapshot cron service started at:', res.rows[0].now);
});

/**
 * Create daily snapshots for all open markets
 * Runs at midnight UTC every day
 */
async function createDailySnapshots() {
  console.log('\n🔄 [DAILY] Creating daily snapshots...');
  const startTime = Date.now();
  
  try {
    const markets = await pool.query(
      'SELECT id, question FROM markets WHERE status = $1',
      ['open']
    );
    
    let successCount = 0;
    let errorCount = 0;
    
    for (const market of markets.rows) {
      try {
        await pool.query(
          'SELECT create_market_snapshot($1, $2)',
          [market.id, 'daily']
        );
        successCount++;
      } catch (err) {
        console.error(`  ❌ Failed for market ${market.id}:`, err.message);
        errorCount++;
      }
    }
    
    const duration = Date.now() - startTime;
    console.log(`✅ [DAILY] Completed in ${duration}ms`);
    console.log(`  📈 Success: ${successCount} markets`);
    if (errorCount > 0) console.log(`  ⚠️  Errors: ${errorCount} markets`);
    
  } catch (err) {
    console.error('❌ [DAILY] Fatal error:', err);
  }
}

/**
 * Create weekly snapshots for all open markets
 * Runs at midnight UTC every Monday
 */
async function createWeeklySnapshots() {
  console.log('\n🔄 [WEEKLY] Creating weekly snapshots...');
  const startTime = Date.now();
  
  try {
    const markets = await pool.query(
      'SELECT id, question FROM markets WHERE status = $1',
      ['open']
    );
    
    let successCount = 0;
    let errorCount = 0;
    
    for (const market of markets.rows) {
      try {
        await pool.query(
          'SELECT create_market_snapshot($1, $2)',
          [market.id, 'weekly']
        );
        successCount++;
      } catch (err) {
        console.error(`  ❌ Failed for market ${market.id}:`, err.message);
        errorCount++;
      }
    }
    
    const duration = Date.now() - startTime;
    console.log(`✅ [WEEKLY] Completed in ${duration}ms`);
    console.log(`  📈 Success: ${successCount} markets`);
    if (errorCount > 0) console.log(`  ⚠️  Errors: ${errorCount} markets`);
    
  } catch (err) {
    console.error('❌ [WEEKLY] Fatal error:', err);
  }
}

/**
 * Create monthly snapshots for all markets (including closed ones)
 * Runs at midnight UTC on the 1st of each month
 * 
 * Monthly snapshots are kept indefinitely to support:
 * - Current monthly/quarterly/annual analytics
 * - Future 5-year and decadal analysis as platform matures
 * - Long-term accuracy tracking
 * - Historical research and reporting
 */
async function createMonthlySnapshots() {
  console.log('\n🔄 [MONTHLY] Creating monthly snapshots...');
  const startTime = Date.now();
  
  try {
    // Include all markets for monthly snapshots (historical data)
    const markets = await pool.query(
      'SELECT id, question FROM markets'
    );
    
    let successCount = 0;
    let errorCount = 0;
    
    for (const market of markets.rows) {
      try {
        await pool.query(
          'SELECT create_market_snapshot($1, $2)',
          [market.id, 'monthly']
        );
        successCount++;
      } catch (err) {
        console.error(`  ❌ Failed for market ${market.id}:`, err.message);
        errorCount++;
      }
    }
    
    const duration = Date.now() - startTime;
    console.log(`✅ [MONTHLY] Completed in ${duration}ms`);
    console.log(`  📈 Success: ${successCount} markets`);
    if (errorCount > 0) console.log(`  ⚠️  Errors: ${errorCount} markets`);
    
  } catch (err) {
    console.error('❌ [MONTHLY] Fatal error:', err);
  }
}

/**
 * Cleanup old snapshots (optional maintenance task)
 * Keeps last 90 days of daily snapshots, 52 weeks of weekly
 * Monthly snapshots are NEVER deleted - they support long-term analysis
 * Runs weekly on Sundays at 3 AM UTC
 */
async function cleanupOldSnapshots() {
  console.log('\n🧹 [CLEANUP] Removing old snapshots...');
  
  try {
    // Delete daily snapshots older than 90 days
    const dailyResult = await pool.query(`
      DELETE FROM market_snapshots
      WHERE snapshot_type = 'daily'
        AND snapshot_date < NOW() - INTERVAL '90 days'
    `);
    
    // Delete weekly snapshots older than 52 weeks
    const weeklyResult = await pool.query(`
      DELETE FROM market_snapshots
      WHERE snapshot_type = 'weekly'
        AND snapshot_date < NOW() - INTERVAL '52 weeks'
    `);
    
    // Note: Monthly snapshots are preserved indefinitely for long-term analysis
    
    console.log(`✅ [CLEANUP] Removed ${dailyResult.rowCount} daily and ${weeklyResult.rowCount} weekly snapshots`);
    console.log(`   📦 Monthly snapshots preserved for historical analysis`);
    
  } catch (err) {
    console.error('❌ [CLEANUP] Error:', err);
  }
}

/**
 * Health check - log system status
 * Runs every hour
 */
async function healthCheck() {
  try {
    const stats = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM markets WHERE status = 'open') as open_markets,
        (SELECT COUNT(*) FROM market_snapshots WHERE snapshot_date >= NOW() - INTERVAL '1 day') as recent_snapshots,
        (SELECT COUNT(*) FROM market_odds_history WHERE timestamp >= NOW() - INTERVAL '1 day') as recent_odds_changes
    `);
    
    const { open_markets, recent_snapshots, recent_odds_changes } = stats.rows[0];
    console.log(`\n💚 Health: ${open_markets} open markets | ${recent_snapshots} snapshots today | ${recent_odds_changes} odds changes`);
    
  } catch (err) {
    console.error('❌ Health check failed:', err.message);
  }
}

// ============================================
// SCHEDULE CRON JOBS
// ============================================

console.log('\n📅 Scheduling cron jobs...\n');

// Daily snapshots at midnight UTC (00:00)
cron.schedule('0 0 * * *', () => {
  createDailySnapshots();
}, {
  timezone: "UTC"
});
console.log('  ✓ Daily snapshots: 00:00 UTC every day');

// Weekly snapshots on Mondays at midnight UTC
cron.schedule('0 0 * * 1', () => {
  createWeeklySnapshots();
}, {
  timezone: "UTC"
});
console.log('  ✓ Weekly snapshots: 00:00 UTC every Monday');

// Monthly snapshots on the 1st at midnight UTC
cron.schedule('0 0 1 * *', () => {
  createMonthlySnapshots();
}, {
  timezone: "UTC"
});
console.log('  ✓ Monthly snapshots: 00:00 UTC on the 1st');

// Cleanup old snapshots on Sundays at 3 AM UTC
cron.schedule('0 3 * * 0', () => {
  cleanupOldSnapshots();
}, {
  timezone: "UTC"
});
console.log('  ✓ Cleanup: 03:00 UTC every Sunday');

// Health check every hour
cron.schedule('0 * * * *', () => {
  healthCheck();
}, {
  timezone: "UTC"
});
console.log('  ✓ Health check: Every hour\n');

// Run initial health check
healthCheck();

// ============================================
// GRACEFUL SHUTDOWN HANDLING
// ============================================

process.on('SIGTERM', async () => {
  console.log('\n⏹️  Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n⏹️  Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

// Keep the process running
console.log('✨ Cron service is running. Press Ctrl+C to stop.\n');

// Optional: Run snapshots immediately on startup if needed
// Uncomment the next line to create snapshots when starting:
// setTimeout(() => { createDailySnapshots(); }, 5000);