import { migrate, closePool } from './database.js';
import { logger } from '../utils/logger.js';

async function run(): Promise<void> {
  try {
    await migrate();
    logger.info('Migration completed successfully');
  } catch (err) {
    logger.fatal({ err }, 'Migration failed');
    process.exit(1);
  } finally {
    await closePool();
  }
}

run();
