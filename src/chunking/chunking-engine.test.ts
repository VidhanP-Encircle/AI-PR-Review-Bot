import { expect, test, describe } from 'vitest';
import { parseGitDiff } from '../adapters/github.adapter.js';
import { generateChunks } from './chunking-engine.js';

describe('Chunking Engine', () => {
  test('Pure deletion diff accurately generates a chunk anchored to context lines', () => {
    const diffText = `diff --git a/test.ts b/test.ts
index e69de29..d95f3ad 100644
--- a/test.ts
+++ b/test.ts
@@ -10,4 +10,1 @@
-function deletedFunction() {
-  console.log('deleted');
-}
 export const keep = true;
`;
    const diffFiles = parseGitDiff(diffText);
    const chunks = generateChunks(diffFiles, '/fake/path');
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.changedLines.length).toBeGreaterThan(0);
    // newStart for the context is 10. The deletion was replaced by line 10, so it should include line 10.
    expect(chunks[0]!.changedLines).toContain(10);
  });

  test('Pure deletion at the end of file (no trailing context)', () => {
    const diffText = `diff --git a/test.ts b/test.ts
index e69de29..d95f3ad 100644
--- a/test.ts
+++ b/test.ts
@@ -10,3 +10,0 @@
-function deletedFunction() {
-  console.log('deleted');
-}
`;
    const diffFiles = parseGitDiff(diffText);
    const chunks = generateChunks(diffFiles, '/fake/path');
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.changedLines).toContain(10); // fallback line
  });
});
