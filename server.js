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
const { PumpSdk, getBuyTokenAmountFromSolAmount } = require('@pump-fun/pump-sdk');
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

// Note: Users must provide their own Bags API key for bags.fm launches

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
    
    html {
      scroll-behavior: smooth;
    }
    
    body {
      font-family: 'IBM Plex Mono', monospace;
      background: var(--bg);
      color: var(--fg);
      font-size: 14px;
      line-height: 1.6;
      overflow-x: hidden;
    }
    
    a { color: var(--fg); text-decoration: none; }
    
    /* ANIMATIONS */
    @keyframes fadeInUp {
      from {
        opacity: 0;
        transform: translateY(30px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    
    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateX(-20px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }
    
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    
    @keyframes glow {
      0%, 100% { box-shadow: 0 0 20px var(--accent-glow); }
      50% { box-shadow: 0 0 40px var(--accent-glow), 0 0 60px var(--accent-glow); }
    }
    
    .animate-fade-up {
      animation: fadeInUp 0.8s ease forwards;
      opacity: 0;
    }
    
    .animate-fade {
      animation: fadeIn 1s ease forwards;
      opacity: 0;
    }
    
    .delay-1 { animation-delay: 0.1s; }
    .delay-2 { animation-delay: 0.2s; }
    .delay-3 { animation-delay: 0.3s; }
    .delay-4 { animation-delay: 0.4s; }
    .delay-5 { animation-delay: 0.5s; }
    
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
      background: rgba(10, 10, 10, 0.9);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
    }
    
    .logo {
      font-weight: 700;
      font-size: 18px;
      letter-spacing: -0.5px;
      transition: transform 0.3s ease;
    }
    
    .logo:hover {
      transform: scale(1.05);
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
      transition: all 0.3s ease;
      position: relative;
    }
    
    .nav-links a::after {
      content: '';
      position: absolute;
      bottom: -4px;
      left: 0;
      width: 0;
      height: 1px;
      background: var(--accent);
      transition: width 0.3s ease;
    }
    
    .nav-links a:hover {
      color: var(--fg);
    }
    
    .nav-links a:hover::after {
      width: 100%;
    }
    
    .nav-btn {
      background: transparent;
      color: var(--accent);
      border: 1px solid var(--accent);
      padding: 10px 20px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      overflow: hidden;
    }
    
    .nav-btn::before {
      content: '';
      position: absolute;
      top: 0;
      left: -100%;
      width: 100%;
      height: 100%;
      background: var(--accent);
      transition: left 0.3s ease;
      z-index: -1;
    }
    
    .nav-btn:hover::before {
      left: 0;
    }
    
    .nav-btn:hover {
      color: var(--bg);
      transform: translateY(-2px);
      box-shadow: 0 4px 20px var(--accent-glow);
    }
    
    /* MAIN */
    main {
      max-width: 1000px;
      margin: 0 auto;
      padding: 160px 40px 100px;
    }
    
    /* HERO */
    .hero {
      margin-bottom: 140px;
      position: relative;
    }
    
    .hero::before {
      content: '';
      position: absolute;
      top: -100px;
      right: -200px;
      width: 500px;
      height: 500px;
      background: radial-gradient(circle, var(--accent-glow) 0%, transparent 70%);
      opacity: 0.3;
      pointer-events: none;
      animation: pulse 4s ease-in-out infinite;
    }
    
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
      background: linear-gradient(135deg, var(--fg) 0%, var(--dim) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    
    h1 .highlight {
      background: linear-gradient(135deg, var(--accent) 0%, #ff8c4c 100%);
      -webkit-background-clip: text;
      background-clip: text;
    }
    
    .hero-desc {
      color: var(--dim);
      font-size: 17px;
      max-width: 550px;
      margin-bottom: 52px;
      line-height: 1.8;
    }
    
    .hero-actions {
      display: flex;
      gap: 20px;
      flex-wrap: wrap;
    }
    
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
      transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
      text-decoration: none;
      display: inline-block;
      position: relative;
      overflow: hidden;
    }
    
    .btn::before {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      width: 0;
      height: 0;
      background: var(--fg);
      border-radius: 50%;
      transform: translate(-50%, -50%);
      transition: width 0.6s ease, height 0.6s ease;
      z-index: -1;
    }
    
    .btn:hover::before {
      width: 300px;
      height: 300px;
    }
    
    .btn:hover {
      color: var(--bg);
      border-color: var(--fg);
      transform: translateY(-3px);
    }
    
    .btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
      animation: glow 3s ease-in-out infinite;
    }
    
    .btn-primary::before {
      background: #ff7a33;
    }
    
    .btn-primary:hover {
      background: #ff7a33;
      border-color: #ff7a33;
      color: #fff;
    }
    
    /* FEATURES */
    .features {
      margin-bottom: 140px;
    }
    
    .section-label {
      color: var(--dim);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 3px;
      margin-bottom: 48px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 16px;
    }
    
    .section-label::before {
      content: '';
      width: 8px;
      height: 8px;
      background: var(--accent);
      border-radius: 50%;
      animation: pulse 2s ease-in-out infinite;
    }
    
    .feature-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 2px;
      background: var(--border);
      border: 1px solid var(--border);
      border-radius: 4px;
      overflow: hidden;
    }
    
    @media (max-width: 700px) {
      .feature-grid { grid-template-columns: 1fr; }
    }
    
    .feature {
      background: var(--bg);
      padding: 40px 32px;
      transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      overflow: hidden;
    }
    
    .feature::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 3px;
      background: linear-gradient(90deg, var(--accent), transparent);
      transform: scaleX(0);
      transform-origin: left;
      transition: transform 0.4s ease;
    }
    
    .feature:hover {
      background: var(--card-bg);
      transform: translateY(-4px);
    }
    
    .feature:hover::before {
      transform: scaleX(1);
    }
    
    .feature-num {
      color: var(--accent);
      font-size: 12px;
      margin-bottom: 20px;
      font-weight: 600;
    }
    
    .feature h3 {
      font-size: 15px;
      font-weight: 600;
      margin-bottom: 14px;
      transition: color 0.3s ease;
    }
    
    .feature:hover h3 {
      color: var(--accent);
    }
    
    .feature p {
      color: var(--dim);
      font-size: 13px;
      line-height: 1.7;
    }
    
    /* PLATFORMS */
    .platforms {
      margin-bottom: 140px;
    }
    
    .platform-list {
      display: flex;
      flex-direction: column;
    }
    
    .platform {
      display: grid;
      grid-template-columns: 140px 1fr auto;
      gap: 48px;
      align-items: center;
      padding: 36px 24px;
      border-bottom: 1px solid var(--border);
      transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
      border-radius: 4px;
      margin-bottom: 4px;
    }
    
    .platform:hover {
      background: var(--card-bg);
      transform: translateX(8px);
      border-color: var(--accent);
    }
    
    @media (max-width: 600px) {
      .platform {
        grid-template-columns: 1fr;
        gap: 16px;
      }
    }
    
    .platform-name {
      font-weight: 600;
      font-size: 16px;
      transition: color 0.3s ease;
    }
    
    .platform:hover .platform-name {
      color: var(--accent);
    }
    
    .platform-desc {
      color: var(--dim);
      font-size: 13px;
    }
    
    .platform-tag {
      color: var(--accent);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      padding: 6px 12px;
      border: 1px solid var(--accent);
      border-radius: 20px;
      transition: all 0.3s ease;
    }
    
    .platform:hover .platform-tag {
      background: var(--accent);
      color: var(--bg);
    }
    
    /* CODE */
    .code-section {
      margin-bottom: 140px;
    }
    
    .code-block {
      background: #050505;
      border: 1px solid var(--border);
      overflow: hidden;
      border-radius: 8px;
      transition: all 0.4s ease;
    }
    
    .code-block:hover {
      border-color: var(--accent);
      box-shadow: 0 8px 40px rgba(0, 0, 0, 0.4);
    }
    
    .code-header {
      padding: 18px 28px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(255, 92, 0, 0.03);
    }
    
    .code-file {
      color: var(--dim);
      font-size: 12px;
    }
    
    .code-lang {
      color: var(--accent);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
    }
    
    .code-body {
      padding: 28px;
      font-size: 13px;
      line-height: 2;
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
      max-width: 650px;
    }
    
    .skill-box input {
      flex: 1;
      background: #050505;
      border: 1px solid var(--border);
      padding: 16px 20px;
      color: var(--fg);
      font-family: inherit;
      font-size: 13px;
      outline: none;
      border-radius: 4px;
      transition: all 0.3s ease;
    }
    
    .skill-box input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 20px var(--accent-glow);
    }
    
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
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      border-radius: 4px;
    }
    
    .skill-box button:hover {
      background: #ff7a33;
      transform: translateY(-2px);
      box-shadow: 0 4px 20px var(--accent-glow);
    }
    
    .hero-skill {
      margin-top: 56px;
      width: 100%;
    }
    
    /* FOOTER */
    footer {
      padding: 48px 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: var(--dim);
      font-size: 12px;
      border-top: 1px solid var(--border);
    }
    
    footer a {
      color: var(--dim);
      margin-left: 28px;
      transition: all 0.3s ease;
      position: relative;
    }
    
    footer a:hover {
      color: var(--accent);
      transform: translateY(-2px);
    }
    
    /* SCROLL REVEAL */
    .reveal {
      opacity: 0;
      transform: translateY(40px);
      transition: all 0.8s cubic-bezier(0.4, 0, 0.2, 1);
    }
    
    .reveal.visible {
      opacity: 1;
      transform: translateY(0);
    }
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
      <h1 class="animate-fade-up delay-1">Learn your agent how to deploy tokens on <span class="highlight">Bags, USD1 and PumpFun</span></h1>
      <p class="hero-desc animate-fade-up delay-2">Deploy tokens across multiple Solana launchpads with a single API. We handle wallets, metadata, and on-chain deployment. Built for AI agents.</p>
      <div class="hero-actions animate-fade-up delay-3">
        <a href="/skill.md" class="btn btn-primary">Get Started</a>
        <a href="#features" class="btn">Documentation</a>
      </div>
      
      <div class="skill-box hero-skill animate-fade-up delay-4">
        <input type="text" value="${baseUrl}/skill.md" readonly id="skillUrl">
        <button onclick="copySkill()" id="copyBtn">Copy</button>
      </div>
    </section>
    
    <section class="features reveal" id="features">
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
    
    <section class="platforms reveal" id="platforms">
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
    
    <section class="code-section reveal">
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
    <span class="p">image:</span> <span class="s">'https://example.com/logo.png'</span>
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
    
    // Scroll reveal animation
    const revealElements = document.querySelectorAll('.reveal');
    
    const revealOnScroll = () => {
      revealElements.forEach(el => {
        const rect = el.getBoundingClientRect();
        const windowHeight = window.innerHeight;
        
        if (rect.top < windowHeight - 100) {
          el.classList.add('visible');
        }
      });
    };
    
    window.addEventListener('scroll', revealOnScroll);
    revealOnScroll(); // Initial check
    
    // Smooth scroll for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
      anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
          target.scrollIntoView({
            behavior: 'smooth',
            block: 'start'
          });
        }
      });
    });
  </script>
</body>
</html>
  `);
});

// ============================================
// TOKENS PAGE
// ============================================
app.get('/tokens', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  
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
      --bg: #0a0a0a;
      --fg: #e8e8e8;
      --dim: #666;
      --accent: #ff5c00;
      --accent-glow: rgba(255, 92, 0, 0.3);
      --border: #222;
      --card-bg: #111;
      --success: #22c55e;
      --pumpfun: #00d4aa;
      --bonk: #f7931a;
      --bags: #8b5cf6;
    }
    
    html { scroll-behavior: smooth; }
    
    body {
      font-family: 'IBM Plex Mono', monospace;
      background: var(--bg);
      color: var(--fg);
      font-size: 14px;
      line-height: 1.6;
      min-height: 100vh;
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
    
    @keyframes shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    
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
      background: rgba(10, 10, 10, 0.9);
      backdrop-filter: blur(20px);
    }
    
    .logo {
      font-weight: 700;
      font-size: 18px;
      letter-spacing: -0.5px;
      transition: transform 0.3s ease;
    }
    
    .logo:hover { transform: scale(1.05); }
    .logo span { color: var(--accent); }
    
    .nav-links {
      display: flex;
      gap: 40px;
      align-items: center;
    }
    
    .nav-links a {
      color: var(--dim);
      font-size: 13px;
      transition: all 0.3s ease;
      position: relative;
    }
    
    .nav-links a::after {
      content: '';
      position: absolute;
      bottom: -4px;
      left: 0;
      width: 0;
      height: 1px;
      background: var(--accent);
      transition: width 0.3s ease;
    }
    
    .nav-links a:hover { color: var(--fg); }
    .nav-links a:hover::after { width: 100%; }
    .nav-links a.active { color: var(--accent); }
    .nav-links a.active::after { width: 100%; }
    
    .nav-btn {
      background: transparent;
      color: var(--accent);
      border: 1px solid var(--accent);
      padding: 10px 20px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    
    .nav-btn:hover {
      background: var(--accent);
      color: var(--bg);
      transform: translateY(-2px);
      box-shadow: 0 4px 20px var(--accent-glow);
    }
    
    /* MAIN */
    main {
      max-width: 1100px;
      margin: 0 auto;
      padding: 140px 40px 100px;
    }
    
    /* PAGE HEADER */
    .page-header {
      margin-bottom: 60px;
      animation: fadeInUp 0.8s ease forwards;
    }
    
    .page-header h1 {
      font-size: 48px;
      font-weight: 700;
      margin-bottom: 16px;
      letter-spacing: -2px;
    }
    
    .page-header p {
      color: var(--dim);
      font-size: 16px;
    }
    
    /* STATS */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 20px;
      margin-bottom: 60px;
      animation: fadeInUp 0.8s ease 0.1s forwards;
      opacity: 0;
    }
    
    @media (max-width: 800px) {
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
    }
    
    .stat-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      padding: 28px;
      border-radius: 8px;
      transition: all 0.4s ease;
    }
    
    .stat-card:hover {
      border-color: var(--accent);
      transform: translateY(-4px);
    }
    
    .stat-label {
      color: var(--dim);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      margin-bottom: 12px;
    }
    
    .stat-value {
      font-size: 32px;
      font-weight: 700;
      color: var(--accent);
    }
    
    /* FILTER BAR */
    .filter-bar {
      display: flex;
      gap: 12px;
      margin-bottom: 32px;
      animation: fadeInUp 0.8s ease 0.2s forwards;
      opacity: 0;
    }
    
    .filter-btn {
      padding: 12px 20px;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--dim);
      font-family: inherit;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      cursor: pointer;
      border-radius: 4px;
      transition: all 0.3s ease;
    }
    
    .filter-btn:hover, .filter-btn.active {
      border-color: var(--accent);
      color: var(--accent);
    }
    
    .filter-btn.active {
      background: rgba(255, 92, 0, 0.1);
    }
    
    /* TOKENS LIST */
    .tokens-container {
      animation: fadeInUp 0.8s ease 0.3s forwards;
      opacity: 0;
    }
    
    .tokens-header {
      display: grid;
      grid-template-columns: 2fr 1fr 1fr 1fr 100px;
      gap: 20px;
      padding: 16px 24px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px 8px 0 0;
      color: var(--dim);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
    }
    
    @media (max-width: 700px) {
      .tokens-header { display: none; }
    }
    
    .tokens-list {
      border: 1px solid var(--border);
      border-top: none;
      border-radius: 0 0 8px 8px;
      overflow: hidden;
    }
    
    .token-row {
      display: grid;
      grid-template-columns: 2fr 1fr 1fr 1fr 100px;
      gap: 20px;
      padding: 20px 24px;
      border-bottom: 1px solid var(--border);
      transition: all 0.3s ease;
      align-items: center;
    }
    
    .token-row:last-child { border-bottom: none; }
    
    .token-row:hover {
      background: var(--card-bg);
    }
    
    @media (max-width: 700px) {
      .token-row {
        grid-template-columns: 1fr;
        gap: 12px;
      }
    }
    
    .token-info {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    
    .token-icon {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--accent), #ff8c4c);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 14px;
    }
    
    .token-name {
      font-weight: 600;
      margin-bottom: 4px;
    }
    
    .token-symbol {
      color: var(--dim);
      font-size: 12px;
    }
    
    .token-platform {
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 12px;
      display: inline-block;
    }
    
    .token-platform.pumpfun {
      background: rgba(0, 212, 170, 0.15);
      color: var(--pumpfun);
    }
    
    .token-platform.bonk {
      background: rgba(247, 147, 26, 0.15);
      color: var(--bonk);
    }
    
    .token-platform.bags {
      background: rgba(139, 92, 246, 0.15);
      color: var(--bags);
    }
    
    .token-address {
      font-size: 12px;
      color: var(--dim);
      font-family: monospace;
    }
    
    .token-date {
      color: var(--dim);
      font-size: 13px;
    }
    
    .token-link {
      color: var(--accent);
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.3s ease;
    }
    
    .token-link:hover {
      transform: translateX(4px);
    }
    
    .token-link svg {
      width: 14px;
      height: 14px;
    }
    
    /* EMPTY STATE */
    .empty-state {
      text-align: center;
      padding: 80px 40px;
      color: var(--dim);
    }
    
    .empty-icon {
      font-size: 64px;
      margin-bottom: 24px;
      opacity: 0.3;
    }
    
    .empty-state h3 {
      font-size: 20px;
      margin-bottom: 12px;
      color: var(--fg);
    }
    
    .empty-state p {
      max-width: 400px;
      margin: 0 auto 32px;
    }
    
    .btn {
      padding: 14px 28px;
      font-family: inherit;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      border: 1px solid var(--accent);
      background: var(--accent);
      color: #fff;
      cursor: pointer;
      transition: all 0.3s ease;
      text-decoration: none;
      display: inline-block;
      border-radius: 4px;
    }
    
    .btn:hover {
      background: #ff7a33;
      transform: translateY(-2px);
      box-shadow: 0 4px 20px var(--accent-glow);
    }
    
    /* FOOTER */
    footer {
      padding: 48px 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: var(--dim);
      font-size: 12px;
      border-top: 1px solid var(--border);
      margin-top: 80px;
    }
    
    footer a {
      color: var(--dim);
      margin-left: 28px;
      transition: all 0.3s ease;
    }
    
    footer a:hover {
      color: var(--accent);
    }
    
    /* Loading shimmer */
    .loading {
      background: linear-gradient(90deg, var(--card-bg) 25%, var(--border) 50%, var(--card-bg) 75%);
      background-size: 200% 100%;
      animation: shimmer 1.5s infinite;
    }
  </style>
</head>
<body>
  <nav>
    <a href="/" class="logo">Launch<span>Mint</span></a>
    <div class="nav-links">
      <a href="/#features">Features</a>
      <a href="/#platforms">Platforms</a>
      <a href="/tokens" class="active">Tokens</a>
      <a href="/skill.md" class="nav-btn">Get Skill</a>
    </div>
  </nav>
  
  <main>
    <div class="page-header">
      <h1>Launched Tokens</h1>
      <p>All tokens deployed through LaunchMint API</p>
    </div>
    
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Tokens</div>
        <div class="stat-value" id="totalTokens">-</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">PumpFun</div>
        <div class="stat-value" id="pumpfunCount">-</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">USD1/Bonk</div>
        <div class="stat-value" id="bonkCount">-</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Bags.fm</div>
        <div class="stat-value" id="bagsCount">-</div>
      </div>
    </div>
    
    <div class="filter-bar">
      <button class="filter-btn active" data-filter="all">All</button>
      <button class="filter-btn" data-filter="pumpfun">PumpFun</button>
      <button class="filter-btn" data-filter="bonk">USD1/Bonk</button>
      <button class="filter-btn" data-filter="bags">Bags.fm</button>
    </div>
    
    <div class="tokens-container">
      <div class="tokens-header">
        <span>Token</span>
        <span>Platform</span>
        <span>Address</span>
        <span>Launched</span>
        <span>Link</span>
      </div>
      <div class="tokens-list" id="tokensList">
        <div class="empty-state">
          <div class="empty-icon"></div>
          <h3>No tokens launched yet</h3>
          <p>Be the first to launch a token through LaunchMint API. Get started with our AI agent skill.</p>
          <a href="/skill.md" class="btn">Get Skill</a>
        </div>
      </div>
    </div>
    
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
    let allTokens = [];
    let currentFilter = 'all';
    
    async function loadTokens() {
      try {
        const response = await fetch('/api/tokens');
        const data = await response.json();
        
        if (data.success) {
          allTokens = data.tokens;
          updateStats(allTokens);
          renderTokens(allTokens);
        }
      } catch (error) {
        console.error('Failed to load tokens:', error);
      }
    }
    
    function updateStats(tokens) {
      document.getElementById('totalTokens').textContent = tokens.length;
      document.getElementById('pumpfunCount').textContent = tokens.filter(t => t.platform === 'pumpfun').length;
      document.getElementById('bonkCount').textContent = tokens.filter(t => t.platform === 'bonk').length;
      document.getElementById('bagsCount').textContent = tokens.filter(t => t.platform === 'bags').length;
    }
    
    function renderTokens(tokens) {
      const container = document.getElementById('tokensList');
      
      if (tokens.length === 0) {
        container.innerHTML = \`
          <div class="empty-state">
            <div class="empty-icon"></div>
            <h3>No tokens launched yet</h3>
            <p>Be the first to launch a token through LaunchMint API. Get started with our AI agent skill.</p>
            <a href="/skill.md" class="btn">Get Skill</a>
          </div>
        \`;
        return;
      }
      
      container.innerHTML = tokens.map(token => \`
        <div class="token-row" data-platform="\${token.platform}">
          <div class="token-info">
            <div class="token-icon">\${token.symbol.substring(0, 2).toUpperCase()}</div>
            <div>
              <div class="token-name">\${token.name}</div>
              <div class="token-symbol">\${token.symbol}</div>
            </div>
          </div>
          <div>
            <span class="token-platform \${token.platform}">\${token.platform}</span>
          </div>
          <div class="token-address">\${token.tokenAddress ? token.tokenAddress.substring(0, 8) + '...' : '-'}</div>
          <div class="token-date">\${token.launchedAt ? new Date(token.launchedAt).toLocaleDateString() : '-'}</div>
          <a href="\${token.url}" target="_blank" class="token-link">
            View
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>
      \`).join('');
    }
    
    // Filter buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        currentFilter = btn.dataset.filter;
        const filtered = currentFilter === 'all' 
          ? allTokens 
          : allTokens.filter(t => t.platform === currentFilter);
        
        renderTokens(filtered);
      });
    });
    
    // Load tokens on page load
    loadTokens();
    
    // Refresh every 30 seconds
    setInterval(loadTokens, 30000);
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

| Platform | API Key Required | Quote | Best For |
|----------|------------------|-------|----------|
| \`pumpfun\` | No (uses official SDK) | SOL | Quick memecoin launches |
| \`bonk\` | Yes (PumpPortal) | USD1 | Stable pricing |
| \`bags\` | Yes (Bags.fm) | SOL | Fee sharing with collaborators |

---

## API Keys

### PumpFun
**No API key required!** Uses the official @pump-fun/pump-sdk.
Just provide your wallet's private key.

### Bonk/USD1
Get API key from: https://pumpportal.fun/trading-api/setup/

### Bags.fm
Get API key from: https://dev.bags.fm
Each user needs their own Bags API key for fee sharing to work correctly.

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
| \`platform\` | Yes | \`pumpfun\`, \`bonk\`, or \`bags\` |
| \`name\` | Yes | Token name (max 32 chars) |
| \`symbol\` | Yes | Token symbol (max 10 chars) |
| \`description\` | No | Token description |
| \`image\` | Yes | URL to token image (PNG/JPG) |
| \`creatorWallet\` | Yes | Solana wallet to receive fees |
| \`apiKey\` | Depends | Required for \`bonk\` (PumpPortal) and \`bags\` (Bags.fm). Not needed for \`pumpfun\`. |
| \`privateKey\` | Yes | Base58 private key for signing transactions |
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

### PumpFun Launch (No API Key Needed!)

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
    privateKey: 'your-base58-private-key',  // Required for signing
    initialBuyAmount: 0.5  // Dev buy 0.5 SOL
  })
});
\`\`\`

### USD1/Bonk Launch (Requires PumpPortal API Key)

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
    apiKey: 'your-pumpportal-api-key',  // Get from pumpportal.fun
    privateKey: 'your-base58-private-key',
    initialBuyAmount: 1  // Dev buy 1 SOL worth
  })
});
\`\`\`

### Bags.fm Launch (Requires Your Own Bags API Key)

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

## cURL Example (PumpFun - No API Key)

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
    "privateKey": "your-base58-private-key"
  }'
\`\`\`

---

## Python Example (Bags.fm)

\`\`\`python
import requests

response = requests.post('${baseUrl}/api/tokens/create', json={
    'platform': 'bags',
    'name': 'PythonToken',
    'symbol': 'PYTH',
    'description': 'Launched from Python on Bags.fm',
    'image': 'https://example.com/python.png',
    'creatorWallet': 'YourWallet...',
    'apiKey': 'your-bags-api-key',  # Get from dev.bags.fm
    'privateKey': 'your-base58-private-key',
    'initialBuyAmount': 0.01
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

    // Normalize platform
    const normalizedPlatform = platform.toLowerCase() === 'pump' ? 'pumpfun' : 
                               platform.toLowerCase() === 'usd1' ? 'bonk' : 
                               platform.toLowerCase();

    const validPlatforms = ['pumpfun', 'bonk', 'bags'];
    if (!validPlatforms.includes(normalizedPlatform)) {
      return res.status(400).json({ success: false, error: 'Invalid platform. Use: pumpfun, bonk, or bags' });
    }

    // Validate API key requirements
    // PumpFun: No API key needed (uses official Pump SDK)
    // Bonk/USD1: Requires PumpPortal API key
    // Bags: Requires user's own Bags API key
    
    if (normalizedPlatform === 'bags' && !apiKey) {
      return res.status(400).json({ 
        success: false, 
        error: 'Bags API key required. Get yours at https://dev.bags.fm' 
      });
    }
    
    if (normalizedPlatform === 'bonk' && !apiKey) {
      return res.status(400).json({ 
        success: false, 
        error: 'PumpPortal API key required for Bonk/USD1. Get yours at https://pumpportal.fun/trading-api/setup/' 
      });
    }

    let result;

    if (normalizedPlatform === 'pumpfun') {
      // PumpFun uses official Pump SDK - no API key needed
      result = await launchOnPumpFun({
        name, symbol, description, image, twitter, telegram, website,
        creatorWallet, privateKey, initialBuyAmount
      });
    } else if (normalizedPlatform === 'bonk') {
      // Bonk/USD1 uses PumpPortal API
      result = await launchOnBonk({
        name, symbol, description, image, twitter, telegram, website,
        creatorWallet, apiKey, privateKey, initialBuyAmount
      });
    } else if (normalizedPlatform === 'bags') {
      // Bags uses user's own Bags API key
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

async function launchOnPumpFun({ name, symbol, description, image, twitter, telegram, website, creatorWallet, privateKey, initialBuyAmount }) {
  try {
    if (!privateKey) {
      return { success: false, error: 'privateKey required for PumpFun launch' };
    }

    const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
    const mintKeypair = Keypair.generate();
    
    // Upload to IPFS
    console.log('Uploading to IPFS...');
    const ipfsResult = await uploadToPumpIPFS(image, name, symbol, description, twitter, telegram, website);
    
    if (!ipfsResult.metadataUri) {
      return { success: false, error: 'Failed to upload metadata to IPFS' };
    }
    
    console.log('IPFS URI:', ipfsResult.metadataUri);

    // Fetch global state from Pump SDK
    const global = await pumpSdk.fetchGlobal();
    
    let instructions;
    const solAmount = new BN(Math.floor((initialBuyAmount || 0) * LAMPORTS_PER_SOL));
    
    if (initialBuyAmount && initialBuyAmount > 0) {
      // Create token with initial buy using official Pump SDK
      console.log('Creating token with initial buy via Pump SDK...');
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
      // Create token without initial buy
      console.log('Creating token via Pump SDK...');
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
    
    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight
    }, 'confirmed');

    console.log('Token created successfully:', mintKeypair.publicKey.toBase58());

    return {
      success: true,
      tokenAddress: mintKeypair.publicKey.toBase58(),
      txHash: signature,
      url: `https://pump.fun/${mintKeypair.publicKey.toBase58()}`
    };
  } catch (error) {
    console.error('PumpFun launch error:', error);
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
