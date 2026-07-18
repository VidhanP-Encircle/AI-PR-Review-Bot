import { expect, test, describe, vi } from 'vitest';
import { runRuleEngine } from './rule-engine.js';
import { parseGitDiff } from '../adapters/github.adapter.js';
import child_process from 'node:child_process';

vi.mock('node:child_process');

describe('Rule Engine - Dangling References', () => {
  test('Cross-file dangling reference flagged correctly', () => {
    const diffText = `diff --git a/deleted.ts b/deleted.ts
index e69de29..d95f3ad 100644
--- a/deleted.ts
+++ b/deleted.ts
@@ -1,3 +1,0 @@
-export function ensureFileIsPassed() {
-  return true;
-}
`;
    const diffFiles = parseGitDiff(diffText);

    // Mock git grep to simulate finding it in another file
    vi.mocked(child_process.execSync).mockReturnValue(
      'src/other.ts:15:ensureFileIsPassed();\n'
    );

    const { findings } = runRuleEngine(diffFiles, '/fake/worktree');
    
    const danglingFindings = findings.filter(f => f.ruleId === 'DANG-001');
    expect(danglingFindings.length).toBe(1);
    expect(danglingFindings[0]!.filePath).toBe('src/other.ts');
    expect(danglingFindings[0]!.message).toContain("ensureFileIsPassed");
  });

  test('False-positive mitigation: ignore re-declarations', () => {
    const diffText = `diff --git a/moved.ts b/moved.ts
index e69de29..d95f3ad 100644
--- a/moved.ts
+++ b/moved.ts
@@ -1,3 +1,0 @@
-export const myVar = 42;
`;
    const diffFiles = parseGitDiff(diffText);

    // Mock git grep to simulate finding it as a declaration (rename/move)
    vi.mocked(child_process.execSync).mockReturnValue(
      'src/new-moved.ts:10:export const myVar = 42;\n' + 
      'src/other.ts:2:import { myVar } from "./new-moved";\n'
    );

    const { findings } = runRuleEngine(diffFiles, '/fake/worktree');
    const danglingFindings = findings.filter(f => f.ruleId === 'DANG-001');
    expect(danglingFindings.length).toBe(0); // Should be ignored
  });
});
