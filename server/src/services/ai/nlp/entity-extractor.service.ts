import { Injectable } from '@nestjs/common';
import { createServiceLogger } from '../../../common/utils/logger-factory';

/**
 * Service responsible for extracting entities from queries
 */
@Injectable()
export class EntityExtractorService {
  
  private readonly logger = createServiceLogger('EntityExtractorService');

  private constructor() {}

  /**
   * Get singleton instance
   */
  

  /**
   * Extract entities from the query
   * @param query The normalized query
   * @returns Array of entities
   */
  public extractEntities(query: string): string[] {
    const entities: string[] = [];
    
    // Stage 1: Extract basic entities using common patterns
    // Common business entities to look for
    const entityPatterns = [
      // Time periods
      { pattern: /last (year|month|quarter|week|day)/g, type: 'time_period' },
      { pattern: /next (year|month|quarter|week|day)/g, type: 'time_period' },
      { pattern: /this (year|month|quarter|week|day)/g, type: 'time_period' },
      { pattern: /(\d+) (years|months|quarters|weeks|days) ago/g, type: 'time_period' },
      { pattern: /(\d{4})-(\d{2})-(\d{2})/g, type: 'date' }, // YYYY-MM-DD
      { pattern: /(\d{4})-(\d{2})/g, type: 'month' }, // YYYY-MM
      { pattern: /(\d{4})q([1-4])/g, type: 'quarter' }, // YYYYq1, YYYYq2, etc.
      { pattern: /(\d{4})/g, type: 'year' }, // YYYY
      
      // Metrics
      { pattern: /revenue/g, type: 'metric' },
      { pattern: /sales/g, type: 'metric' },
      { pattern: /profit/g, type: 'metric' },
      { pattern: /margin/g, type: 'metric' },
      { pattern: /cost/g, type: 'metric' },
      { pattern: /conversion rate/g, type: 'metric' },
      { pattern: /click-through rate/g, type: 'metric' },
      { pattern: /engagement/g, type: 'metric' },
      { pattern: /retention/g, type: 'metric' },
      { pattern: /churn/g, type: 'metric' },
      { pattern: /roi/g, type: 'metric' },
      { pattern: /cac/g, type: 'metric' },
      { pattern: /ltv/g, type: 'metric' },
      { pattern: /arpu/g, type: 'metric' },
      { pattern: /ctr/g, type: 'metric' },
      { pattern: /cpc/g, type: 'metric' },
      { pattern: /cpa/g, type: 'metric' },
      { pattern: /nps/g, type: 'metric' },
      { pattern: /csat/g, type: 'metric' },
      
      // Dimensions
      { pattern: /region/g, type: 'dimension' },
      { pattern: /country/g, type: 'dimension' },
      { pattern: /state/g, type: 'dimension' },
      { pattern: /city/g, type: 'dimension' },
      { pattern: /product( category)?/g, type: 'dimension' },
      { pattern: /customer( segment)?/g, type: 'dimension' },
      { pattern: /channel/g, type: 'dimension' },
      { pattern: /department/g, type: 'dimension' },
      { pattern: /industry/g, type: 'dimension' },
      { pattern: /sector/g, type: 'dimension' },
      { pattern: /market/g, type: 'dimension' },
      { pattern: /segment/g, type: 'dimension' },
      { pattern: /demographic/g, type: 'dimension' },
      { pattern: /age group/g, type: 'dimension' },
      { pattern: /gender/g, type: 'dimension' },
      { pattern: /location/g, type: 'dimension' },
      
      // Named entities (simplified approach)
      { pattern: /([A-Z][a-z]+ )+[A-Z][a-z]+/g, type: 'named_entity' }, // Proper nouns
    ];
    
    // Extract entities using patterns
    for (const { pattern, type } of entityPatterns) {
      const matches = query.match(pattern);
      if (matches) {
        for (const match of matches) {
          if (!entities.includes(match)) {
            entities.push(match);
          }
        }
      }
    }
    
    // Stage 2: Extract more complex entities using noun phrases
    // Extract entities using noun phrases (enhanced)
    const nounPhrasePatterns = [
      // Business metrics
      /(\w+ ){0,2}(sales|revenue|profit|cost|margin|conversion|retention)( \w+){0,2}/g,
      /(\w+ ){0,2}(customer|product|service|market|channel)( \w+){0,2}/g,
      /(\w+ ){0,2}(performance|growth|decline|increase|decrease|trend)( \w+){0,2}/g,
      
      // Financial metrics
      /(\w+ ){0,2}(roi|return on investment|cash flow|budget|expense)( \w+){0,2}/g,
      /(\w+ ){0,2}(revenue|profit|margin|cost|price|discount)( \w+){0,2}/g,
      
      // Marketing metrics
      /(\w+ ){0,2}(campaign|lead|conversion|click|impression|engagement)( \w+){0,2}/g,
      /(\w+ ){0,2}(ctr|cpc|cpa|cpm|acquisition|retention)( \w+){0,2}/g,
      
      // Product metrics
      /(\w+ ){0,2}(usage|adoption|feature|performance|quality|rating)( \w+){0,2}/g,
      
      // Customer metrics
      /(\w+ ){0,2}(satisfaction|nps|csat|feedback|complaint|support)( \w+){0,2}/g,
      /(\w+ ){0,2}(churn|retention|loyalty|lifetime value|ltv)( \w+){0,2}/g,
      
      // Time-based patterns
      /(\w+ ){0,2}(daily|weekly|monthly|quarterly|yearly|annual)( \w+){0,2}/g,
      /(\w+ ){0,2}(trend|growth|decline|change|comparison)( \w+){0,2}/g,
    ];
    
    for (const pattern of nounPhrasePatterns) {
      const matches = query.match(pattern);
      if (matches) {
        for (const match of matches) {
          const trimmedMatch = match.trim();
          if (!entities.includes(trimmedMatch) && trimmedMatch.split(' ').length > 1) {
            entities.push(trimmedMatch);
          }
        }
      }
    }
    
    // Stage 3: Extract numerical entities and ranges
    const numericalPatterns = [
      // Percentages
      { pattern: /(\d+(\.\d+)?)\s*%/g, type: 'percentage' },
      
      // Currency values
      { pattern: /\$\s*(\d+(\.\d+)?)/g, type: 'currency' },
      { pattern: /(\d+(\.\d+)?)\s*(dollars|euros|pounds)/g, type: 'currency' },
      
      // Ranges
      { pattern: /between\s+(\d+(\.\d+)?)\s+and\s+(\d+(\.\d+)?)/g, type: 'range' },
      { pattern: /from\s+(\d+(\.\d+)?)\s+to\s+(\d+(\.\d+)?)/g, type: 'range' },
      
      // Comparisons
      { pattern: /(greater|more|higher|larger)\s+than\s+(\d+(\.\d+)?)/g, type: 'comparison' },
      { pattern: /(less|lower|smaller|fewer)\s+than\s+(\d+(\.\d+)?)/g, type: 'comparison' },
      
      // Simple numbers (only if they appear to be significant)
      { pattern: /\b(\d{3,}(\.\d+)?)\b/g, type: 'number' },
    ];
    
    for (const { pattern, type } of numericalPatterns) {
      const matches = query.match(pattern);
      if (matches) {
        for (const match of matches) {
          if (!entities.includes(match)) {
            entities.push(match);
          }
        }
      }
    }
    
    // Deduplicate and clean entities
    return [...new Set(entities)].filter(entity => 
      // Filter out common words that might be incorrectly extracted
      !['the', 'and', 'or', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'about'].includes(entity.toLowerCase())
    );
  }
} 