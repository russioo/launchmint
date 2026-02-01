/**
 * LaunchMint API
 * Token Launch for AI Agents on Solana
 * Supports: PumpFun | Bonk/USD1 | Bags.fm
 */

const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, VersionedTransaction, Transaction, SystemProgram } = require('@solana/web3.js');
const bs58 = require('bs58');
const FormData = require('form-data');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Config
const PORT = process.env.PORT || 3000;
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');

// Store launched tokens (in memory - use database in production)
const launchedTokens = [];
const wallets = new Map(); // Store generated wallets for claims

// ============================================
// HELPERS
// ============================================

function httpsRequest(hostname, reqPath, method, data = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      port: 443,
      path: reqPath,
      method,
      headers: { 'Content-Type': 'application/json', ...headers }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });

    req.on('error', reject);
    if (data) {
      const jsonData = JSON.stringify(data);
      req.setHeader('Content-Length', Buffer.byteLength(jsonData));
      req.write(jsonData);
    }
    req.end();
  });
}

async function uploadToPumpIPFS(imageUrl, name, symbol, description, twitter, telegram, website) {
  // Download image from URL
  const imageRes = await fetch(imageUrl);
  const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
  
  // Create form data for IPFS upload
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', imageBuffer, { filename: 'token.png', contentType: 'image/png' });
  form.append('name', name);
  form.append('symbol', symbol);
  form.append('description', description || '');
  form.append('twitter', twitter || '');
  form.append('telegram', telegram || '');
  form.append('website', website || '');
  form.append('showName', 'true');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'pump.fun',
      path: '/api/ipfs',
      method: 'POST',
      headers: form.getHeaders()
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('Failed to parse IPFS response'));
        }
      });
    });
    req.on('error', reject);
    form.pipe(req);
  });
}

async function uploadToBonkIPFS(imageUrl, name, symbol, description, website) {
  // Download image from URL
  const imageRes = await fetch(imageUrl);
  const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
  
  // Upload image first
  const FormData = require('form-data');
  const imgForm = new FormData();
  imgForm.append('image', imageBuffer, { filename: 'token.png', contentType: 'image/png' });

  const imgUri = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'nft-storage.letsbonk22.workers.dev',
      path: '/upload/img',
      method: 'POST',
      headers: imgForm.getHeaders()
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    imgForm.pipe(req);
  });

  // Upload metadata
  const metaRes = await httpsRequest('nft-storage.letsbonk22.workers.dev', '/upload/meta', 'POST', {
    createdOn: 'https://launchmint.xyz',
    description: description || '',
    image: imgUri,
    name,
    symbol,
    website: website || ''
  });

  return metaRes.data;
}

// ============================================
// LANDING PAGE
// ============================================
app.get('/', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <title>LaunchMint</title>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap');
    
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    :root {
      --bg: #0a0a0a;
      --fg: #e8e8e8;
      --dim: #666;
      --accent: #ff5c00;
      --border: #222;
    }
    
    body {
      font-family: 'IBM Plex Mono', monospace;
      background: var(--bg);
      color: var(--fg);
      font-size: 14px;
      line-height: 1.6;
    }
    
    a { color: var(--fg); text-decoration: none; }
    
    /* NAV */
    nav {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 100;
      padding: 20px 40px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border);
      background: var(--bg);
    }
    
    .logo {
      font-weight: 700;
      font-size: 16px;
      letter-spacing: -0.5px;
    }
    
    .logo span { color: var(--accent); }
    
    .nav-links {
      display: flex;
      gap: 40px;
      align-items: center;
    }
    
    .nav-links a {
      color: var(--dim);
      font-size: 13px;
      transition: color 0.15s;
    }
    
    .nav-links a:hover { color: var(--fg); }
    
    .nav-btn {
      background: transparent;
      color: var(--accent);
      border: 1px solid var(--accent);
      padding: 8px 16px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      transition: all 0.15s;
    }
    
    .nav-btn:hover {
      background: var(--accent);
      color: var(--bg);
    }
    
    /* MAIN */
    main {
      max-width: 900px;
      margin: 0 auto;
      padding: 160px 40px 100px;
    }
    
    /* HERO */
    .hero {
      margin-bottom: 120px;
    }
    
    .hero-label {
      color: var(--accent);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 2px;
      margin-bottom: 24px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    .hero-label::before {
      content: '';
      width: 40px;
      height: 1px;
      background: var(--accent);
    }
    
    h1 {
      font-size: clamp(32px, 6vw, 56px);
      font-weight: 700;
      line-height: 1.1;
      letter-spacing: -1px;
      margin-bottom: 32px;
    }
    
    .hero-desc {
      color: var(--dim);
      font-size: 16px;
      max-width: 500px;
      margin-bottom: 48px;
    }
    
    .hero-actions {
      display: flex;
      gap: 16px;
    }
    
    .btn {
      padding: 14px 28px;
      font-family: inherit;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--fg);
      cursor: pointer;
      transition: all 0.15s;
      text-decoration: none;
      display: inline-block;
    }
    
    .btn:hover {
      border-color: var(--fg);
    }
    
    .btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    
    .btn-primary:hover {
      background: #ff7a33;
      border-color: #ff7a33;
    }
    
    /* FEATURES */
    .features {
      margin-bottom: 120px;
    }
    
    .section-label {
      color: var(--dim);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 2px;
      margin-bottom: 40px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    
    .feature-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1px;
      background: var(--border);
      border: 1px solid var(--border);
    }
    
    @media (max-width: 700px) {
      .feature-grid { grid-template-columns: 1fr; }
    }
    
    .feature {
      background: var(--bg);
      padding: 32px;
    }
    
    .feature-num {
      color: var(--accent);
      font-size: 11px;
      margin-bottom: 16px;
    }
    
    .feature h3 {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 12px;
    }
    
    .feature p {
      color: var(--dim);
      font-size: 13px;
    }
    
    /* PLATFORMS */
    .platforms {
      margin-bottom: 120px;
    }
    
    .platform-list {
      display: flex;
      flex-direction: column;
    }
    
    .platform {
      display: grid;
      grid-template-columns: 120px 1fr auto;
      gap: 40px;
      align-items: center;
      padding: 32px 0;
      border-bottom: 1px solid var(--border);
    }
    
    @media (max-width: 600px) {
      .platform {
        grid-template-columns: 1fr;
        gap: 16px;
      }
    }
    
    .platform-name {
      font-weight: 600;
    }
    
    .platform-desc {
      color: var(--dim);
      font-size: 13px;
    }
    
    .platform-tag {
      color: var(--accent);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    
    /* CODE */
    .code-section {
      margin-bottom: 120px;
    }
    
    .code-block {
      background: #050505;
      border: 1px solid var(--border);
      overflow: hidden;
    }
    
    .code-header {
      padding: 16px 24px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .code-file {
      color: var(--dim);
      font-size: 12px;
    }
    
    .code-lang {
      color: var(--accent);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    
    .code-body {
      padding: 24px;
      font-size: 13px;
      line-height: 1.8;
      overflow-x: auto;
    }
    
    .code-body .c { color: #666; }
    .code-body .k { color: var(--accent); }
    .code-body .s { color: #98c379; }
    .code-body .p { color: #e8e8e8; }
    
    /* SKILL */
    .skill-box {
      display: flex;
      gap: 12px;
      max-width: 600px;
    }
    
    .skill-box input {
      flex: 1;
      background: #050505;
      border: 1px solid var(--border);
      padding: 14px 16px;
      color: var(--fg);
      font-family: inherit;
      font-size: 13px;
      outline: none;
    }
    
    .skill-box input:focus {
      border-color: var(--accent);
    }
    
    .skill-box button {
      background: var(--accent);
      border: none;
      padding: 14px 24px;
      color: #fff;
      font-family: inherit;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      cursor: pointer;
      transition: background 0.15s;
    }
    
    .skill-box button:hover {
      background: #ff7a33;
    }
    
    .hero-skill {
      margin-top: 48px;
      width: 100%;
    }
    
    /* FOOTER */
    footer {
      padding: 40px 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: var(--dim);
      font-size: 12px;
    }
    
    footer a {
      color: var(--dim);
      margin-left: 24px;
      transition: color 0.15s;
    }
    
    footer a:hover { color: var(--accent); }
  </style>
</head>
<body>
  <nav>
    <div class="logo">Launch<span>Mint</span></div>
    <div class="nav-links">
      <a href="#features">Features</a>
      <a href="#platforms">Platforms</a>
      <a href="/api/tokens">Tokens</a>
      <a href="/skill.md" class="nav-btn">Get Skill</a>
    </div>
  </nav>
  
  <main>
    <section class="hero">
      <div class="hero-label">Token Infrastructure</div>
      <h1>One API for PumpFun, USD1, and Bags.fm</h1>
      <p class="hero-desc">Deploy tokens across three Solana launchpads. We handle wallets, metadata, and on-chain deployment. Works with any AI agent.</p>
      <div class="hero-actions">
        <a href="/skill.md" class="btn btn-primary">Get Started</a>
        <a href="#features" class="btn">Documentation</a>
      </div>
      
      <div class="skill-box hero-skill">
        <input type="text" value="${baseUrl}/skill.md" readonly id="skillUrl">
        <button onclick="copySkill()" id="copyBtn">Copy</button>
      </div>
    </section>
    
    <section class="features" id="features">
      <div class="section-label">What we handle</div>
      <div class="feature-grid">
        <div class="feature">
          <div class="feature-num">01</div>
          <h3>Wallet Generation</h3>
          <p>Solana keypairs created automatically. Export private keys anytime.</p>
        </div>
        <div class="feature">
          <div class="feature-num">02</div>
          <h3>IPFS Storage</h3>
          <p>Token images and metadata uploaded to decentralized storage.</p>
        </div>
        <div class="feature">
          <div class="feature-num">03</div>
          <h3>On-chain Deploy</h3>
          <p>Transactions built and signed server-side. Live in under 5 seconds.</p>
        </div>
        <div class="feature">
          <div class="feature-num">04</div>
          <h3>Fee Sharing</h3>
          <p>Split earnings with up to 100 collaborators on Bags.fm.</p>
        </div>
        <div class="feature">
          <div class="feature-num">05</div>
          <h3>Social Verify</h3>
          <p>Claim token ownership by connecting Twitter/X account.</p>
        </div>
        <div class="feature">
          <div class="feature-num">06</div>
          <h3>Multi-platform</h3>
          <p>Deploy to PumpFun, USD1/Bonk, or Bags.fm from one endpoint.</p>
        </div>
      </div>
    </section>
    
    <section class="platforms" id="platforms">
      <div class="section-label">Supported Platforms</div>
      <div class="platform-list">
        <div class="platform">
          <div class="platform-name">PumpFun</div>
          <div class="platform-desc">Instant memecoin launches with SOL trading pairs</div>
          <div class="platform-tag">Quote: SOL</div>
        </div>
        <div class="platform">
          <div class="platform-name">USD1 / Bonk</div>
          <div class="platform-desc">Stablecoin pairs via Raydium, no SOL volatility</div>
          <div class="platform-tag">Quote: USD1</div>
        </div>
        <div class="platform">
          <div class="platform-name">Bags.fm</div>
          <div class="platform-desc">Fee sharing with collaborators, social wallet lookup</div>
          <div class="platform-tag">Quote: SOL</div>
        </div>
      </div>
    </section>
    
    <section class="code-section">
      <div class="section-label">Example</div>
      <div class="code-block">
        <div class="code-header">
          <span class="code-file">launch.js</span>
          <span class="code-lang">JavaScript</span>
        </div>
        <div class="code-body">
<span class="c">// Launch a token with one request</span>
<span class="k">const</span> response = <span class="k">await</span> fetch(<span class="s">'${baseUrl}/api/tokens/create'</span>, {
  <span class="p">method:</span> <span class="s">'POST'</span>,
  <span class="p">headers:</span> { <span class="s">'Content-Type'</span>: <span class="s">'application/json'</span> },
  <span class="p">body:</span> JSON.stringify({
    <span class="p">platform:</span> <span class="s">'pumpfun'</span>,
    <span class="p">name:</span> <span class="s">'MyToken'</span>,
    <span class="p">symbol:</span> <span class="s">'MTK'</span>,
    <span class="p">image:</span> <span class="s">'https://example.com/logo.png'</span>,
    <span class="p">apiKey:</span> <span class="s">'your-pumpportal-key'</span>
  })
});

<span class="k">const</span> { tokenAddress, url } = <span class="k">await</span> response.json();
        </div>
      </div>
    </section>
    
    
    <footer>
      <span>&copy; 2026 launchmint.fun</span>
      <div>
        <a href="/skill.md">Docs</a>
        <a href="/health">Status</a>
        <a href="/api/tokens">Tokens</a>
      </div>
    </footer>
  </main>
  
  <script>
    function copySkill() {
      navigator.clipboard.writeText(document.getElementById('skillUrl').value);
      const btn = document.getElementById('copyBtn');
      btn.textContent = 'Copied';
      setTimeout(() => btn.textContent = 'Copy', 2000);
    }
  </script>
</body>
</html>
  `);
});

// ============================================
// SKILL.MD - For AI Agents
// ============================================
app.get('/skill.md', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  
  res.type('text/markdown').send(`---
name: launchmint
description: Launch tokens on Solana via LaunchMint API. Supports PumpFun, Bonk/USD1, and Bags.fm. Use when creating tokens, launching memecoins, or deploying tokens programmatically.
---

# LaunchMint 🚀

Launch tokens on Solana. Works with PumpFun, USD1/Bonk, and Bags.fm.

**Base URL:** \`${baseUrl}\`

---

## Supported Platforms

| Platform | API Key | Quote | Best For |
|----------|---------|-------|----------|
| \`pumpfun\` | PumpPortal | SOL | Quick memecoin launches |
| \`bonk\` | PumpPortal | USD1 | Stable pricing |
| \`bags\` | Bags.fm | SOL | Fee sharing with collaborators |

---

## API Keys Required

Each platform requires its own API key:

### PumpFun & Bonk/USD1
Get API key from: https://pumpportal.fun/trading-api/setup/

### Bags.fm
Get API key from: https://dev.bags.fm

---

## Launch a Token

\`\`\`http
POST ${baseUrl}/api/tokens/create
Content-Type: application/json
\`\`\`

### Request Body

\`\`\`json
{
  "platform": "pumpfun",
  "name": "MyToken",
  "symbol": "MTK",
  "description": "My awesome token",
  "image": "https://example.com/token.png",
  "creatorWallet": "YourSolanaWalletAddress",
  "apiKey": "your-platform-api-key",
  "privateKey": "your-base58-private-key",
  "twitter": "https://twitter.com/mytoken",
  "telegram": "https://t.me/mytoken",
  "website": "https://mytoken.com",
  "initialBuyAmount": 0.1
}
\`\`\`

### Parameters

| Field | Required | Description |
|-------|----------|-------------|
| \`platform\` | Yes | \`pumpfun\`, \`bonk\`, or \`bags\` |
| \`name\` | Yes | Token name (max 32 chars) |
| \`symbol\` | Yes | Token symbol (max 10 chars) |
| \`description\` | No | Token description |
| \`image\` | Yes | URL to token image (PNG/JPG) |
| \`creatorWallet\` | Yes | Solana wallet to receive fees |
| \`apiKey\` | Yes | Platform API key |
| \`privateKey\` | Yes* | Base58 private key for signing (*not needed for PumpPortal Lightning API) |
| \`twitter\` | No | Twitter URL |
| \`telegram\` | No | Telegram URL |
| \`website\` | No | Website URL |
| \`initialBuyAmount\` | No | Initial dev buy in SOL (default: 0) |
| \`feeClaimers\` | No | Bags.fm only - array of fee share recipients |

### Response

\`\`\`json
{
  "success": true,
  "platform": "pumpfun",
  "tokenAddress": "TokenMint...",
  "txHash": "TxSignature...",
  "url": "https://pump.fun/TokenMint..."
}
\`\`\`

---

## Platform-Specific Examples

### PumpFun Launch

\`\`\`javascript
const response = await fetch('${baseUrl}/api/tokens/create', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    platform: 'pumpfun',
    name: 'MyMemeCoin',
    symbol: 'MEME',
    description: 'The best memecoin ever',
    image: 'https://example.com/meme.png',
    creatorWallet: 'YourWallet...',
    apiKey: 'your-pumpportal-api-key',
    initialBuyAmount: 0.5  // Dev buy 0.5 SOL
  })
});
\`\`\`

### USD1/Bonk Launch

\`\`\`javascript
const response = await fetch('${baseUrl}/api/tokens/create', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    platform: 'bonk',
    name: 'StableToken',
    symbol: 'STABLE',
    description: 'USD1 paired token',
    image: 'https://example.com/stable.png',
    creatorWallet: 'YourWallet...',
    apiKey: 'your-pumpportal-api-key',
    initialBuyAmount: 1  // Dev buy 1 SOL worth
  })
});
\`\`\`

### Bags.fm Launch (with Fee Sharing)

\`\`\`javascript
const response = await fetch('${baseUrl}/api/tokens/create', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    platform: 'bags',
    name: 'CollabToken',
    symbol: 'COLLAB',
    description: 'Token with fee sharing',
    image: 'https://example.com/collab.png',
    creatorWallet: 'YourWallet...',
    apiKey: 'your-bags-api-key',
    privateKey: 'your-base58-private-key',
    initialBuyAmount: 0.01,
    feeClaimers: [
      { provider: 'twitter', username: 'collaborator1', bps: 3000 },
      { provider: 'twitter', username: 'collaborator2', bps: 2000 }
      // Creator gets remaining 50% (5000 bps)
    ]
  })
});
\`\`\`

---

## Other Endpoints

### List Tokens
\`\`\`http
GET ${baseUrl}/api/tokens
\`\`\`

### Health Check
\`\`\`http
GET ${baseUrl}/health
\`\`\`

### Wallet Lookup (Bags.fm)
\`\`\`http
GET ${baseUrl}/api/wallet/lookup?username=twitterhandle&provider=twitter
\`\`\`

---

## Error Handling

\`\`\`json
{
  "success": false,
  "error": "Error message here"
}
\`\`\`

Common errors:
- \`platform required\` - Missing platform field
- \`apiKey required\` - Missing API key for platform
- \`name and symbol required\` - Missing token details
- \`image required\` - Missing image URL

---

## cURL Example

\`\`\`bash
curl -X POST ${baseUrl}/api/tokens/create \\
  -H "Content-Type: application/json" \\
  -d '{
    "platform": "pumpfun",
    "name": "TestToken",
    "symbol": "TEST",
    "description": "A test token",
    "image": "https://example.com/test.png",
    "creatorWallet": "YourWallet...",
    "apiKey": "your-api-key"
  }'
\`\`\`

---

## Python Example

\`\`\`python
import requests

response = requests.post('${baseUrl}/api/tokens/create', json={
    'platform': 'pumpfun',
    'name': 'PythonToken',
    'symbol': 'PYTH',
    'description': 'Launched from Python',
    'image': 'https://example.com/python.png',
    'creatorWallet': 'YourWallet...',
    'apiKey': 'your-api-key'
})

data = response.json()
if data['success']:
    print(f"Token: {data['tokenAddress']}")
    print(f"URL: {data['url']}")
else:
    print(f"Error: {data['error']}")
\`\`\`
`);
});

// ============================================
// CREATE TOKEN
// ============================================
app.post('/api/tokens/create', async (req, res) => {
  try {
    const { 
      platform,
      name, 
      symbol, 
      description,
      image,
      creatorWallet,
      apiKey,
      privateKey,
      twitter,
      telegram,
      website,
      initialBuyAmount = 0,
      feeClaimers
    } = req.body;

    // Validate required fields
    if (!platform) {
      return res.status(400).json({ success: false, error: 'platform required (pumpfun, bonk, or bags)' });
    }
    if (!name || !symbol) {
      return res.status(400).json({ success: false, error: 'name and symbol required' });
    }
    if (!image) {
      return res.status(400).json({ success: false, error: 'image URL required' });
    }
    if (!apiKey) {
      return res.status(400).json({ success: false, error: 'apiKey required for platform' });
    }

    // Normalize platform
    const normalizedPlatform = platform.toLowerCase() === 'pump' ? 'pumpfun' : 
                               platform.toLowerCase() === 'usd1' ? 'bonk' : 
                               platform.toLowerCase();

    const validPlatforms = ['pumpfun', 'bonk', 'bags'];
    if (!validPlatforms.includes(normalizedPlatform)) {
      return res.status(400).json({ success: false, error: 'Invalid platform. Use: pumpfun, bonk, or bags' });
    }

    let result;

    if (normalizedPlatform === 'pumpfun') {
      result = await launchOnPumpFun({
        name, symbol, description, image, twitter, telegram, website,
        creatorWallet, apiKey, privateKey, initialBuyAmount
      });
    } else if (normalizedPlatform === 'bonk') {
      result = await launchOnBonk({
        name, symbol, description, image, twitter, telegram, website,
        creatorWallet, apiKey, privateKey, initialBuyAmount
      });
    } else if (normalizedPlatform === 'bags') {
      result = await launchOnBags({
        name, symbol, description, image, twitter, telegram, website,
        creatorWallet, apiKey, privateKey, initialBuyAmount, feeClaimers
      });
    }

    if (result.success) {
      const tokenData = {
        platform: normalizedPlatform,
        name,
        symbol,
        tokenAddress: result.tokenAddress,
        txHash: result.txHash,
        url: result.url,
        creatorWallet,
        launchedAt: new Date().toISOString()
      };
      launchedTokens.push(tokenData);

      res.json({
        success: true,
        platform: normalizedPlatform,
        tokenAddress: result.tokenAddress,
        txHash: result.txHash,
        url: result.url
      });
    } else {
      res.status(400).json({ success: false, error: result.error });
    }

  } catch (error) {
    console.error('Create token error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// LIST TOKENS
// ============================================
app.get('/api/tokens', (req, res) => {
  res.json({
    success: true,
    count: launchedTokens.length,
    tokens: launchedTokens
  });
});

// ============================================
// WALLET LOOKUP (Bags.fm)
// ============================================
app.get('/api/wallet/lookup', async (req, res) => {
  try {
    const { username, provider = 'twitter' } = req.query;
    
    if (!username) {
      return res.status(400).json({ success: false, error: 'username required' });
    }

    const response = await httpsRequest(
      'public-api-v2.bags.fm',
      `/api/v1/state/launch-wallet-v2?username=${encodeURIComponent(username)}&provider=${provider}`,
      'GET'
    );

    if (response.status === 200 && response.data.success) {
      res.json({
        success: true,
        wallet: response.data.response.wallet,
        username,
        provider
      });
    } else {
      res.status(400).json({ success: false, error: 'Wallet not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
  res.json({
    name: 'LaunchMint',
    version: '1.0.0',
    status: 'ok',
    platforms: ['pumpfun', 'bonk', 'bags'],
    tokensLaunched: launchedTokens.length
  });
});

// ============================================
// PLATFORM LAUNCHERS
// ============================================

async function launchOnPumpFun({ name, symbol, description, image, twitter, telegram, website, creatorWallet, apiKey, privateKey, initialBuyAmount }) {
  try {
    // Generate mint keypair
    const mintKeypair = Keypair.generate();
    
    // Upload to IPFS
    console.log('Uploading to IPFS...');
    const ipfsResult = await uploadToPumpIPFS(image, name, symbol, description, twitter, telegram, website);
    
    if (!ipfsResult.metadataUri) {
      return { success: false, error: 'Failed to upload metadata to IPFS' };
    }
    
    console.log('IPFS URI:', ipfsResult.metadataUri);

    // Create token via PumpPortal Lightning API
    const tradeResponse = await httpsRequest(
      'pumpportal.fun',
      `/api/trade?api-key=${apiKey}`,
      'POST',
      {
        action: 'create',
        tokenMetadata: {
          name,
          symbol,
          uri: ipfsResult.metadataUri
        },
        mint: bs58.encode(mintKeypair.secretKey),
        denominatedInSol: 'true',
        amount: initialBuyAmount || 0,
        slippage: 10,
        priorityFee: 0.0005,
        pool: 'pump'
      }
    );

    if (tradeResponse.status === 200 && tradeResponse.data.signature) {
      return {
        success: true,
        tokenAddress: mintKeypair.publicKey.toBase58(),
        txHash: tradeResponse.data.signature,
        url: `https://pump.fun/${mintKeypair.publicKey.toBase58()}`
      };
    } else {
      return { success: false, error: tradeResponse.data.message || 'PumpPortal API error' };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function launchOnBonk({ name, symbol, description, image, twitter, telegram, website, creatorWallet, apiKey, privateKey, initialBuyAmount }) {
  try {
    // Generate mint keypair
    const mintKeypair = Keypair.generate();
    
    // Upload to Bonk IPFS
    console.log('Uploading to Bonk IPFS...');
    const metadataUri = await uploadToBonkIPFS(image, name, symbol, description, website);
    
    console.log('Metadata URI:', metadataUri);

    // Create token via PumpPortal Lightning API with Bonk pool
    const tradeResponse = await httpsRequest(
      'pumpportal.fun',
      `/api/trade?api-key=${apiKey}`,
      'POST',
      {
        action: 'create',
        tokenMetadata: {
          name,
          symbol,
          uri: metadataUri
        },
        mint: bs58.encode(mintKeypair.secretKey),
        denominatedInSol: 'true',
        amount: initialBuyAmount || 0,
        slippage: 10,
        priorityFee: 0.0005,
        pool: 'bonk',
        quoteMint: 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB'
      }
    );

    if (tradeResponse.status === 200 && tradeResponse.data.signature) {
      return {
        success: true,
        tokenAddress: mintKeypair.publicKey.toBase58(),
        txHash: tradeResponse.data.signature,
        url: `https://bonk.fun/${mintKeypair.publicKey.toBase58()}`
      };
    } else {
      return { success: false, error: tradeResponse.data.message || 'PumpPortal API error' };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function launchOnBags({ name, symbol, description, image, twitter, telegram, website, creatorWallet, apiKey, privateKey, initialBuyAmount, feeClaimers }) {
  try {
    if (!privateKey) {
      return { success: false, error: 'privateKey required for Bags.fm launch' };
    }

    const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
    
    // Step 1: Create token info and metadata
    console.log('Creating Bags.fm token metadata...');
    const metadataResponse = await httpsRequest(
      'public-api-v2.bags.fm',
      '/api/v1/token-launch/create-token-info',
      'POST',
      {
        imageUrl: image,
        name,
        description: description || '',
        symbol: symbol.toUpperCase().replace('$', ''),
        twitter: twitter || undefined,
        website: website || undefined,
        telegram: telegram || undefined
      },
      { 'x-api-key': apiKey }
    );

    if (!metadataResponse.data.success) {
      return { success: false, error: metadataResponse.data.error || 'Failed to create metadata' };
    }

    const tokenMint = metadataResponse.data.response.tokenMint;
    const tokenMetadata = metadataResponse.data.response.tokenMetadata;
    
    console.log('Token mint:', tokenMint);

    // Step 2: Build fee claimers array
    let feeClaimersArray = [];
    
    if (feeClaimers && feeClaimers.length > 0) {
      const feeClaimersBps = feeClaimers.reduce((sum, fc) => sum + fc.bps, 0);
      const creatorBps = 10000 - feeClaimersBps;
      
      if (creatorBps < 0) {
        return { success: false, error: 'Total fee claimer BPS cannot exceed 10000' };
      }
      
      if (creatorBps > 0) {
        feeClaimersArray.push({
          user: keypair.publicKey.toBase58(),
          userBps: creatorBps
        });
      }
      
      // Lookup fee claimer wallets
      for (const fc of feeClaimers) {
        const walletResponse = await httpsRequest(
          'public-api-v2.bags.fm',
          `/api/v1/state/launch-wallet-v2?username=${encodeURIComponent(fc.username)}&provider=${fc.provider}`,
          'GET',
          null,
          { 'x-api-key': apiKey }
        );
        
        if (walletResponse.data.success) {
          feeClaimersArray.push({
            user: walletResponse.data.response.wallet,
            userBps: fc.bps
          });
        }
      }
    } else {
      // Creator gets all fees
      feeClaimersArray = [{
        user: keypair.publicKey.toBase58(),
        userBps: 10000
      }];
    }

    // Step 3: Create fee share config
    console.log('Creating fee share config...');
    const configResponse = await httpsRequest(
      'public-api-v2.bags.fm',
      '/api/v1/config/create-bags-fee-share-config',
      'POST',
      {
        payer: keypair.publicKey.toBase58(),
        baseMint: tokenMint,
        feeClaimers: feeClaimersArray
      },
      { 'x-api-key': apiKey }
    );

    if (!configResponse.data.success) {
      return { success: false, error: configResponse.data.error || 'Failed to create config' };
    }

    // Sign and send config transactions
    const configTxs = configResponse.data.response.transactions || [];
    for (const txBase58 of configTxs) {
      const tx = VersionedTransaction.deserialize(bs58.decode(txBase58));
      tx.sign([keypair]);
      
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      await connection.confirmTransaction(sig, 'confirmed');
    }

    const configKey = configResponse.data.response.meteoraConfigKey;
    console.log('Config key:', configKey);

    // Step 4: Create launch transaction
    console.log('Creating launch transaction...');
    const launchResponse = await httpsRequest(
      'public-api-v2.bags.fm',
      '/api/v1/token-launch/create-launch-transaction',
      'POST',
      {
        metadataUrl: tokenMetadata,
        tokenMint: tokenMint,
        launchWallet: keypair.publicKey.toBase58(),
        initialBuyLamports: Math.floor((initialBuyAmount || 0.01) * LAMPORTS_PER_SOL),
        configKey: configKey
      },
      { 'x-api-key': apiKey }
    );

    if (!launchResponse.data.success) {
      return { success: false, error: launchResponse.data.error || 'Failed to create launch tx' };
    }

    // Sign and send launch transaction
    const launchTx = VersionedTransaction.deserialize(bs58.decode(launchResponse.data.response.transaction));
    launchTx.sign([keypair]);
    
    const signature = await connection.sendRawTransaction(launchTx.serialize(), { skipPreflight: true });
    await connection.confirmTransaction(signature, 'confirmed');

    return {
      success: true,
      tokenAddress: tokenMint,
      txHash: signature,
      url: `https://bags.fm/${tokenMint}`
    };

  } catch (error) {
    console.error('Bags launch error:', error);
    return { success: false, error: error.message };
  }
}

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║                                                                ║
║     🚀  L A U N C H M I N T  🚀                                ║
║     Token Launch API for AI Agents                             ║
║                                                                ║
╠════════════════════════════════════════════════════════════════╣
║                                                                ║
║  URL:      http://localhost:${PORT}                              ║
║  Skill:    http://localhost:${PORT}/skill.md                     ║
║                                                                ║
╠════════════════════════════════════════════════════════════════╣
║                                                                ║
║  Platforms:  PumpFun  |  Bonk/USD1  |  Bags.fm                 ║
║                                                                ║
╠════════════════════════════════════════════════════════════════╣
║                                                                ║
║  Endpoints:                                                    ║
║    GET   /              Landing page                           ║
║    GET   /skill.md      AI agent skill                         ║
║    GET   /health        Health check                           ║
║    POST  /api/tokens/create   Launch token                     ║
║    GET   /api/tokens    List tokens                            ║
║    GET   /api/wallet/lookup   Bags wallet lookup               ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
