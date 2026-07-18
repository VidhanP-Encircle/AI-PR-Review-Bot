/**
 * @module prompts/registry
 * Version-Controlled Prompt Registry.
 *
 * Loads prompt templates from YAML files based on the detected technology stack.
 * Supports dynamic resolution (e.g., loading "frontend.yaml" if React is detected)
 * and version tracking for A/B testing and rollbacks.
 *
 * Business Rule: Hardcoding prompts is strictly forbidden. All prompts
 * must be loaded through this registry to enable versioning and testing.
 *
 * @see 08_AI_PROVIDER_AND_PROMPT_REGISTRY.md Section 4.3 for architecture.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { PromptConfig, TechnologyProfile } from '../types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Path to the prompt templates directory */
const TEMPLATES_DIR = join(__dirname, 'templates');

/**
 * Loads a prompt template from a YAML file.
 *
 * @param templateName - The name of the template file (without .yaml extension).
 * @returns A PromptConfig object, or null if the template doesn't exist.
 */
export function loadTemplate(templateName: string): PromptConfig | null {
  const filePath = join(TEMPLATES_DIR, `${templateName}.yaml`);

  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = parseYaml(raw) as {
      name?: string;
      version?: string;
      system_prompt?: string;
      user_prompt?: string;
    };

    return {
      name: parsed.name ?? templateName,
      version: parsed.version ?? '1.0.0',
      systemPrompt: parsed.system_prompt ?? '',
      userPrompt: parsed.user_prompt ?? '',
    };
  } catch (error) {
    console.warn(`[PromptRegistry] Failed to load template "${templateName}": ${error}`);
    return null;
  }
}

/**
 * Resolves the best prompt template based on the detected technology stack.
 *
 * Resolution priority:
 * 1. Framework-specific prompts (e.g., "frontend" for React/Vue)
 * 2. Language-specific prompts (e.g., "python", "go")
 * 3. Fallback to "general" prompt
 *
 * The security prompt is ALWAYS loaded in addition to the primary prompt
 * to ensure OWASP checks are never skipped.
 *
 * @param techProfile - The deterministic TechnologyProfile from the Tech Detector.
 * @returns An array of PromptConfigs to run against each chunk.
 */
export function resolvePrompts(techProfile: TechnologyProfile): PromptConfig[] {
  const prompts: PromptConfig[] = [];

  // Always include the security prompt — non-negotiable
  const securityPrompt = loadTemplate('security');
  if (securityPrompt) {
    prompts.push(securityPrompt);
  }

  // Check for framework-specific prompts
  const frontendFrameworks = ['React', 'Next.js', 'Vue.js', 'Svelte', 'Angular'];
  const backendFrameworks = [
    'Express', 'Fastify', 'NestJS', 'Koa', 'Hapi',
    'Django', 'Flask', 'FastAPI',
    'Spring Boot', 'Spring',
    'Gin', 'Fiber', 'Echo',
    'Rails', 'Laravel', 'Phoenix',
    'ASP.NET', '.NET',
  ];

  const hasFrontend = techProfile.frameworks.some((f) =>
    frontendFrameworks.includes(f)
  );
  const hasBackend = techProfile.frameworks.some((f) =>
    backendFrameworks.includes(f)
  );

  if (hasFrontend) {
    const frontendPrompt = loadTemplate('frontend');
    if (frontendPrompt) {
      prompts.push(frontendPrompt);
    }
  }

  if (hasBackend) {
    const backendPrompt = loadTemplate('backend');
    if (backendPrompt) {
      prompts.push(backendPrompt);
    }
  }

  // If a specialized prompt was loaded, return it alongside security
  if (hasFrontend || hasBackend) {
    return prompts;
  }

  // Fallback to general review prompt
  const generalPrompt = loadTemplate('general');
  if (generalPrompt) {
    prompts.push(generalPrompt);
  }

  // If no prompts loaded at all, create a minimal fallback
  if (prompts.length === 0) {
    prompts.push({
      name: 'fallback',
      version: '1.0.0',
      systemPrompt: 'You are a senior software engineer reviewing code changes. Provide actionable feedback.',
      userPrompt: 'Review the following code:\n\n{{code_content}}',
    });
  }

  return prompts;
}
