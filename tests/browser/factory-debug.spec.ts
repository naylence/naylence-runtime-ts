/**
 * Debug test to examine factory registration in browser environment
 */
import { describe, it, expect, beforeAll } from 'vitest';

describe('Factory Registration Debug', () => {
  it('should log module detection details', async () => {
    // Import the factory registration module to trigger module URL detection
    const factoryModule = await import('../../src/naylence/fame/util/register-runtime-factories.js');
    
    // Try to access internal state - this won't work directly but let's see what we get
    console.log('Factory module loaded:', Object.keys(factoryModule));
    
    // Check if we're in a browser-like environment
    console.log('typeof window:', typeof window);
    console.log('typeof __filename:', typeof __filename);
    console.log('typeof document:', typeof document);
    
    // Try the stack-based detection manually
    try {
      throw new Error('Test stack trace');
    } catch (error) {
      const stack = (error as Error).stack ?? '';
      console.log('Stack trace lines:');
      stack.split('\n').slice(0, 5).forEach((line, i) => {
        console.log(`  ${i}: ${line}`);
      });
      
      const lines = stack.split('\n');
      for (const line of lines) {
        const match = line.match(
          /(https?:\/\/[^\s)]+|file:\/\/[^\s)]+|\/[^\s)]+\.(?:js|ts))/u
        );
        if (match) {
          console.log('First match found:', match[1]);
          break;
        }
      }
    }
    
    // This test just logs information
    expect(true).toBe(true);
  });
});
