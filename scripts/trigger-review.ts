import 'dotenv/config';
import { Octokit } from '@octokit/rest';
import { prisma } from '../src/db/prisma.js';
import { createQueues } from '../src/queue/queue-config.js';
import type { PullRequestEvent } from '../src/types/index.js';

async function main() {
  const prUrl = process.argv[2];
  if (!prUrl || !prUrl.includes('github.com')) {
    console.error('Usage: tsx scripts/trigger-review.ts <github-pr-url>');
    console.error('Example: tsx scripts/trigger-review.ts https://github.com/facebook/react/pull/28000');
    process.exit(1);
  }

  // Parse URL: https://github.com/owner/repo/pull/number
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) {
    console.error('Invalid GitHub PR URL format.');
    process.exit(1);
  }

  const [, owner, repo, prNumberStr] = match;
  const prNumber = parseInt(prNumberStr, 10);
  const fullName = `${owner}/${repo}`;

  console.log(`\n🔍 Fetching PR details for ${fullName} #${prNumber}...`);

  const token = process.env.GITHUB_TOKEN !== 'ghp_your_github_token_here' ? process.env.GITHUB_TOKEN : undefined;
  const octokit = new Octokit({ auth: token });

  let prData;
  let repoData;
  try {
    const { data: pr } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    prData = pr;

    const { data: repository } = await octokit.repos.get({
      owner,
      repo,
    });
    repoData = repository;
  } catch (error: unknown) {
    console.error('❌ Failed to fetch from GitHub API:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  console.log(`✅ Found PR: "${prData.title}" by @${prData.user?.login}`);

  const event: PullRequestEvent = {
    platform: 'github',
    repository: {
      id: String(repoData.id),
      fullName: repoData.full_name,
      cloneUrl: repoData.clone_url,
      defaultBranch: repoData.default_branch,
    },
    pullRequest: {
      number: prData.number,
      headSha: prData.head.sha,
      baseSha: prData.base.sha,
      title: prData.title,
      description: prData.body || '',
      author: prData.user?.login || 'unknown',
    },
    action: 'opened',
  };

  console.log('💾 Saving to local database for dashboard visualization...');

  // Ensure organization exists
  const organization = await prisma.organization.upsert({
    where: { id: owner },
    update: {},
    create: {
      id: owner,
      name: owner,
    },
  });

  // Ensure repository exists
  const dbRepo = await prisma.repository.upsert({
    where: { githubId: String(repoData.id) },
    update: {
      cloneUrl: repoData.clone_url,
      defaultBranch: repoData.default_branch,
    },
    create: {
      githubId: String(repoData.id),
      fullName: repoData.full_name,
      cloneUrl: repoData.clone_url,
      defaultBranch: repoData.default_branch,
      organizationId: organization.id,
    },
  });

  // Ensure PR exists
  await prisma.pullRequest.upsert({
    where: {
      repositoryId_prNumber: {
        repositoryId: dbRepo.id,
        prNumber: prData.number,
      },
    },
    update: {
      headSha: prData.head.sha,
      baseSha: prData.base.sha,
      title: prData.title,
      author: prData.user?.login || 'unknown',
      status: 'QUEUED',
    },
    create: {
      repositoryId: dbRepo.id,
      prNumber: prData.number,
      headSha: prData.head.sha,
      baseSha: prData.base.sha,
      title: prData.title,
      author: prData.user?.login || 'unknown',
      status: 'QUEUED',
    },
  });

  console.log('🚀 Enqueueing AI review job...');
  
  const queues = createQueues();
  const jobId = `manual-review-${repoData.id}-pr-${prData.number}-${Date.now()}`;

  await queues.reviewQueue.add(
    'pr-review',
    {
      event,
      state: 'QUEUED',
      timestamp: Date.now(),
    },
    { jobId }
  );

  console.log(`\n🎉 Success! Job ${jobId} has been enqueued.`);
  console.log('Ensure your backend server is running (npm run dev:server).');
  console.log('The worker will process this PR and the results will appear in your dashboard!\n');

  // Cleanup
  await Promise.all([
    queues.webhookQueue.close(),
    queues.reviewQueue.close(),
    queues.aiChunkQueue.close(),
    queues.publishQueue.close(),
    prisma.$disconnect()
  ]);
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
