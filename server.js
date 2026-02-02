/**
 * LaunchMint API
 * Token Launch for AI Agents on Solana
 * Supports: PumpFun | Bags.fm | USD1/Bonk.fun
 */

const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, VersionedTransaction, Transaction, TransactionMessage } = require('@solana/web3.js');
const { PumpSdk, getBuyTokenAmountFromSolAmount } = require('@pump-fun/pump-sdk');
const { Raydium, TxVersion, LaunchpadConfig, LAUNCHPAD_PROGRAM } = require('@raydium-io/raydium-sdk-v2');
const { getAssociatedTokenAddress, getAccount } = require('@solana/spl-token');
const BN = require('bn.js');
const bs58 = require('bs58');
const FormData = require('form-data');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Config
const PORT = process.env.PORT || 3000;
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');

// Initialize Pump SDK
const pumpSdk = new PumpSdk(connection);

// USD1/Bonk.fun Constants
const USD1_MINT = new PublicKey("USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB");
const USD1_CONFIG = new PublicKey("EPiZbnrThjyLnoQ6QQzkxeFqyL5uyg9RzNHHAudUPxBz");
const BONK_PLATFORM_ID = new PublicKey("FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const JUP_API = "https://lite-api.jup.ag/swap/v1";

// Store launched tokens (in memory - use database in production)
const launchedTokens = [];

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

// USD1 Helper: Get USD1 balance
async function getUsd1Balance(owner) {
  try {
    const ata = await getAssociatedTokenAddress(USD1_MINT, owner);
    const account = await getAccount(connection, ata);
    return Number(account.amount) / 1_000_000; // 6 decimals
  } catch {
    return 0;
  }
}

// USD1 Helper: Swap SOL to USD1 via Jupiter
async function swapSolToUsd1(wallet, usd1Amount) {
  if (usd1Amount <= 0) return "";
  
  console.log(`[USD1] Swapping SOL → ${usd1Amount} USD1...`);
  
  const outAmount = Math.ceil(usd1Amount * 1_000_000);
  
  // Get quote
  const quoteRes = await fetch(
    `${JUP_API}/quote?inputMint=${WSOL_MINT.toBase58()}&outputMint=${USD1_MINT.toBase58()}&amount=${outAmount}&swapMode=ExactOut&slippageBps=150`
  );
  if (!quoteRes.ok) throw new Error(`Jupiter quote failed: ${quoteRes.statusText}`);
  const quote = await quoteRes.json();
  
  console.log(`[USD1] Will spend ~${(Number(quote.inAmount) / 1e9).toFixed(4)} SOL`);
  
  // Get swap transaction
  const swapRes = await fetch(`${JUP_API}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  if (!swapRes.ok) throw new Error(`Jupiter swap failed: ${swapRes.statusText}`);
  
  const swap = await swapRes.json();
  if (!swap.swapTransaction) throw new Error("No swap transaction returned");
  
  // Sign & send
  const vtx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
  vtx.sign([wallet]);
  
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const sig = await connection.sendRawTransaction(vtx.serialize(), { maxRetries: 3 });
  
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  
  console.log(`[USD1] Swap confirmed: ${sig}`);
  return sig;
}

// ============================================
// FAVICON
// ============================================
app.get('/favicon.svg', (req, res) => {
  res.type('image/svg+xml').send(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#ff5c00"/>
      <stop offset="100%" style="stop-color:#ff8c4c"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="#0a0a0a"/>
  <path d="M16 44V20h6v24h-6z" fill="url(#grad)"/>
  <path d="M26 44V20h6l8 14V20h6v24h-6l-8-14v14h-6z" fill="#e8e8e8"/>
  <circle cx="52" cy="16" r="6" fill="url(#grad)"/>
</svg>
  `);
});

app.get('/favicon.ico', (req, res) => {
  res.redirect('/favicon.svg');
});

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
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap');
    
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    :root {
      --bg: #0a0a0a;
      --fg: #e8e8e8;
      --dim: #666;
      --accent: #ff5c00;
      --accent-glow: rgba(255, 92, 0, 0.3);
      --border: #222;
      --card-bg: #111;
    }
    
    html { scroll-behavior: smooth; }
    
    body {
      font-family: 'IBM Plex Mono', monospace;
      background: var(--bg);
      color: var(--fg);
      font-size: 14px;
      line-height: 1.6;
      overflow-x: hidden;
    }
    
    a { color: var(--fg); text-decoration: none; }
    
    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(30px); }
      to { opacity: 1; transform: translateY(0); }
    }
    
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    
    @keyframes glow {
      0%, 100% { box-shadow: 0 0 20px var(--accent-glow); }
      50% { box-shadow: 0 0 40px var(--accent-glow), 0 0 60px var(--accent-glow); }
    }
    
    .animate-fade-up { animation: fadeInUp 0.8s ease forwards; opacity: 0; }
    .delay-1 { animation-delay: 0.1s; }
    .delay-2 { animation-delay: 0.2s; }
    .delay-3 { animation-delay: 0.3s; }
    .delay-4 { animation-delay: 0.4s; }
    
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
      background: rgba(10, 10, 10, 0.9);
      backdrop-filter: blur(20px);
    }
    
    .logo { font-weight: 700; font-size: 18px; letter-spacing: -0.5px; }
    .logo span { color: var(--accent); }
    
    .nav-links { display: flex; gap: 40px; align-items: center; }
    .nav-links a { color: var(--dim); font-size: 13px; transition: all 0.3s ease; }
    .nav-links a:hover { color: var(--fg); }
    
    .nav-btn {
      background: transparent;
      color: var(--accent);
      border: 1px solid var(--accent);
      padding: 10px 20px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      transition: all 0.3s ease;
    }
    
    .nav-btn:hover {
      background: var(--accent);
      color: var(--bg);
    }
    
    main { max-width: 1000px; margin: 0 auto; padding: 160px 40px 100px; }
    
    .hero { margin-bottom: 140px; position: relative; }
    
    .hero-label {
      color: var(--accent);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 3px;
      margin-bottom: 28px;
      display: flex;
      align-items: center;
      gap: 16px;
    }
    
    .hero-label::before {
      content: '';
      width: 50px;
      height: 2px;
      background: linear-gradient(90deg, var(--accent), transparent);
    }
    
    h1 {
      font-size: clamp(36px, 7vw, 64px);
      font-weight: 700;
      line-height: 1.1;
      letter-spacing: -2px;
      margin-bottom: 36px;
    }
    
    h1 .highlight { color: var(--accent); }
    
    .hero-desc {
      color: var(--dim);
      font-size: 17px;
      max-width: 550px;
      margin-bottom: 52px;
      line-height: 1.8;
    }
    
    .hero-actions { display: flex; gap: 20px; flex-wrap: wrap; }
    
    .btn {
      padding: 16px 32px;
      font-family: inherit;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--fg);
      cursor: pointer;
      transition: all 0.4s ease;
      text-decoration: none;
    }
    
    .btn:hover { background: var(--fg); color: var(--bg); }
    
    .btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
      animation: glow 3s ease-in-out infinite;
    }
    
    .btn-primary:hover { background: #ff7a33; }
    
    .features { margin-bottom: 140px; }
    
    .section-label {
      color: var(--dim);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 3px;
      margin-bottom: 48px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
    }
    
    .feature-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 2px;
      background: var(--border);
      border: 1px solid var(--border);
    }
    
    @media (max-width: 700px) {
      .feature-grid { grid-template-columns: 1fr; }
    }
    
    .feature {
      background: var(--bg);
      padding: 40px 32px;
      transition: all 0.4s ease;
    }
    
    .feature:hover { background: var(--card-bg); }
    
    .feature-num { color: var(--accent); font-size: 12px; margin-bottom: 20px; font-weight: 600; }
    .feature h3 { font-size: 15px; font-weight: 600; margin-bottom: 14px; }
    .feature p { color: var(--dim); font-size: 13px; line-height: 1.7; }
    
    .platforms { margin-bottom: 140px; }
    
    .platform {
      display: grid;
      grid-template-columns: 140px 1fr auto;
      gap: 48px;
      align-items: center;
      padding: 36px 24px;
      border-bottom: 1px solid var(--border);
      transition: all 0.4s ease;
    }
    
    .platform:hover { background: var(--card-bg); }
    
    @media (max-width: 600px) {
      .platform { grid-template-columns: 1fr; gap: 16px; }
    }
    
    .platform-name { font-weight: 600; font-size: 16px; }
    .platform-desc { color: var(--dim); font-size: 13px; }
    .platform-tag {
      color: var(--accent);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      padding: 6px 12px;
      border: 1px solid var(--accent);
      border-radius: 20px;
    }
    
    .skill-box { display: flex; gap: 12px; max-width: 650px; }
    
    .skill-box input {
      flex: 1;
      background: #050505;
      border: 1px solid var(--border);
      padding: 16px 20px;
      color: var(--fg);
      font-family: inherit;
      font-size: 13px;
      outline: none;
    }
    
    .skill-box input:focus { border-color: var(--accent); }
    
    .skill-box button {
      background: var(--accent);
      border: none;
      padding: 16px 28px;
      color: #fff;
      font-family: inherit;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      cursor: pointer;
      transition: all 0.3s ease;
    }
    
    .skill-box button:hover { background: #ff7a33; }
    
    .hero-skill { margin-top: 56px; width: 100%; }
    
    footer {
      padding: 48px 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: var(--dim);
      font-size: 12px;
      border-top: 1px solid var(--border);
    }
    
    footer a { color: var(--dim); margin-left: 28px; transition: all 0.3s ease; }
    footer a:hover { color: var(--accent); }
  </style>
</head>
<body>
  <nav>
    <a href="/" class="logo">Launch<span>Mint</span></a>
    <div class="nav-links">
      <a href="#features">Features</a>
      <a href="#platforms">Platforms</a>
      <a href="/tokens">Tokens</a>
      <a href="/skill.md" class="nav-btn">Get Skill</a>
    </div>
  </nav>
  
  <main>
    <section class="hero">
      <div class="hero-label animate-fade-up">AI Agent Infrastructure</div>
      <h1 class="animate-fade-up delay-1">Deploy tokens on <span class="highlight">PumpFun, Bags.fm & USD1</span></h1>
      <p class="hero-desc animate-fade-up delay-2">Launch tokens across multiple Solana launchpads with a single API. Built for AI agents. No PumpPortal needed.</p>
      <div class="hero-actions animate-fade-up delay-3">
        <a href="/skill.md" class="btn btn-primary">Get Started</a>
        <a href="#features" class="btn">Documentation</a>
      </div>
      
      <div class="skill-box hero-skill animate-fade-up delay-4">
        <input type="text" value="${baseUrl}/skill.md" readonly id="skillUrl">
        <button onclick="copySkill()" id="copyBtn">Copy</button>
      </div>
    </section>
    
    <section class="features" id="features">
      <div class="section-label">What we handle</div>
      <div class="feature-grid">
        <div class="feature">
          <div class="feature-num">01</div>
          <h3>Official SDKs</h3>
          <p>Uses @pump-fun/pump-sdk and @raydium-io/raydium-sdk-v2. No third-party APIs.</p>
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
          <h3>USD1 Support</h3>
          <p>Launch on Bonk.fun with USD1 stablecoin. Auto-swap from SOL.</p>
        </div>
        <div class="feature">
          <div class="feature-num">06</div>
          <h3>Multi-platform</h3>
          <p>Deploy to PumpFun, Bags.fm, or USD1/Bonk.fun from one endpoint.</p>
        </div>
      </div>
    </section>
    
    <section class="platforms" id="platforms">
      <div class="section-label">Supported Platforms</div>
      <div class="platform-list">
        <div class="platform">
          <div class="platform-name">PumpFun</div>
          <div class="platform-desc">Official SDK - instant memecoin launches</div>
          <div class="platform-tag">Quote: SOL</div>
        </div>
        <div class="platform">
          <div class="platform-name">Bags.fm</div>
          <div class="platform-desc">Fee sharing with collaborators, social wallet lookup</div>
          <div class="platform-tag">Quote: SOL</div>
        </div>
        <div class="platform">
          <div class="platform-name">USD1 / Bonk.fun</div>
          <div class="platform-desc">Raydium SDK - stablecoin pairs, no SOL volatility</div>
          <div class="platform-tag">Quote: USD1</div>
        </div>
      </div>
    </section>
    
    <footer>
      <span>&copy; 2026 launchmint.fun</span>
      <div>
        <a href="/skill.md">Docs</a>
        <a href="/health">Status</a>
        <a href="/tokens">Tokens</a>
      </div>
    </footer>
  </main>
  
  <script>
    function copySkill() {
      navigator.clipboard.writeText(document.getElementById('skillUrl').value);
      const btn = document.getElementById('copyBtn');
      btn.textContent = 'Copied!';
      btn.style.background = '#22c55e';
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.style.background = '';
      }, 2000);
    }
  </script>
</body>
</html>
  `);
});

// ============================================
// TOKENS PAGE
// ============================================
app.get('/tokens', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Tokens - LaunchMint</title>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap');
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #0a0a0a; --fg: #e8e8e8; --dim: #666;
      --accent: #ff5c00; --border: #222; --card-bg: #111;
      --pumpfun: #00d4aa; --bags: #8b5cf6; --usd1: #f7931a;
    }
    body { font-family: 'IBM Plex Mono', monospace; background: var(--bg); color: var(--fg); font-size: 14px; }
    a { color: var(--fg); text-decoration: none; }
    nav { position: fixed; top: 0; left: 0; right: 0; z-index: 100; padding: 20px 40px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); background: rgba(10,10,10,0.9); backdrop-filter: blur(20px); }
    .logo { font-weight: 700; font-size: 18px; }
    .logo span { color: var(--accent); }
    .nav-links { display: flex; gap: 40px; align-items: center; }
    .nav-links a { color: var(--dim); font-size: 13px; }
    .nav-links a:hover, .nav-links a.active { color: var(--accent); }
    main { max-width: 1100px; margin: 0 auto; padding: 140px 40px 100px; }
    .page-header { margin-bottom: 60px; }
    .page-header h1 { font-size: 48px; font-weight: 700; margin-bottom: 16px; }
    .page-header p { color: var(--dim); font-size: 16px; }
    .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-bottom: 60px; }
    .stat-card { background: var(--card-bg); border: 1px solid var(--border); padding: 28px; border-radius: 8px; }
    .stat-label { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 12px; }
    .stat-value { font-size: 32px; font-weight: 700; color: var(--accent); }
    .filter-bar { display: flex; gap: 12px; margin-bottom: 32px; }
    .filter-btn { padding: 12px 20px; background: transparent; border: 1px solid var(--border); color: var(--dim); font-family: inherit; font-size: 12px; text-transform: uppercase; cursor: pointer; border-radius: 4px; }
    .filter-btn:hover, .filter-btn.active { border-color: var(--accent); color: var(--accent); }
    .tokens-header { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr 100px; gap: 20px; padding: 16px 24px; background: var(--card-bg); border: 1px solid var(--border); color: var(--dim); font-size: 11px; text-transform: uppercase; }
    .tokens-list { border: 1px solid var(--border); border-top: none; }
    .token-row { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr 100px; gap: 20px; padding: 20px 24px; border-bottom: 1px solid var(--border); align-items: center; }
    .token-row:hover { background: var(--card-bg); }
    .token-info { display: flex; align-items: center; gap: 16px; }
    .token-icon { width: 44px; height: 44px; border-radius: 50%; background: linear-gradient(135deg, var(--accent), #ff8c4c); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14px; }
    .token-platform { font-size: 12px; padding: 4px 10px; border-radius: 12px; }
    .token-platform.pumpfun { background: rgba(0, 212, 170, 0.15); color: var(--pumpfun); }
    .token-platform.bags { background: rgba(139, 92, 246, 0.15); color: var(--bags); }
    .token-platform.usd1 { background: rgba(247, 147, 26, 0.15); color: var(--usd1); }
    .token-address { font-size: 12px; color: var(--dim); }
    .token-date { color: var(--dim); font-size: 13px; }
    .token-link { color: var(--accent); font-size: 12px; }
    .empty-state { text-align: center; padding: 80px 40px; color: var(--dim); }
    .empty-state h3 { font-size: 20px; margin-bottom: 12px; color: var(--fg); }
    .btn { padding: 14px 28px; background: var(--accent); border: none; color: #fff; cursor: pointer; font-family: inherit; text-decoration: none; display: inline-block; margin-top: 20px; }
    footer { padding: 48px 0; display: flex; justify-content: space-between; color: var(--dim); font-size: 12px; border-top: 1px solid var(--border); margin-top: 80px; }
    footer a { color: var(--dim); margin-left: 28px; }
  </style>
</head>
<body>
  <nav>
    <a href="/" class="logo">Launch<span>Mint</span></a>
    <div class="nav-links">
      <a href="/#features">Features</a>
      <a href="/#platforms">Platforms</a>
      <a href="/tokens" class="active">Tokens</a>
    </div>
  </nav>
  <main>
    <div class="page-header">
      <h1>Launched Tokens</h1>
      <p>All tokens deployed through LaunchMint API</p>
    </div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Total Tokens</div><div class="stat-value" id="totalTokens">-</div></div>
      <div class="stat-card"><div class="stat-label">PumpFun</div><div class="stat-value" id="pumpfunCount">-</div></div>
      <div class="stat-card"><div class="stat-label">Bags.fm</div><div class="stat-value" id="bagsCount">-</div></div>
    </div>
    <div class="filter-bar">
      <button class="filter-btn active" data-filter="all">All</button>
      <button class="filter-btn" data-filter="pumpfun">PumpFun</button>
      <button class="filter-btn" data-filter="bags">Bags.fm</button>
      <button class="filter-btn" data-filter="usd1">USD1</button>
    </div>
    <div class="tokens-header"><span>Token</span><span>Platform</span><span>Address</span><span>Launched</span><span>Link</span></div>
    <div class="tokens-list" id="tokensList">
      <div class="empty-state">
        <h3>No tokens launched yet</h3>
        <p>Be the first to launch a token through LaunchMint API.</p>
        <a href="/skill.md" class="btn">Get Skill</a>
      </div>
    </div>
    <footer>
      <span>&copy; 2026 launchmint.fun</span>
      <div><a href="/skill.md">Docs</a><a href="/health">Status</a></div>
    </footer>
  </main>
  <script>
    let allTokens = [];
    async function loadTokens() {
      const res = await fetch('/api/tokens');
      const data = await res.json();
      if (data.success) {
        allTokens = data.tokens;
        document.getElementById('totalTokens').textContent = allTokens.length;
        document.getElementById('pumpfunCount').textContent = allTokens.filter(t => t.platform === 'pumpfun').length;
        document.getElementById('bagsCount').textContent = allTokens.filter(t => t.platform === 'bags').length;
        renderTokens(allTokens);
      }
    }
    function renderTokens(tokens) {
      const container = document.getElementById('tokensList');
      if (!tokens.length) {
        container.innerHTML = '<div class="empty-state"><h3>No tokens</h3></div>';
        return;
      }
      container.innerHTML = tokens.map(t => \`
        <div class="token-row">
          <div class="token-info">
            <div class="token-icon">\${t.symbol.substring(0,2)}</div>
            <div><div>\${t.name}</div><div style="color:var(--dim);font-size:12px">\${t.symbol}</div></div>
          </div>
          <span class="token-platform \${t.platform}">\${t.platform}</span>
          <span class="token-address">\${t.tokenAddress?.substring(0,8)}...</span>
          <span class="token-date">\${new Date(t.launchedAt).toLocaleDateString()}</span>
          <a href="\${t.url}" target="_blank" class="token-link">View</a>
        </div>
      \`).join('');
    }
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const filter = btn.dataset.filter;
        renderTokens(filter === 'all' ? allTokens : allTokens.filter(t => t.platform === filter));
      };
    });
    loadTokens();
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
description: Launch tokens on Solana via LaunchMint API. Supports PumpFun (official SDK), Bags.fm, and USD1/Bonk.fun (Raydium SDK).
---

# LaunchMint

Launch tokens on Solana. Works with PumpFun, Bags.fm, and USD1/Bonk.fun.

**Base URL:** \`${baseUrl}\`

---

## Supported Platforms

| Platform | SDK/API | Quote | API Key Required |
|----------|---------|-------|------------------|
| \`pumpfun\` | @pump-fun/pump-sdk | SOL | No |
| \`bags\` | Bags.fm API | SOL | Yes (from dev.bags.fm) |
| \`usd1\` | @raydium-io/raydium-sdk-v2 | USD1 | No |

---

## API Keys

### PumpFun
**No API key required!** Uses the official @pump-fun/pump-sdk.
Just provide your wallet's private key.

### Bags.fm

**Get your API key:**
1. Go to **https://dev.bags.fm**
2. Sign in with your wallet (Phantom, Backpack, etc.)
3. Click "Create API Key"
4. Give your key a name
5. Copy and save your API key (max 10 keys per account)

**Important:** Each user needs their own Bags API key for fee sharing to work correctly.

### USD1/Bonk.fun
**No API key required!** Uses the official Raydium SDK directly.
Auto-swaps SOL to USD1 via Jupiter if needed.

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
| \`platform\` | Yes | \`pumpfun\`, \`bags\`, or \`usd1\` |
| \`name\` | Yes | Token name (max 32 chars) |
| \`symbol\` | Yes | Token symbol (max 10 chars) |
| \`description\` | No | Token description |
| \`image\` | Yes | URL to token image (PNG/JPG) |
| \`creatorWallet\` | Yes | Solana wallet to receive fees |
| \`privateKey\` | Yes | Base58 private key for signing |
| \`apiKey\` | Bags only | Required for \`bags\` platform |
| \`twitter\` | No | Twitter URL |
| \`telegram\` | No | Telegram URL |
| \`website\` | No | Website URL |
| \`initialBuyAmount\` | No | Initial buy amount (SOL for pumpfun/bags, USD1 for usd1) |
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

## Platform Examples

### PumpFun (Official SDK)

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
    privateKey: 'your-base58-private-key',
    initialBuyAmount: 0.5  // SOL
  })
});
\`\`\`

### Bags.fm (Fee Sharing)

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
    apiKey: 'your-bags-api-key',  // Get from dev.bags.fm
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

### USD1/Bonk.fun (Raydium SDK)

\`\`\`javascript
const response = await fetch('${baseUrl}/api/tokens/create', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    platform: 'usd1',
    name: 'StableToken',
    symbol: 'STABLE',
    description: 'USD1 paired token on Bonk.fun',
    image: 'https://example.com/stable.png',
    creatorWallet: 'YourWallet...',
    privateKey: 'your-base58-private-key',
    initialBuyAmount: 1  // USD1 (auto-swaps from SOL if needed)
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
- \`Bags API key required\` - Missing apiKey for bags platform
- \`privateKey required\` - Missing private key
- \`name and symbol required\` - Missing token details
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
      return res.status(400).json({ success: false, error: 'platform required (pumpfun, bags, or usd1)' });
    }
    if (!name || !symbol) {
      return res.status(400).json({ success: false, error: 'name and symbol required' });
    }
    if (!image) {
      return res.status(400).json({ success: false, error: 'image URL required' });
    }
    if (!privateKey) {
      return res.status(400).json({ success: false, error: 'privateKey required' });
    }

    // Normalize platform
    const normalizedPlatform = platform.toLowerCase() === 'pump' ? 'pumpfun' : 
                               platform.toLowerCase() === 'bonk' ? 'usd1' :
                               platform.toLowerCase();

    const validPlatforms = ['pumpfun', 'bags', 'usd1'];
    if (!validPlatforms.includes(normalizedPlatform)) {
      return res.status(400).json({ success: false, error: 'Invalid platform. Use: pumpfun, bags, or usd1' });
    }

    // Validate API key for bags
    if (normalizedPlatform === 'bags' && !apiKey) {
      return res.status(400).json({ 
        success: false, 
        error: 'Bags API key required. Get yours at https://dev.bags.fm' 
      });
    }

    let result;

    if (normalizedPlatform === 'pumpfun') {
      result = await launchOnPumpFun({
        name, symbol, description, image, twitter, telegram, website,
        creatorWallet, privateKey, initialBuyAmount
      });
    } else if (normalizedPlatform === 'bags') {
      result = await launchOnBags({
        name, symbol, description, image, twitter, telegram, website,
        creatorWallet, apiKey, privateKey, initialBuyAmount, feeClaimers
      });
    } else if (normalizedPlatform === 'usd1') {
      result = await launchOnUSD1({
        name, symbol, description, image, twitter, telegram, website,
        creatorWallet, privateKey, initialBuyAmount
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
      `/api/v1/token-launch/fee-share/wallet/v2?username=${encodeURIComponent(username)}&provider=${provider}`,
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
    version: '2.0.0',
    status: 'ok',
    platforms: ['pumpfun', 'bags', 'usd1'],
    sdks: {
      pumpfun: '@pump-fun/pump-sdk',
      bags: 'Bags.fm API',
      usd1: '@raydium-io/raydium-sdk-v2'
    },
    tokensLaunched: launchedTokens.length
  });
});

// ============================================
// PLATFORM LAUNCHERS
// ============================================

// PUMPFUN - Official SDK
async function launchOnPumpFun({ name, symbol, description, image, twitter, telegram, website, creatorWallet, privateKey, initialBuyAmount }) {
  try {
    const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
    const mintKeypair = Keypair.generate();
    
    // Upload to IPFS
    console.log('[PumpFun] Uploading to IPFS...');
    const ipfsResult = await uploadToPumpIPFS(image, name, symbol, description, twitter, telegram, website);
    
    if (!ipfsResult.metadataUri) {
      return { success: false, error: 'Failed to upload metadata to IPFS' };
    }
    
    console.log('[PumpFun] IPFS URI:', ipfsResult.metadataUri);

    // Fetch global state
    const global = await pumpSdk.fetchGlobal();
    
    let instructions;
    const solAmount = new BN(Math.floor((initialBuyAmount || 0) * LAMPORTS_PER_SOL));
    
    if (initialBuyAmount && initialBuyAmount > 0) {
      console.log('[PumpFun] Creating token with initial buy...');
      instructions = await pumpSdk.createAndBuyInstructions({
        global,
        mint: mintKeypair.publicKey,
        name,
        symbol,
        uri: ipfsResult.metadataUri,
        creator: keypair.publicKey,
        user: keypair.publicKey,
        solAmount,
        amount: getBuyTokenAmountFromSolAmount(global, null, solAmount),
      });
    } else {
      console.log('[PumpFun] Creating token...');
      const instruction = await pumpSdk.createInstruction({
        mint: mintKeypair.publicKey,
        name,
        symbol,
        uri: ipfsResult.metadataUri,
        creator: keypair.publicKey,
        user: keypair.publicKey,
      });
      instructions = [instruction];
    }

    // Build and send transaction
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    
    const transaction = new Transaction();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = keypair.publicKey;
    
    for (const ix of instructions) {
      transaction.add(ix);
    }
    
    transaction.sign(keypair, mintKeypair);
    
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed'
    });
    
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');

    console.log('[PumpFun] Token created:', mintKeypair.publicKey.toBase58());

    return {
      success: true,
      tokenAddress: mintKeypair.publicKey.toBase58(),
      txHash: signature,
      url: `https://pump.fun/${mintKeypair.publicKey.toBase58()}`
    };
  } catch (error) {
    console.error('[PumpFun] Error:', error);
    return { success: false, error: error.message };
  }
}

// BAGS.FM - Official API
async function launchOnBags({ name, symbol, description, image, twitter, telegram, website, creatorWallet, apiKey, privateKey, initialBuyAmount, feeClaimers }) {
  try {
    const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
    
    // Step 1: Create token info and metadata
    console.log('[Bags] Creating token metadata...');
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
    
    console.log('[Bags] Token mint:', tokenMint);

    // Step 2: Build fee claimers array
    let feeClaimersArray = [];
    
    if (feeClaimers && feeClaimers.length > 0) {
      const feeClaimersBps = feeClaimers.reduce((sum, fc) => sum + fc.bps, 0);
      const creatorBps = 10000 - feeClaimersBps;
      
      if (creatorBps < 0) {
        return { success: false, error: 'Total fee claimer BPS cannot exceed 10000' };
      }
      
      // Creator must always be explicit
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
          `/api/v1/token-launch/fee-share/wallet/v2?username=${encodeURIComponent(fc.username)}&provider=${fc.provider}`,
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
      // Creator gets all fees (must be explicit with 10000 bps)
      feeClaimersArray = [{
        user: keypair.publicKey.toBase58(),
        userBps: 10000
      }];
    }

    // Step 3: Create fee share config
    console.log('[Bags] Creating fee share config...');
    const configResponse = await httpsRequest(
      'public-api-v2.bags.fm',
      '/api/v1/fee-share/config',
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
    console.log('[Bags] Config key:', configKey);

    // Step 4: Create launch transaction
    console.log('[Bags] Creating launch transaction...');
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

    console.log('[Bags] Token launched:', tokenMint);

    return {
      success: true,
      tokenAddress: tokenMint,
      txHash: signature,
      url: `https://bags.fm/${tokenMint}`
    };

  } catch (error) {
    console.error('[Bags] Error:', error);
    return { success: false, error: error.message };
  }
}

// USD1/BONK.FUN - Raydium SDK
async function launchOnUSD1({ name, symbol, description, image, twitter, telegram, website, creatorWallet, privateKey, initialBuyAmount }) {
  try {
    const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
    const mintKeypair = Keypair.generate();
    
    // Step 1: Upload to IPFS
    console.log('[USD1] Uploading to IPFS...');
    const ipfsResult = await uploadToPumpIPFS(image, name, symbol, description, twitter, telegram, website);
    
    if (!ipfsResult.metadataUri) {
      return { success: false, error: 'Failed to upload metadata to IPFS' };
    }
    
    console.log('[USD1] IPFS URI:', ipfsResult.metadataUri);

    // Step 2: Initialize Raydium SDK
    console.log('[USD1] Initializing Raydium SDK...');
    const raydium = await Raydium.load({
      connection,
      owner: keypair,
      disableLoadToken: false,
    });

    // Step 3: Fetch USD1 config
    console.log('[USD1] Fetching USD1 config...');
    const configData = await connection.getAccountInfo(USD1_CONFIG);
    if (!configData) {
      return { success: false, error: 'USD1 config not found on chain' };
    }
    
    const configInfo = LaunchpadConfig.decode(configData.data);
    const mintBInfo = await raydium.token.getTokenInfo(USD1_MINT);
    const mintBDecimals = mintBInfo?.decimals || 6;

    // Step 4: Check/Swap USD1 balance
    let usd1Balance = await getUsd1Balance(keypair.publicKey);
    console.log(`[USD1] Current USD1 balance: ${usd1Balance}`);

    let buyAmount = new BN(0);
    let createOnly = true;

    if (initialBuyAmount && initialBuyAmount > 0) {
      if (usd1Balance < initialBuyAmount) {
        const missing = initialBuyAmount - usd1Balance + 0.1; // +0.1 buffer
        console.log(`[USD1] Swapping SOL → ${missing} USD1...`);
        await swapSolToUsd1(keypair, missing);
        usd1Balance = await getUsd1Balance(keypair.publicKey);
      }

      if (usd1Balance >= initialBuyAmount) {
        buyAmount = new BN(Math.round(initialBuyAmount * 1_000_000));
        createOnly = false;
      }
    }

    // Step 5: Create launchpad token
    console.log('[USD1] Creating launchpad token...');
    console.log(`[USD1] createOnly: ${createOnly}, buyAmount: ${buyAmount.toString()}`);

    const { transactions, extInfo } = await raydium.launchpad.createLaunchpad({
      programId: LAUNCHPAD_PROGRAM,
      mintA: mintKeypair.publicKey,
      decimals: 6,
      name,
      symbol,
      uri: ipfsResult.metadataUri,
      migrateType: 'amm',
      configId: USD1_CONFIG,
      configInfo,
      mintBDecimals,
      slippage: new BN(10),
      platformId: BONK_PLATFORM_ID,
      txVersion: TxVersion.LEGACY,
      buyAmount,
      feePayer: keypair.publicKey,
      createOnly,
      extraSigners: [mintKeypair],
      computeBudgetConfig: { units: 600_000, microLamports: 50_000 },
    });

    // Step 6: Send transactions
    console.log(`[USD1] Sending ${transactions.length} transaction(s)...`);
    
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    
    let signature = '';
    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i];
      
      const messageV0 = new TransactionMessage({
        payerKey: keypair.publicKey,
        recentBlockhash: blockhash,
        instructions: tx.instructions,
      }).compileToV0Message();
      
      const vtx = new VersionedTransaction(messageV0);
      vtx.sign([keypair, mintKeypair]);
      
      signature = await connection.sendTransaction(vtx, { maxRetries: 3 });
      console.log(`[USD1] Tx ${i + 1}: ${signature}`);
      
      await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    }

    const poolAddress = extInfo?.address?.poolId?.toBase58();
    console.log('[USD1] Token launched:', mintKeypair.publicKey.toBase58());

    return {
      success: true,
      tokenAddress: mintKeypair.publicKey.toBase58(),
      txHash: signature,
      poolAddress,
      url: `https://bonk.fun/${mintKeypair.publicKey.toBase58()}`
    };

  } catch (error) {
    console.error('[USD1] Error:', error);
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
║     🚀  L A U N C H M I N T  v2.0  🚀                          ║
║     Token Launch API for AI Agents                             ║
║                                                                ║
╠════════════════════════════════════════════════════════════════╣
║                                                                ║
║  URL:      http://localhost:${PORT}                              ║
║  Skill:    http://localhost:${PORT}/skill.md                     ║
║                                                                ║
╠════════════════════════════════════════════════════════════════╣
║                                                                ║
║  Platforms:                                                    ║
║    • PumpFun   → @pump-fun/pump-sdk (official)                 ║
║    • Bags.fm   → Bags API (dev.bags.fm)                        ║
║    • USD1      → @raydium-io/raydium-sdk-v2                    ║
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
