import { Injectable } from '@nestjs/common';
import { createServiceLogger } from '@common/utils/logger-factory';
import { SnowflakeService } from '@services/datasources/connectors/snowflake/snowflake.service';
import { OpenAIService, ChatMessage } from '@services/ai/openai.service';
import { QdrantSearchService } from '@services/vector/search.service';
import { QdrantCollectionService } from '@services/vector/collection-manager.service';
import { ChunkingService } from '@services/rag/chunking.service';
import { SnowflakeSchemaIndexerService } from '@services/datasources/processors/schema/snowflake/snowflake-schema-indexer.service';
import { v4 as uuidv4 } from 'uuid';

// Define an interface for the expected column structure
interface SnowflakeColumnInfo {
  name: string;
  type: string;
  comment?: string | null; // Allow comment to be potentially null or undefined
}

interface NLQueryOptions {
  maxTokens?: number;
  temperature?: number;
  cacheResults?: boolean;
  includeReasoning?: boolean;
  model?: string;
  filterTables?: string[];
  useKnowledgeCollections?: boolean; // Flag to use knowledge collections
}

// Keep existing SchemaMetadata interface
interface SchemaMetadata {
  database: string;
  schema: string;
  table: string;
  columns: {
    name: string;
    type: string;
    description?: string;
  }[];
  description?: string;
  rowCount?: number;
  sampleData?: any[][];
}

/**
 * Service for handling natural language queries against Snowflake
 * Leverages existing embeddings infrastructure for semantic understanding
 */
@Injectable()
export class SnowflakeNLQueryService {
  private readonly logger = createServiceLogger('SnowflakeNLQueryService');
  
  
  private constructor(
    private snowflakeService: SnowflakeService,
    private openaiService: OpenAIService,
    private qdrantSearchService: QdrantSearchService,
    private qdrantCollectionService: QdrantCollectionService,
    private chunkingService: ChunkingService,
    private schemaIndexerService: SnowflakeSchemaIndexerService
  ) {}
  
  /**
   * Get singleton instance
   */
  
  
  /**
   * Execute a natural language query against Snowflake
   * @param dataSourceId The data source ID
   * @param query The natural language query
   * @param options Query options
   */
  async executeNaturalLanguageQuery(
    dataSourceId: number,
    query: string,
    options: NLQueryOptions = {}
  ): Promise<{
    sql: string;
    result: any;
    reasoning?: string;
    timing: {
      total: number;
      sqlGeneration: number;
      execution: number;
    }
  }> {
    const startTime = Date.now();
    this.logger.info(`Executing NL query for data source ${dataSourceId}: "${query}"`);
    
    try {
      let schemas: SchemaMetadata[] = [];
      
      // Determine how to get schema metadata
      if (options.useKnowledgeCollections !== false) {
        // Try to use knowledge collections first (default behavior)
        schemas = await this.getSchemaMetadataFromKnowledge(dataSourceId, options.filterTables);
        
        // If no schemas found from knowledge, fall back to direct query
        if (schemas.length === 0) {
          this.logger.info('No knowledge collections found, falling back to direct schema query');
          schemas = await this.getSchemaMetadata(dataSourceId, options.filterTables);
        }
      } else {
        // Use direct query if knowledge collections are disabled
        schemas = await this.getSchemaMetadata(dataSourceId, options.filterTables);
      }
      
      // Generate SQL from natural language using OpenAI
      const sqlGenerationStart = Date.now();
      const sqlQuery = await this.generateSqlFromNaturalLanguage(query, schemas, options);
      const sqlGenerationTime = Date.now() - sqlGenerationStart;
      
      // Execute the generated SQL
      const executionStart = Date.now();
      const result = await this.snowflakeService.executeQuery(dataSourceId, sqlQuery);
      const executionTime = Date.now() - executionStart;
      
      // Generate reasoning if requested
      let reasoning = undefined;
      if (options.includeReasoning) {
        reasoning = await this.generateQueryReasoning(query, sqlQuery, result);
      }
      
      // Return complete results
      const totalTime = Date.now() - startTime;
      return {
        sql: sqlQuery,
        result,
        ...(reasoning ? { reasoning } : {}),
        timing: {
          total: totalTime,
          sqlGeneration: sqlGenerationTime,
          execution: executionTime
        }
      };
    } catch (error: any) {
      this.logger.error(`Error executing NL query: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get schema metadata from knowledge collections
   */
  private async getSchemaMetadataFromKnowledge(
    dataSourceId: number,
    filterTables?: string[]
  ): Promise<SchemaMetadata[]> {
    try {
      this.logger.info(`Getting schema metadata from knowledge collections for data source ${dataSourceId}`);
      
      // The collection name follows the same pattern as other data sources
      const collectionName = `datasource_${dataSourceId}`;
      
      // Check if collection exists
      const collectionExists = await this.qdrantCollectionService.collectionExists(collectionName);
      
      if (!collectionExists) {
        this.logger.warn(`No knowledge collection found for data source ${dataSourceId}`);
        return [];
      }
      
      this.logger.info(`Found knowledge collection for data source ${dataSourceId}: ${collectionName}`);
      
      // For now we'll create a dummy vector to search with and apply filters
      // This is a workaround to use the filter mechanism
      const dummyVector = Array(1536).fill(0.1);  // Assuming 1536 dimensions for OpenAI embeddings
      
      // Get all points with snowflake source type 'table'
      const tableResponse = await this.qdrantSearchService.search(
        collectionName,
        dummyVector,
        {
          must: [
            { key: 'source', match: { value: 'snowflake' } },
            { key: 'sourceType', match: { value: 'table' } }
          ]
        } as any,
        100 // Get up to 100 tables
      );
      
      // Process table metadata
      const tableMetadata = tableResponse.map((result: any) => {
        const payload = result.payload;
        return {
          database: payload.database,
          schema: payload.schema,
          table: payload.table,
          description: payload.description || '',
          // We'll fill in columns later
          columns: [] as Array<{
            name: string;
            type: string;
            description: string;
          }>
        };
      });
      
      // Get column metadata for each table
      for (const table of tableMetadata) {
        // Fetch columns for this table
        const columnResponse = await this.qdrantSearchService.search(
          collectionName,
          dummyVector,
          {
            must: [
              { key: 'source', match: { value: 'snowflake' } },
              { key: 'sourceType', match: { value: 'column' } },
              { key: 'database', match: { value: table.database } },
              { key: 'schema', match: { value: table.schema } },
              { key: 'table', match: { value: table.table } }
            ]
          } as any,
          500 // Get up to 500 columns per table
        );
        
        // Add columns to the table metadata
        table.columns = columnResponse.map((result: any) => {
          const payload = result.payload;
          return {
            name: payload.column,
            type: payload.dataType || 'string',
            description: payload.description || ''
          };
        });
      }
      
      // Filter tables if needed
      if (filterTables && filterTables.length > 0) {
        return tableMetadata.filter((table: any) => 
          filterTables.includes(`${table.database}.${table.schema}.${table.table}`)
        );
      }
      
      return tableMetadata;
    } catch (error: any) {
      this.logger.error(`Error getting schema metadata from knowledge: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Get schema metadata for the tables in a data source
   */
  private async getSchemaMetadata(
    dataSourceId: number,
    filterTables?: string[]
  ): Promise<SchemaMetadata[]> {
    try {
      this.logger.info(`Getting schema metadata directly from Snowflake for data source ${dataSourceId}`);
      
      // Step 1: Get list of available tables
      const availableTables = await this.getAvailableTables(dataSourceId);
      
      // Step 2: Filter tables if needed
      const tablesToDescribe = filterTables 
        ? availableTables.filter(t => filterTables.includes(`${t.database}.${t.schema}.${t.table}`))
        : availableTables;
      
      // Step 3: Get schema information for each table
      const schemas: SchemaMetadata[] = [];
      
      for (const table of tablesToDescribe) {
        // Get table structure
        const columns = await this.snowflakeService.describeTable(
          dataSourceId,
          table.database,
          table.schema,
          table.table
        );
        
        // Get sample data (limited rows)
        const sampleQuery = `SELECT * FROM ${table.database}.${table.schema}.${table.table} LIMIT 5`;
        const sampleData = await this.snowflakeService.executeQuery(dataSourceId, sampleQuery);
        
        // Get row count
        const countQuery = `SELECT COUNT(*) FROM ${table.database}.${table.schema}.${table.table}`;
        const countResult = await this.snowflakeService.executeQuery(dataSourceId, countQuery);
        const rowCount = countResult.rows[0][0];
        
        schemas.push({
          database: table.database,
          schema: table.schema,
          table: table.table,
          columns: columns.map((col: SnowflakeColumnInfo) => ({
            name: col.name,
            type: col.type,
            description: col.comment || ''
          })),
          rowCount,
          sampleData: sampleData.rows
        });
      }
      
      return schemas;
    } catch (error: any) {
      this.logger.error(`Error getting schema metadata: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Get available tables in the data source
   */
  private async getAvailableTables(dataSourceId: number): Promise<{
    database: string;
    schema: string;
    table: string;
  }[]> {
    try {
      // Get available databases
      const databases = await this.snowflakeService.listDatabases(dataSourceId);
      const tables: { database: string; schema: string; table: string; }[] = [];
      
      // For each database, get schemas
      for (const database of databases) {
        const schemas = await this.snowflakeService.listSchemas(dataSourceId, database);
        
        // For each schema, get tables
        for (const schema of schemas) {
          const tableNames = await this.snowflakeService.listTables(dataSourceId, database, schema);
          
          // Add tables to the list
          for (const tableName of tableNames) {
            tables.push({
              database,
              schema,
              table: tableName
            });
          }
        }
      }
      
      return tables;
    } catch (error: any) {
      this.logger.error(`Error getting available tables: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Generate SQL from natural language query
   */
  private async generateSqlFromNaturalLanguage(
    query: string,
    schemas: SchemaMetadata[],
    options: NLQueryOptions
  ): Promise<string> {
    // Prepare the schema information for the prompt
    const schemaInfo = schemas.map(schema => {
      const columnsInfo = schema.columns.map(col => 
        `${col.name} (${col.type})${col.description ? `: ${col.description}` : ''}`
      ).join('\n');
      
      return `Table: ${schema.database}.${schema.schema}.${schema.table}
Description: ${schema.description || 'No description available'}
Columns:
${columnsInfo}
${schema.rowCount ? `Row count: ~${schema.rowCount}` : ''}`;
    }).join('\n\n');
    
    // Build the prompt for SQL generation
    const prompt = `You are an expert SQL translator. Given the schema information below and a natural language query, generate the appropriate SQL query for Snowflake.

### Schema Information
${schemaInfo}

### Natural Language Query
${query}

### Generated SQL Query`;
    
    // Call OpenAI with the prepared prompt
    const messages: ChatMessage[] = [
      { 
        id: Date.now().toString(),
        role: 'system',
        content: 'You are a SQL expert that converts natural language to SQL queries.',
        timestamp: Date.now(),
        status: 'complete'
      },
      { 
        id: (Date.now() + 1).toString(),
        role: 'user',
        content: prompt,
        timestamp: Date.now(),
        status: 'complete'
      }
    ];

    const response = await this.openaiService.generateChatCompletion(messages, {
      model: options.model || 'gpt-4',
      temperature: options.temperature || 0.1
    });
    
    // Extract SQL from the response
    const responseData = await response.json() as { content: string };
    return responseData.content.trim();
  }
  
  /**
   * Infer a table's purpose from its name and columns
   */
  private inferTablePurpose(table: { 
    tableName: string; 
    columns: Array<{ name: string }>; 
    rowCount?: number;
  }): string {
    const tableName = table.tableName.toLowerCase();
    const columnNames = table.columns.map(c => c.name.toLowerCase());
    
    // Common table types
    if (tableName.includes('user') || tableName.includes('customer')) {
      return 'Contains user or customer information';
    } else if (tableName.includes('order')) {
      return 'Contains order information';
    } else if (tableName.includes('product') || tableName.includes('item')) {
      return 'Contains product information';
    } else if (tableName.includes('transaction')) {
      return 'Contains transaction records';
    } else if (tableName.includes('log')) {
      return 'Contains log entries';
    } else if (tableName.includes('config') || tableName.includes('setting')) {
      return 'Contains configuration or settings';
    }
    
    // Check for common column patterns
    if (columnNames.includes('id') && (
      columnNames.includes('name') || 
      columnNames.includes('description') || 
      columnNames.includes('title')
    )) {
      return 'Contains entity records with identifiers and descriptions';
    }
    
    // Date-related tables
    if (columnNames.some((c: string) => c.includes('date') || c.includes('time'))) {
      if (columnNames.some((c: string) => c.includes('amount') || c.includes('total') || c.includes('price'))) {
        return 'Contains time-based financial or transactional records';
      } else {
        return 'Contains time-based records';
      }
    }
    
    // Default
    return `Table containing ${table.columns.length} columns and approximately ${table.rowCount || 'unknown'} rows`;
  }
  
  /**
   * Infer a column's description from its name and type
   */
  private inferColumnDescription(name: string, type: string): string {
    const lowerName = name.toLowerCase();
    
    // ID columns
    if (lowerName === 'id' || lowerName.endsWith('_id')) {
      return 'Unique identifier';
    }
    
    // Common column types
    if (lowerName === 'name' || lowerName.endsWith('_name')) {
      return 'Name or title';
    } else if (lowerName === 'description' || lowerName.endsWith('_description')) {
      return 'Description text';
    } else if (lowerName.includes('email')) {
      return 'Email address';
    } else if (lowerName.includes('phone')) {
      return 'Phone number';
    } else if (lowerName.includes('address')) {
      return 'Address information';
    }
    
    // Date and time
    if (
      lowerName.includes('date') || 
      lowerName.includes('time') || 
      lowerName === 'created_at' || 
      lowerName === 'updated_at' || 
      lowerName === 'deleted_at'
    ) {
      return 'Date or timestamp';
    }
    
    // Financial
    if (
      lowerName.includes('price') || 
      lowerName.includes('cost') || 
      lowerName.includes('amount') || 
      lowerName.includes('total')
    ) {
      return 'Monetary value or amount';
    }
    
    // Status
    if (lowerName.includes('status') || lowerName.includes('state')) {
      return 'Status or state indicator';
    }
    
    // Boolean flags
    if (
      lowerName.startsWith('is_') || 
      lowerName.startsWith('has_') || 
      type.toLowerCase().includes('bool')
    ) {
      return 'Boolean flag or indicator';
    }
    
    // Based on data type
    if (type.toLowerCase().includes('int')) {
      return 'Numeric value';
    } else if (type.toLowerCase().includes('varchar') || type.toLowerCase().includes('char')) {
      return 'Text value';
    } else if (type.toLowerCase().includes('date')) {
      return 'Date value';
    } else if (type.toLowerCase().includes('time')) {
      return 'Time value';
    } else if (type.toLowerCase().includes('timestamp')) {
      return 'Timestamp value';
    }
    
    // Default
    return `${type} data column`;
  }
  
  /**
   * Generate reasoning for the query and results
   */
  private async generateQueryReasoning(
    naturalLanguageQuery: string,
    sqlQuery: string,
    results: any
  ): Promise<string> {
    try {
      // Format results for the prompt
      const resultsPreview = results.rows.length > 0 
        ? JSON.stringify(results.rows.slice(0, 5), null, 2)
        : 'No rows returned';
      
      // Create a prompt for OpenAI
      const prompt = `I executed a natural language query against a Snowflake database.
      
Natural Language Query: "${naturalLanguageQuery}"

The system converted it to this SQL:
\`\`\`sql
${sqlQuery}
\`\`\`

The results were (showing first 5 rows):
\`\`\`json
${resultsPreview}
\`\`\`

Please explain:
1. How the SQL query addresses the natural language request
2. What the results mean in relation to the original question
3. Any limitations or caveats about the query or results`;
      
      // Call OpenAI for reasoning
      const messages: ChatMessage[] = [
        { 
          id: Date.now().toString(),
          role: 'system',
          content: 'You are a database expert who explains SQL queries and results to non-technical users.',
          timestamp: Date.now(),
          status: 'complete'
        },
        { 
          id: (Date.now() + 1).toString(),
          role: 'user',
          content: prompt,
          timestamp: Date.now(),
          status: 'complete'
        }
      ];
      
      const response = await this.openaiService.generateChatCompletion(messages, {
        model: 'gpt-4',
        temperature: 0.3
      });
      
      const responseData = await response.json() as { content: string };
      return responseData.content || '';
    } catch (error: any) {
      this.logger.warn(`Error generating query reasoning: ${error.message}`);
      return 'Reasoning generation failed. Please review the SQL query and results.';
    }
  }
} 