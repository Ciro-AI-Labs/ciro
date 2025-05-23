/**
 * Database Configuration
 * 
 * This file re-exports from the centralized database infrastructure.
 * It exists for backward compatibility with files that import from config/database.
 * 
 * DEPRECATED: Import from '../infrastructure/database' instead.
 */

import * as winston from 'winston';
import { injectable } from 'inversify';
import { Knex, knex } from 'knex';
import pg from 'pg';
import path from 'path';
import fs from 'fs';
import { ConfigService } from './config.service';
import { createServiceLogger } from '../../common/utils/logger-factory';
import { Pool } from 'pg';
import { config } from '../../config';

// Knex database connection
const environment = (process.env.NODE_ENV || 'development');
// Define a basic knex configuration
const knexConfig = {
  client: 'pg',
  connection: {
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.database
  },
  migrations: {
    directory: path.join(__dirname, '../../migrations')
  }
};

export const db: Knex = knex(knexConfig);

// PostgreSQL connection for chat history and structured data
// Use the centralized configuration from config/index.ts
export const pool = new Pool({
  user: config.database.user,
  password: config.database.password,
  host: config.database.host,
  port: config.database.port,
  database: config.database.database
});

// Test database connection
async function testConnection() {
  try {
    const client = await pool.connect();
    console.log('Successfully connected to database');
    client.release();
    return true;
  } catch (error) {
    console.error('Failed to connect to database:', error);
    return false;
  }
}

async function addMissingColumns() {
  const client = await pool.connect();
  try {
    // Check if required columns exist
    const checkColumns = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'data_sources' 
      AND column_name IN ('credentials', 'metadata')
    `);

    const existingColumns = checkColumns.rows.map(row => row.column_name);

    // Add missing columns
    if (!existingColumns.includes('credentials')) {
      console.log('Adding missing credentials column to data_sources table...');
      await client.query(`
        ALTER TABLE data_sources 
        ADD COLUMN IF NOT EXISTS credentials JSONB
      `);
    }

    if (!existingColumns.includes('metadata')) {
      console.log('Adding missing metadata column to data_sources table...');
      await client.query(`
        ALTER TABLE data_sources 
        ADD COLUMN IF NOT EXISTS metadata JSONB
      `);
    }

    // Verify columns were added
    const verifyColumns = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'data_sources'
    `);
    console.log('Data sources columns:', verifyColumns.rows.map(r => r.column_name));

  } catch (error) {
    console.error('Error adding missing columns:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Initialize database schema
export async function initializeDatabase() {
  console.log('Starting database initialization...');
  
  // First test the connection
  const isConnected = await testConnection();
  if (!isConnected) {
    throw new Error('Could not connect to database');
  }

  try {
    // Check if tables already exist
    const tablesExist = await pool.query(`
      SELECT COUNT(*) 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = 'users'
    `);

    // Only initialize schema if tables don't exist
    if (parseInt(tablesExist.rows[0].count) === 0) {
      console.log('Tables do not exist. Creating schema...');
      // Read and execute the schema file
      const schemaPath = path.join(__dirname, './schema.sql');
      console.log('Reading schema file from:', schemaPath);
      
      const schema = fs.readFileSync(schemaPath, 'utf8');
      console.log('Schema file read successfully');
      
      // Split schema into individual statements
      const statements = schema
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);
      
      console.log(`Executing ${statements.length} schema statements...`);
      
      // Execute each statement separately
      for (const statement of statements) {
        try {
          await pool.query(statement);
        } catch (error: any) {
          console.error('Error executing statement:', {
            error,
            statement: statement.substring(0, 100) + '...' // Log first 100 chars
          });
          throw error;
        }
      }
      
      console.log('Database schema initialized successfully');
    } else {
      console.log('Tables already exist, skipping schema initialization');
    }

    // Always check for and add any missing columns
    await addMissingColumns();
    
    // Verify tables exist
    const tables = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    
    console.log('Existing tables:', tables.rows.map(r => r.table_name));

  } catch (error) {
    console.error('Error initializing database schema:', error);
    throw error;
  }
}

// User-related queries
export async function createUser(email: string, name: string, oauthProvider?: string, oauthId?: string) {
  const result = await pool.query(
    `INSERT INTO users (email, name, oauth_provider, oauth_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [email, name, oauthProvider, oauthId]
  );
  return result.rows[0];
}

export async function findUserByEmail(email: string) {
  const result = await pool.query(
    'SELECT * FROM users WHERE email = $1',
    [email]
  );
  return result.rows[0];
}

export async function findUserByOAuth(provider: string, oauthId: string) {
  const result = await pool.query(
    'SELECT * FROM users WHERE oauth_provider = $1 AND oauth_id = $2',
    [provider, oauthId]
  );
  return result.rows[0];
}

// Session-related queries
export async function createSession(userId: number, sessionToken: string, expiresAt: Date) {
  const result = await pool.query(
    `INSERT INTO sessions (user_id, session_token, expires_at)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [userId, sessionToken, expiresAt]
  );
  return result.rows[0];
}

export async function findSessionByToken(token: string) {
  const result = await pool.query(
    `SELECT s.*, u.* 
     FROM sessions s
     JOIN users u ON s.user_id = u.id
     WHERE s.session_token = $1 AND s.expires_at > NOW()`,
    [token]
  );
  return result.rows[0];
} 