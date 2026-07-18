/**
 * @module chunking/tree-sitter-parser
 * Tree-sitter AST Parsing Wrapper.
 *
 * Wraps the Tree-sitter Node.js bindings to generate Abstract Syntax Trees
 * for all supported languages. Exposes query methods for extracting top-level
 * structural nodes (functions, classes, methods, types, etc.).
 *
 * Language-specific configuration (grammars, node types, field names) is
 * defined in language-config.ts. Adding a new language requires:
 * 1. Install the tree-sitter-{language} npm package
 * 2. Add an entry to LANGUAGE_CONFIGS in language-config.ts
 *
 * @see language-config.ts for supported languages and their AST node types.
 * @see 07_CHUNKED_ANALYSIS_AND_TREE_SITTER.md for architecture.
 */

import Parser from 'tree-sitter';
import { extname } from 'node:path';
import { getLanguageConfig } from './language-config.js';
import type { ASTNode } from './language-config.js';


/**
 * Attempts to extract the human-readable name from an AST node.
 * Handles various declaration patterns across all supported languages.
 *
 * Strategy:
 * 1. Try the configured name field (usually 'name')
 * 2. Special handling for export wrappers (JS/TS export statement)
 * 3. Special handling for lexical declarations (const/let in JS/TS)
 * 4. Special handling for decorated definitions (Python @decorator)
 * 5. Special handling for variable declarations (Go var, Rust let, etc.)
 *
 * @param node - The Tree-sitter syntax node.
 * @param config - The language configuration for name field info.
 * @returns The extracted name, or null if not identifiable.
 */
function extractNodeName(node: Parser.SyntaxNode, config: {
  nameField: string;
  hasExportWrapper: boolean;
}): string | null {
  // Try the configured name field (works for most languages)
  const nameChild = node.childForFieldName(config.nameField);
  if (nameChild) return nameChild.text;

  // For export wrappers (JS/TS: export function foo, export class Bar)
  if (config.hasExportWrapper && node.type === 'export_statement') {
    const declaration = node.childForFieldName('declaration');
    if (declaration) return extractNodeName(declaration, config);
  }

  // For lexical_declaration (JS/TS: const/let foo = ...)
  if (node.type === 'lexical_declaration') {
    const declarator = node.namedChildren.find(
      (c) => c.type === 'variable_declarator'
    );
    if (declarator) {
      const name = declarator.childForFieldName('name');
      if (name) return name.text;
    }
  }

  // For Python decorated definitions: look inside @decorator
  if (node.type === 'decorated_definition') {
    // The definition is usually the last named child
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i]!;
      if (child.type === 'function_definition' || child.type === 'class_definition') {
        return extractNodeName(child, config);
      }
    }
  }

  // For type_spec in Go (type Foo struct/interface)
  if (node.type === 'type_spec' || node.type === 'struct_type' || node.type === 'interface_type') {
    const name = node.childForFieldName('name');
    if (name) return name.text;
  }

  // For Go var/const declarations
  if (node.type === 'var_declaration' || node.type === 'const_declaration') {
    const spec = node.namedChildren.find(
      (c) => c.type === 'var_spec' || c.type === 'const_spec'
    );
    if (spec) {
      const name = spec.childForFieldName('name');
      if (name) return name.text;
    }
  }

  // For Java record declarations
  if (node.type === 'record_declaration') {
    const name = node.childForFieldName('name');
    if (name) return name.text;
  }

  return null;
}

/**
 * Parses a source file using Tree-sitter and extracts all top-level
 * structural nodes (functions, classes, methods, types, etc.).
 *
 * @param sourceCode - The full source code text of the file.
 * @param filePath - The file path, used to determine the language grammar.
 * @returns An array of ASTNode objects, or an empty array if the language is unsupported.
 */
export function parseAndExtractNodes(
  sourceCode: string,
  filePath: string
): ASTNode[] {
  const ext = extname(filePath).toLowerCase();    const config = getLanguageConfig(ext);

  // Graceful degradation: if the language isn't supported, return empty
  if (!config) return [];

  const langGrammar = config.grammar;
  const structTypes = config.structuralNodeTypes;
  const hasExportWrapper = config.hasExportWrapper;
  const nameField = config.nameField;

  const parser = new Parser();

  try {
    parser.setLanguage(langGrammar);
    const tree = parser.parse(sourceCode);
    const nodes: ASTNode[] = [];

    /**
     * Recursively traverses the AST to find structural nodes.
     * Stops descending once a structural node is found to prevent
     * extracting both a class and its individual methods separately.
     */
    function traverse(node: Parser.SyntaxNode, depth: number): void {
      if (structTypes.has(node.type) && depth <= 2) {
        nodes.push({
          type: node.type,
          name: extractNodeName(node, {
            nameField,
            hasExportWrapper,
          }),
          startLine: node.startPosition.row + 1, // Convert 0-indexed to 1-indexed
          endLine: node.endPosition.row + 1,
          text: node.text,
        });
        return; // Don't descend further — we captured the structural block
      }

      // Continue traversing children to find deeper structural nodes
      for (const child of node.namedChildren) {
        traverse(child, depth + 1);
      }
    }

    traverse(tree.rootNode, 0);

    // Cleanup: explicitly delete the tree to prevent memory leaks
    (tree as { delete?: () => void }).delete?.();

    return nodes;
  } catch (err) {
    console.error(`[Tree-sitter] Error parsing ${filePath}:`, err);
    return [];
  }
}

/**
 * Extracts the import/require/include statements from the top of a source file.
 * These are included as surrounding context in each code chunk so the AI
 * understands the module's dependencies across any language.
 *
 * @param sourceCode - The full source code text.
 * @param filePath - The file path for language detection.
 * @returns A string containing all import statements, or empty if unsupported.
 */
export function extractImports(sourceCode: string, filePath: string): string {
  const ext = extname(filePath).toLowerCase();    const config = getLanguageConfig(ext);

  if (!config) return '';

  const importTypes = config.importNodeTypes;

  const parser = new Parser();

  try {
    parser.setLanguage(config.grammar);
    const tree = parser.parse(sourceCode);
    const imports: string[] = [];

    for (const child of tree.rootNode.namedChildren) {
      if (importTypes.has(child.type)) {
        imports.push(child.text);
      }
    }

    (tree as { delete?: () => void }).delete?.();
    return imports.join('\n');
  } catch (err) {
    // Graceful fallback — return empty imports if parsing fails
    return '';
  }
}
