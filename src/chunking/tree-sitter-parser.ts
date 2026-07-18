/**
 * @module chunking/tree-sitter-parser
 * Tree-sitter AST Parsing Wrapper.
 *
 * Wraps the Tree-sitter Node.js bindings to generate Abstract Syntax Trees
 * for JavaScript and TypeScript source files. Exposes query methods for
 * extracting top-level structural nodes (functions, classes, exports).
 *
 * Business Rule: We use Tree-sitter instead of regex because it produces
 * actual syntax trees that respect language grammar, enabling us to extract
 * complete function/class bodies without breaking mid-statement.
 *
 * @see 07_CHUNKED_ANALYSIS_AND_TREE_SITTER.md for architecture.
 */

import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import { extname } from 'node:path';

/**
 * Maps file extensions to the correct Tree-sitter language grammar.
 * This enables the parser to automatically select the right grammar
 * without asking the AI "what language is this?".
 */
const LANGUAGE_MAP: Record<string, unknown> = {
  '.js': (JavaScript as any).default || JavaScript,
  '.jsx': (JavaScript as any).default || JavaScript,
  '.ts': (TypeScript as any).default?.typescript || (TypeScript as any).typescript,
  '.tsx': (TypeScript as any).default?.tsx || (TypeScript as any).tsx,
};

/**
 * AST node types that represent top-level structural blocks.
 * These are the boundaries the chunking engine uses to split code
 * into semantically complete units for AI analysis.
 */
const STRUCTURAL_NODE_TYPES = new Set([
  'function_declaration',
  'arrow_function',
  'class_declaration',
  'method_definition',
  'export_statement',
  'lexical_declaration',      // const/let declarations (often arrow functions)
  'expression_statement',     // Top-level expressions
  'interface_declaration',    // TypeScript interfaces
  'type_alias_declaration',   // TypeScript type aliases
  'enum_declaration',         // TypeScript enums
]);

/**
 * Represents a structural node extracted from the AST.
 * Contains positional and textual information for chunking.
 */
export interface ASTNode {
  /** The Tree-sitter node type (e.g., "function_declaration") */
  type: string;

  /** The name of the function/class/variable, if identifiable */
  name: string | null;

  /** Start line in the source file (0-indexed from Tree-sitter, converted to 1-indexed) */
  startLine: number;

  /** End line in the source file (1-indexed) */
  endLine: number;

  /** The full source text of this node */
  text: string;
}

/**
 * Attempts to extract the human-readable name from an AST node.
 * Handles various declaration patterns (function name, const name, class name).
 *
 * @param node - The Tree-sitter syntax node.
 * @returns The extracted name, or null if not identifiable.
 */
function extractNodeName(node: Parser.SyntaxNode): string | null {
  // Direct name child (function_declaration, class_declaration)
  const nameChild = node.childForFieldName('name');
  if (nameChild) return nameChild.text;

  // For export statements, look at the declaration inside
  if (node.type === 'export_statement') {
    const declaration = node.childForFieldName('declaration');
    if (declaration) return extractNodeName(declaration);
  }

  // For lexical_declaration (const/let), extract the variable name
  if (node.type === 'lexical_declaration') {
    const declarator = node.namedChildren.find(
      (c) => c.type === 'variable_declarator'
    );
    if (declarator) {
      const name = declarator.childForFieldName('name');
      if (name) return name.text;
    }
  }

  return null;
}

/**
 * Parses a source file using Tree-sitter and extracts all top-level
 * structural nodes (functions, classes, exports, type declarations).
 *
 * @param sourceCode - The full source code text of the file.
 * @param filePath - The file path, used to determine the language grammar.
 * @returns An array of ASTNode objects, or an empty array if the language is unsupported.
 */
export function parseAndExtractNodes(
  sourceCode: string,
  filePath: string
): ASTNode[] {
  const ext = extname(filePath).toLowerCase();
  const language = LANGUAGE_MAP[ext];

  // Graceful degradation: if the language isn't supported, return empty
  if (!language) return [];

  const parser = new Parser();
  
  let actualLang: any = language;
  if (actualLang && actualLang.default) actualLang = actualLang.default;
  if (actualLang && actualLang.typescript && ext === '.ts') actualLang = actualLang.typescript;
  if (actualLang && actualLang.tsx && ext === '.tsx') actualLang = actualLang.tsx;
  
  try {
    parser.setLanguage(actualLang);
    const tree = parser.parse(sourceCode);
    const nodes: ASTNode[] = [];

  /**
   * Recursively traverses the AST to find structural nodes.
   * Stops descending once a structural node is found to prevent
   * extracting both a class and its individual methods separately.
   */
  function traverse(node: Parser.SyntaxNode, depth: number): void {
    if (STRUCTURAL_NODE_TYPES.has(node.type) && depth <= 2) {
      nodes.push({
        type: node.type,
        name: extractNodeName(node),
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

    // Cleanup: explicitly delete the tree to prevent memory leaks in Node.js bindings
    (tree as { delete?: () => void }).delete?.();

    return nodes;
  } catch (err) {
    console.error(`Error parsing tree-sitter for ${filePath}:`, err);
    return [];
  }
}

/**
 * Extracts the import/require statements from the top of a source file.
 * These are included as surrounding context in each code chunk so the AI
 * understands the module's dependencies.
 *
 * @param sourceCode - The full source code text.
 * @param filePath - The file path for language detection.
 * @returns A string containing all import statements, or empty if unsupported.
 */
export function extractImports(sourceCode: string, filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const language = LANGUAGE_MAP[ext];

  if (!language) return '';

  const parser = new Parser();

  // Apply the same language resolution logic as parseAndExtractNodes
  let actualLang: any = language;
  if (actualLang && actualLang.default) actualLang = actualLang.default;
  if (actualLang && actualLang.typescript && ext === '.ts') actualLang = actualLang.typescript;
  if (actualLang && actualLang.tsx && ext === '.tsx') actualLang = actualLang.tsx;

  try {
    parser.setLanguage(actualLang);

    const tree = parser.parse(sourceCode);
    const imports: string[] = [];

    for (const child of tree.rootNode.namedChildren) {
      if (child.type === 'import_statement' || child.type === 'import_declaration') {
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
