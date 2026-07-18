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

/** Required variables that must exist in every loaded prompt template */
const REQUIRED_TEMPLATE_VARS = ['technology_stack', 'frameworks', 'repository_guidelines', 'rule_engine_findings'] as const;

/** In-memory cache for loaded templates to avoid re-parsing YAML on every review */
const templateCache = new Map<string, PromptConfig>();

/**
 * Validates that a loaded prompt template contains all required variables.
 * Missing variables do not block loading but are warned about,
 * as they would cause silent rendering failures at review time.
 */
function validateTemplate(template: PromptConfig, templateName: string): boolean {
  const combined = template.systemPrompt + template.userPrompt;
  for (const v of REQUIRED_TEMPLATE_VARS) {
    if (!combined.includes(`{{${v}}}`)) {
      console.warn(`[PromptRegistry] Template "${templateName}" is missing required variable "${v}". It will not be available during prompt rendering.`);
    }
  }
  // Check that essential sections exist (non-empty prompts)
  if (!template.systemPrompt.trim() || !template.userPrompt.trim()) {
    console.warn(`[PromptRegistry] Template "${templateName}" has empty system_prompt or user_prompt.`);
    return false;
  }
  return true;
}

/**
 * Loads a prompt template from a YAML file with caching.
 *
 * @param templateName - The name of the template file (without .yaml extension).
 * @returns A PromptConfig object, or null if the template doesn't exist or is invalid.
 */
export function loadTemplate(templateName: string): PromptConfig | null {
  // Check cache first
  if (templateCache.has(templateName)) {
    return templateCache.get(templateName) ?? null;
  }

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

    const config: PromptConfig = {
      name: parsed.name ?? templateName,
      version: parsed.version ?? '1.0.0',
      systemPrompt: parsed.system_prompt ?? '',
      userPrompt: parsed.user_prompt ?? '',
    };

    // Validate the loaded template
    if (!validateTemplate(config, templateName)) {
      return null;
    }

    // Cache before returning
    templateCache.set(templateName, config);
    return config;
  } catch (error) {
    console.warn(`[PromptRegistry] Failed to load template "${templateName}": ${error}`);
    return null;
  }
}

/**
 * Clears the in-memory template cache. Useful for testing or hot-reloading.
 */
export function clearCache(): void {
  templateCache.clear();
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

  // If no prompts loaded at all, create a fallback with output format
  if (prompts.length === 0) {
    prompts.push({
      name: 'fallback',
      version: '1.0.0',
      systemPrompt: `You are a senior software engineer reviewing code changes. Provide actionable, high-signal feedback.

## Rules
1. Only flag genuine issues with concrete evidence. If the code is clean, return an empty findings array.
2. Include the specific lines of code that have the issue in your evidence.
3. Be constructive and educational — explain WHY something is wrong, not just THAT it is wrong.
4. Return findings as a JSON array with: title, severity (Critical|High|Medium|Low), confidence (0-100), impact, evidence, recommendation.`,
      userPrompt: 'Review the following code for bugs, security issues, and improvements:\n\n### Code\n```\n{{code_content}}\n```\n\nReturn your review as a single raw JSON array of findings — no markdown fences, no extra text.',
    });
  }

  return prompts;
}
