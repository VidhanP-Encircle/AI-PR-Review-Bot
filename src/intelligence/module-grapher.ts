/**
 * @module intelligence/module-grapher
 * 
 * Uses SWC to parse the AST of files in the workspace and build a reverse dependency graph
 * (i.e., mapping a modified file to the files that import it). This gives the AI context
 * about the "blast radius" of a PR.
 */

import { parseFile } from '@swc/core';
import { glob } from 'glob';
import path from 'path';
import { logger } from '../utils/logger.js';
import fs from 'fs/promises';

/**
 * Given a workspace path and a list of modified files,
 * builds a graph of which files in the workspace import the modified files.
 * 
 * @param workspacePath The root path of the repository clone
 * @param modifiedFiles Array of relative paths that were modified in the PR
 * @returns A record mapping modified file paths to an array of dependent file paths
 */
export async function calculateBlastRadius(
  workspacePath: string,
  modifiedFiles: string[]
): Promise<Record<string, string[]>> {
  const blastRadius: Record<string, string[]> = {};

  // Initialize the result map
  for (const file of modifiedFiles) {
    blastRadius[file] = [];
  }

  try {
    // 1. Find all TypeScript / JavaScript files in the workspace
    // Excluding node_modules and typical build output folders
    const allFiles = await glob('**/*.{ts,tsx,js,jsx}', {
      cwd: workspacePath,
      ignore: ['node_modules/**', 'dist/**', 'build/**', '.next/**', 'out/**'],
      absolute: false, // Return relative paths
    });

    // We will parse all files to find their imports
    // In a real production system, this could be cached!
    for (const file of allFiles) {
      const fullPath = path.join(workspacePath, file);
      
      try {
        const ast = await parseFile(fullPath, {
          syntax: file.endsWith('.ts') || file.endsWith('.tsx') ? 'typescript' : 'ecmascript',
          tsx: file.endsWith('.tsx'),
          jsx: file.endsWith('.jsx'),
        });

        const imports: string[] = [];

        // 2. Traverse the AST at the top-level to find import declarations
        // (SWC AST structure: type === 'ImportDeclaration')
        for (const item of ast.body) {
          if (item.type === 'ImportDeclaration') {
            imports.push(item.source.value);
          } else if (item.type === 'ExportAllDeclaration' && item.source) {
            imports.push(item.source.value);
          } else if (item.type === 'ExportNamedDeclaration' && item.source) {
            imports.push(item.source.value);
          }
          // Note: Ignoring dynamic `import()` or `require()` for simplicity in MVP
        }

        // 3. Resolve imports and check if they hit a modified file
        for (const imp of imports) {
          // If the import is a relative path (starts with '.' or '..')
          if (imp.startsWith('.')) {
            const resolvedPath = path.join(path.dirname(file), imp);
            
            // The import might not have an extension, so we check against the modified files
            // by stripping extensions or trying multiple extensions.
            
            for (const modifiedFile of modifiedFiles) {
              const modifiedNoExt = modifiedFile.replace(/\.(ts|tsx|js|jsx)$/, '');
              const resolvedNoExt = resolvedPath.replace(/\.(ts|tsx|js|jsx)$/, '');
              
              if (modifiedNoExt === resolvedNoExt || resolvedPath === modifiedNoExt) {
                // Dependency found!
                if (!blastRadius[modifiedFile].includes(file)) {
                  blastRadius[modifiedFile].push(file);
                }
              }
            }
          }
        }
      } catch (err: unknown) {
        // Skip files that fail to parse (could be invalid syntax, etc)
        logger.debug(`Failed to parse AST for ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

  } catch (error: unknown) {
    logger.error(`Error calculating blast radius: ${error instanceof Error ? error.message : String(error)}`);
  }

  return blastRadius;
}
