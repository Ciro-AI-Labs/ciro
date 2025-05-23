import { Injectable } from '@nestjs/common';
import { createServiceLogger } from '../../../../common/utils/logger-factory';
import { db } from '../../../../config/database';
import * as snowflake from 'snowflake-sdk';
import { SnowflakeError, Connection, Statement } from 'snowflake-sdk';
import { BadRequestError, NotFoundError } from '../../../../common/utils/errors';
import axios from 'axios';
import { IDataSourceConnector } from '../../base/connector.interface';

interface SnowflakeConnectionConfig {
  account: string;        // account identifier (e.g., xy12345.us-east-1)
  username: string;       // login name for the user
  password: string;       // password for the user
  database?: string;      // optional default database to use
  schema?: string;        // optional default schema to use
  warehouse?: string;     // optional default warehouse to use
  role?: string;          // optional default role to use
}

export interface SnowflakeQueryResult {
  columns: string[];
  rows: any[][];
  rowCount: number;
  status: string;
  metadata: any;
}

// Snowflake connection options interface
interface SnowflakeConnectionOptions {
  account: string;
  username: string;
  password?: string;
  privateKey?: string;
  privateKeyPass?: string;
  warehouse?: string;
  database?: string;
  schema?: string;
  role?: string;
}

// OAuth code exchange options
interface OAuthCodeExchangeOptions {
  code: string;
  account: string;
  redirectUri: string;
}

// Generic interface for query results
interface QueryResult {
  [key: string]: any
}

/**
 * Service for interacting with Snowflake
 */
@Injectable()
export class SnowflakeService implements IDataSourceConnector {
  private readonly logger = createServiceLogger('SnowflakeService');
  
  private connections: Map<number, Connection> = new Map();
  private clientId: string;
  private clientSecret: string;
  
  // Static instance for singleton pattern
  private static instance: SnowflakeService | null = null;

  /**
   * Private constructor to enforce singleton pattern
   */
  private constructor() {
    // Load from environment variables
    this.clientId = process.env.SNOWFLAKE_CLIENT_ID || '';
    this.clientSecret = process.env.SNOWFLAKE_CLIENT_SECRET || '';
    
    if (!this.clientId || !this.clientSecret) {
      console.warn('Snowflake OAuth credentials are not configured. Set SNOWFLAKE_CLIENT_ID and SNOWFLAKE_CLIENT_SECRET environment variables.');
    }
  }

  /**
   * Get the singleton instance
   */
  public static getInstance(): SnowflakeService {
    if (!SnowflakeService.instance) {
      SnowflakeService.instance = new SnowflakeService();
    }
    return SnowflakeService.instance;
  }

  /**
   * Create a connection to Snowflake
   * @param dataSourceId The ID of the data source
   * @param config Snowflake connection configuration
   * @returns Connection test result
   */
  async createConnection(
    dataSourceId: number,
    config: SnowflakeConnectionConfig
  ): Promise<{ success: boolean; message?: string }> {
    try {
      this.logger.info(`Creating Snowflake connection for data source ${dataSourceId}`);
      
      // Create a connection
      const connection = snowflake.createConnection({
        account: config.account,
        username: config.username,
        password: config.password,
        database: config.database,
        schema: config.schema,
        warehouse: config.warehouse,
        role: config.role
      });

      // Test the connection by actually connecting
      return new Promise((resolve, reject) => {
        connection.connect((err: SnowflakeError | undefined) => {
          if (err) {
            this.logger.error(`Failed to connect to Snowflake: ${err.message}`);
            return resolve({ 
              success: false, 
              message: `Failed to connect to Snowflake: ${err.message}` 
            });
          }

          // Store the connection in our connection pool
          this.connections.set(dataSourceId, connection);
          
          this.logger.info(`Successfully connected to Snowflake for data source ${dataSourceId}`);
          return resolve({ 
            success: true, 
            message: 'Successfully connected to Snowflake' 
          });
        });
      });
    } catch (error: any) {
      this.logger.error(`Error creating Snowflake connection: ${error.message}`);
      return { 
        success: false, 
        message: `Error creating Snowflake connection: ${error.message}` 
      };
    }
  }

  /**
   * Get or create a connection to Snowflake for a specific data source
   * @param dataSourceId The ID of the data source
   * @returns A Snowflake connection
   */
  async getConnection(dataSourceId: number): Promise<Connection> {
    // Check if we already have an active connection
    const existingConnection = this.connections.get(dataSourceId);
    if (existingConnection) {
      return existingConnection;
    }

    // No active connection, retrieve credentials from database and create new connection
    const dataSource = await db('data_sources').where({ id: dataSourceId }).first();
    if (!dataSource) {
      throw new NotFoundError(`Data source with ID ${dataSourceId} not found`);
    }

    // Extract connection config from metadata
    const metadata = dataSource.metadata || {};
    const config: SnowflakeConnectionConfig = {
      account: metadata.snowflake_account,
      username: metadata.snowflake_username,
      password: metadata.snowflake_password,
      database: metadata.snowflake_database,
      schema: metadata.snowflake_schema,
      warehouse: metadata.snowflake_warehouse,
      role: metadata.snowflake_role
    };

    // Create connection
    const connectionResult = await this.createConnection(dataSourceId, config);
    if (!connectionResult.success) {
      throw new BadRequestError(`Failed to connect to Snowflake: ${connectionResult.message}`);
    }

    return this.connections.get(dataSourceId) as Connection;
  }

  /**
   * Execute a SQL query against Snowflake
   * @param dataSourceId The ID of the data source
   * @param query SQL query to execute
   * @returns Query results
   */
  async executeQuery(
    dataSourceId: number,
    query: string
  ): Promise<SnowflakeQueryResult> {
    try {
      this.logger.info(`Executing Snowflake query for data source ${dataSourceId}`);
      const connection = await this.getConnection(dataSourceId);

      return new Promise((resolve, reject) => {
        connection.execute({
          sqlText: query,
          complete: (err: SnowflakeError | undefined, _stmt: Statement | undefined, rows: any[] | undefined) => {
            if (err) {
              this.logger.error(`Error executing Snowflake query: ${err.message}`);
              return reject(err);
            }

            if (!_stmt) {
              this.logger.error('Statement object was undefined in Snowflake callback.');
              return reject(new Error('Statement object was undefined.'));
            }
            if (rows === undefined) {
              this.logger.warn('Rows array was undefined in Snowflake callback, returning empty result.');
              resolve({
                columns: [],
                rows: [],
                rowCount: 0,
                status: 'success',
                metadata: _stmt.getSessionState()
              });
              return;
            }

            const columns = _stmt.getColumns().map(col => col.getName());
            
            // Format the rows as arrays to match the expected format
            const formattedRows = rows.map(row => {
              return columns.map(col => row[col]);
            });

            resolve({
              columns,
              rows: formattedRows,
              rowCount: rows.length,
              status: 'success',
              metadata: _stmt.getSessionState()
            });
          }
        });
      });
    } catch (error: any) {
      this.logger.error(`Error executing Snowflake query: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get a list of available databases
   * @param dataSourceId The ID of the data source
   * @returns List of database names
   */
  async listDatabases(dataSourceId: number): Promise<string[]> {
    const result = await this.executeQuery(dataSourceId, 'SHOW DATABASES');
    return result.rows.map(row => row[1] as string); // Database name is in the second column
  }

  /**
   * Get a list of available schemas in a database
   * @param dataSourceId The ID of the data source
   * @param database Database name
   * @returns List of schema names
   */
  async listSchemas(dataSourceId: number, database: string): Promise<string[]> {
    const result = await this.executeQuery(dataSourceId, `SHOW SCHEMAS IN DATABASE ${database}`);
    return result.rows.map(row => row[1] as string); // Schema name is in the second column
  }

  /**
   * Get a list of available tables in a schema
   * @param dataSourceId The ID of the data source
   * @param database Database name
   * @param schema Schema name
   * @returns List of table names
   */
  async listTables(dataSourceId: number, database: string, schema: string): Promise<string[]> {
    const result = await this.executeQuery(
      dataSourceId, 
      `SHOW TABLES IN ${database}.${schema}`
    );
    return result.rows.map(row => row[1] as string); // Table name is in the second column
  }

  /**
   * Get the structure of a table
   * @param dataSourceId The ID of the data source
   * @param database Database name
   * @param schema Schema name
   * @param table Table name
   * @returns Table structure information
   */
  async describeTable(
    dataSourceId: number, 
    database: string, 
    schema: string, 
    table: string
  ): Promise<any[]> {
    const result = await this.executeQuery(
      dataSourceId,
      `DESC TABLE ${database}.${schema}.${table}`
    );
    return result.rows.map(row => ({
      name: row[0],
      type: row[1],
      kind: row[2],
      nullable: row[3] === 'Y',
      default: row[4],
      primary_key: row[5] === 'Y'
    }));
  }

  /**
   * Close a connection to Snowflake
   * @param dataSourceId The ID of the data source
   */
  async closeConnection(dataSourceId: number): Promise<void> {
    const connection = this.connections.get(dataSourceId);
    if (connection) {
      this.logger.info(`Closing Snowflake connection for data source ${dataSourceId}`);
      return new Promise((resolve, reject) => {
        connection.destroy((err: SnowflakeError | undefined) => {
          if (err) {
            this.logger.error(`Error closing Snowflake connection: ${err.message}`);
            return reject(err);
          }
          this.connections.delete(dataSourceId);
          this.logger.info(`Successfully closed Snowflake connection for data source ${dataSourceId}`);
          resolve();
        });
      });
    } else {
      this.logger.warn(`No active Snowflake connection found for data source ${dataSourceId} to close.`);
      return Promise.resolve();
    }
  }

  /**
   * Close all Snowflake connections
   */
  async closeAllConnections(): Promise<void> {
    const promises = Array.from(this.connections.keys()).map(id => this.closeConnection(id));
    await Promise.all(promises);
  }

  /**
   * Basic health check / ping method
   */
  async ping(): Promise<boolean> {
    // Use a simple, fast query to check connectivity for a *dummy* or *default* dataSourceId if applicable
    // Or, implement a more lightweight check if available via the SDK
    // For now, let's assume a simple check. This needs refinement based on how connections are managed.
    this.logger.info('Pinging Snowflake connection (basic check)');
    try {
      // Attempt to get a connection for a default/test ID or the first available one?
      // This needs a strategy - maybe connect using env vars directly?
      // Placeholder: Simulate success for now.
      // await this.getConnection(SOME_DEFAULT_ID_OR_CONFIG);
      return true; // Placeholder
    } catch (error) { 
      this.logger.error(`Snowflake ping failed: ${error}`);
      return false;
    }
  }

  // The following methods are now handled by SnowflakeFormService
  // and have been removed to prevent duplication
} 