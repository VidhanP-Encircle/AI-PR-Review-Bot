import 'dotenv/config'; // Ensure env vars are loaded for AI providers
import { createAIProvider } from '../src/ai/ai-provider.factory.js';
import { loadTemplate } from '../src/prompts/registry.js';
import type { ReviewContext, CodeChunk, TechnologyProfile } from '../src/types/index.js';

export default class CustomProvider {
  id() {
    return 'ai-pr-reviewer-custom';
  }

  async callApi(prompt: string, context: { vars: Record<string, string | any> }) {
    const { vars } = context;
    
    try {
      // Create our real AI provider
      const aiProvider = createAIProvider();
      
      // Load the general prompt template
      const promptTemplate = loadTemplate('general');
      if (!promptTemplate) {
        throw new Error('Could not load general prompt template');
      }

      // Construct fake context
      const reviewContext: ReviewContext = {
        pullRequestMetadata: {
          title: 'Eval Test PR',
          description: 'Testing the AI via Eval Pipeline',
          author: 'eval-runner'
        },
        technologyStack: typeof vars.technology_stack === 'string' 
          ? JSON.parse(vars.technology_stack) 
          : vars.technology_stack,
        repositoryGuidelines: 'No specific guidelines for this test.',
        ruleEngineFindings: [],
      };

      const chunk: CodeChunk = {
        chunkId: 'eval-chunk',
        filePath: 'src/test.js',
        nodeType: 'function',
        nodeName: 'test',
        startLine: 1,
        endLine: 10,
        content: vars.code_content,
        surroundingContext: vars.surrounding_context || '',
        changedLines: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      };

      const result = await aiProvider.analyzeChunk(promptTemplate, reviewContext, chunk);
      
      // Return the JSON stringified result for promptfoo to evaluate
      return {
        output: JSON.stringify(result, null, 2),
      };
    } catch (error: any) {
      return {
        error: error.message,
      };
    }
  }
}
