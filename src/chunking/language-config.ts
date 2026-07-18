/**
 * @module chunking/language-config
 * Language Configuration for Tree-sitter Parsing.
 *
 * Maps each supported file extension to:
 * - Its Tree-sitter grammar module for Node.js
 * - Structural AST node types used for chunking
 * - Import/require node types for context extraction
 * - Name extraction field names (varies per language)
 *
 * To add a new language:
 * 1. Install the tree-sitter-{language} npm package
 * 2. Import it below
 * 3. Add an entry to LANGUAGE_CONFIGS below
 * 4. Add the extension to EXTENSION_LANGUAGE_MAP in technology-detector.ts
 */


import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Go from 'tree-sitter-go';
import Rust from 'tree-sitter-rust';
import Java from 'tree-sitter-java';
import Ruby from 'tree-sitter-ruby';
import Php from 'tree-sitter-php';
import CPP from 'tree-sitter-cpp';
import C from 'tree-sitter-c';
import CSharp from 'tree-sitter-c-sharp';
import Kotlin from 'tree-sitter-kotlin';

/** Represents a structural node extracted from the AST */
export interface ASTNode {
  type: string;
  name: string | null;
  startLine: number;
  endLine: number;
  text: string;
}

/** Tree-sitter grammar type — using 'any' because the type definitions don't export Language */
type Grammar = any;

/**
 * Helper to resolve a Tree-sitter grammar module.
 * Handles both ESM default exports and CJS module.exports.
 */
function resolveGrammar(mod: any): Grammar {
  if (mod && typeof mod === 'object') {
    if (mod.default && typeof mod.default === 'object') {
      if (mod.default.typescript) return mod.default.typescript;
      return mod.default;
    }
    if (mod.typescript) return mod.typescript;
  }
  return mod;
}

const grammarCache = new Map<any, Grammar>();

function getGrammar(mod: any): Grammar {
  if (grammarCache.has(mod)) return grammarCache.get(mod)!;

  let resolved: Grammar;
  if (mod === TypeScript) {
    resolved = resolveGrammar(TypeScript);
  } else {
    resolved = resolveGrammar(mod);
  }

  grammarCache.set(mod, resolved);
  return resolved;
}

/**
 * Configuration for a single programming language.
 */
export interface LanguageConfig {
  name: string;
  grammar: Grammar;
  structuralNodeTypes: Set<string>;
  importNodeTypes: Set<string>;
  nameField: string;
  hasExportWrapper: boolean;
}

/**
 * All supported language configurations.
 */
export const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
  '.js': {
    name: 'JavaScript',
    grammar: getGrammar(JavaScript),
    structuralNodeTypes: new Set([
      'function_declaration',
      'arrow_function',
      'class_declaration',
      'method_definition',
      'export_statement',
      'lexical_declaration',
      'expression_statement',
      'generator_function_declaration',
    ]),
    importNodeTypes: new Set(['import_statement', 'import_declaration']),
    nameField: 'name',
    hasExportWrapper: true,
  },
  '.jsx': {
    name: 'JSX',
    grammar: getGrammar(JavaScript),
    structuralNodeTypes: new Set([
      'function_declaration',
      'arrow_function',
      'class_declaration',
      'method_definition',
      'export_statement',
      'lexical_declaration',
      'expression_statement',
    ]),
    importNodeTypes: new Set(['import_statement', 'import_declaration']),
    nameField: 'name',
    hasExportWrapper: true,
  },
  '.ts': {
    name: 'TypeScript',
    grammar: getGrammar(TypeScript),
    structuralNodeTypes: new Set([
      'function_declaration',
      'arrow_function',
      'class_declaration',
      'method_definition',
      'export_statement',
      'lexical_declaration',
      'expression_statement',
      'interface_declaration',
      'type_alias_declaration',
      'enum_declaration',
    ]),
    importNodeTypes: new Set(['import_statement', 'import_declaration']),
    nameField: 'name',
    hasExportWrapper: true,
  },
  '.tsx': {
    name: 'TSX',
    grammar: getGrammar(TypeScript),
    structuralNodeTypes: new Set([
      'function_declaration',
      'arrow_function',
      'class_declaration',
      'method_definition',
      'export_statement',
      'lexical_declaration',
      'expression_statement',
      'interface_declaration',
      'type_alias_declaration',
      'enum_declaration',
    ]),
    importNodeTypes: new Set(['import_statement', 'import_declaration']),
    nameField: 'name',
    hasExportWrapper: true,
  },
  '.py': {
    name: 'Python',
    grammar: getGrammar(Python),
    structuralNodeTypes: new Set([
      'function_definition',
      'class_definition',
      'decorated_definition',
      'assignment',
      'async_function_definition',
      'with_statement',
      'for_statement',
    ]),
    importNodeTypes: new Set([
      'import_statement',
      'import_from_statement',
      'future_import_statement',
    ]),
    nameField: 'name',
    hasExportWrapper: false,
  },
  '.go': {
    name: 'Go',
    grammar: getGrammar(Go),
    structuralNodeTypes: new Set([
      'function_declaration',
      'method_declaration',
      'type_declaration',
      'type_spec',
      'const_declaration',
      'var_declaration',
      'struct_type',
      'interface_type',
      'func_literal',
    ]),
    importNodeTypes: new Set(['import_declaration', 'import_spec']),
    nameField: 'name',
    hasExportWrapper: false,
  },
  '.rs': {
    name: 'Rust',
    grammar: getGrammar(Rust),
    structuralNodeTypes: new Set([
      'function_item',
      'struct_item',
      'enum_item',
      'trait_item',
      'impl_item',
      'const_item',
      'static_item',
      'type_item',
      'macro_invocation',
      'macro_definition',
      'union_item',
      'mod_item',
      'use_declaration',
    ]),
    importNodeTypes: new Set(['use_declaration']),
    nameField: 'name',
    hasExportWrapper: false,
  },
  '.java': {
    name: 'Java',
    grammar: getGrammar(Java),
    structuralNodeTypes: new Set([
      'class_declaration',
      'interface_declaration',
      'enum_declaration',
      'annotation_type_declaration',
      'method_declaration',
      'constructor_declaration',
      'record_declaration',
    ]),
    importNodeTypes: new Set(['import_declaration']),
    nameField: 'name',
    hasExportWrapper: false,
  },
  '.rb': {
    name: 'Ruby',
    grammar: getGrammar(Ruby),
    structuralNodeTypes: new Set([
      'method',
      'class',
      'module',
      'singleton_class',
      'singleton_method',
      'call',
      'block',
    ]),
    importNodeTypes: new Set(['require', 'require_relative', 'include_statement']),
    nameField: 'name',
    hasExportWrapper: false,
  },
  '.php': {
    name: 'PHP',
    grammar: getGrammar(Php),
    structuralNodeTypes: new Set([
      'function_definition',
      'method_declaration',
      'class_declaration',
      'interface_declaration',
      'trait_declaration',
      'enum_declaration',
      'anonymous_function_creation',
      'arrow_function',
    ]),
    importNodeTypes: new Set([
      'namespace_definition',
      'use_declaration',
      'include_expression',
    ]),
    nameField: 'name',
    hasExportWrapper: false,
  },
  '.cpp': {
    name: 'C++',
    grammar: getGrammar(CPP),
    structuralNodeTypes: new Set([
      'function_definition',
      'class_specifier',
      'struct_specifier',
      'union_specifier',
      'enum_specifier',
      'declaration',
      'template_declaration',
      'namespace_definition',
      'concept_definition',
      'requires_expression',
    ]),
    importNodeTypes: new Set(['preproc_include', 'using_declaration', 'namespace_alias_definition']),
    nameField: 'name',
    hasExportWrapper: false,
  },
  '.c': {
    name: 'C',
    grammar: getGrammar(C),
    structuralNodeTypes: new Set([
      'function_definition',
      'struct_specifier',
      'union_specifier',
      'enum_specifier',
      'declaration',
      'type_definition',
    ]),
    importNodeTypes: new Set(['preproc_include']),
    nameField: 'name',
    hasExportWrapper: false,
  },
  '.cs': {
    name: 'C#',
    grammar: getGrammar(CSharp),
    structuralNodeTypes: new Set([
      'class_declaration',
      'struct_declaration',
      'interface_declaration',
      'enum_declaration',
      'record_declaration',
      'method_declaration',
      'constructor_declaration',
      'namespace_declaration',
      'property_declaration',
    ]),
    importNodeTypes: new Set(['using_directive']),
    nameField: 'name',
    hasExportWrapper: false,
  },
  '.kt': {
    name: 'Kotlin',
    grammar: getGrammar(Kotlin),
    structuralNodeTypes: new Set([
      'class_body',
      'function_declaration',
      'property_declaration',
      'named_function',
      'anonymous_function',
      'object_declaration',
    ]),
    importNodeTypes: new Set(['import_header']),
    nameField: 'name',
    hasExportWrapper: false,
  },
};

/** File extensions that have Tree-sitter language support configured */
export const SUPPORTED_EXTENSIONS = new Set(Object.keys(LANGUAGE_CONFIGS));

/**
 * Gets the language configuration for a file extension.
 * The grammar is pre-resolved by getGrammar() during LANGUAGE_CONFIGS initialization.
 * For tree-sitter-typescript, getGrammar() resolves to the `.typescript` sub-grammar
 * which handles both .ts and .tsx files correctly.
 */
export function getLanguageConfig(ext: string): LanguageConfig | undefined {
  return LANGUAGE_CONFIGS[ext];
}
