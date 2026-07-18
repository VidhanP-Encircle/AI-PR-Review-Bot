import crypto from 'node:crypto';

async function simulateWebhook() {
  const secret = process.env.GITHUB_WEBHOOK_SECRET || 'your_webhook_secret_here';

  const payload = {
    action: 'opened',
    pull_request: {
      number: 99,
      title: 'Introduce Syntax Error',
      body: 'Testing Tree-sitter error recovery.',
      user: { login: 'tester' },
      head: { sha: '4ffc78d177d3558f0ac4a208cb9d855c61a4a77d' },
      base: { sha: 'a61ea9acb5d0ce227213a06c911770daa9efecae' }
    },
    repository: {
      id: 999999,
      full_name: 'local/syntax-test-repo',
      clone_url: 'file:///tmp/syntax-test-repo',
      default_branch: 'master'
    }
  };

  const body = JSON.stringify(payload);
  const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

  console.log('Sending webhook to http://localhost:3001/api/v1/webhooks/github');

  const response = await fetch('http://localhost:3001/api/v1/webhooks/github', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hub-signature-256': signature,
      'x-github-event': 'pull_request',
    },
    body,
  });

  if (response.ok) {
    const data = await response.json();
    console.log('✅ Webhook accepted!');
    console.log(data);
    console.log('\nThe webhook has been successfully queued in BullMQ!');
    console.log('Check the terminal running your backend server to watch the workers process the PR.');
  } else {
    const text = await response.text();
    console.error(`❌ Webhook failed: ${response.status} ${response.statusText}`);
    console.error(text);
  }
}

simulateWebhook().catch(console.error);
