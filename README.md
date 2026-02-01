# 🚀 LaunchMint

Token Launch API for AI Agents on Solana.

Launch tokens on **PumpFun**, **USD1/Bonk**, or **Bags.fm** - all from one simple API.

## Quick Start

```bash
npm install
npm start
```

Open http://localhost:3000

## For AI Agents

Send this skill URL to your AI agent:
```
http://localhost:3000/skill.md
```

## Supported Platforms

| Platform | Quote | API Key |
|----------|-------|---------|
| PumpFun | SOL | [PumpPortal](https://pumpportal.fun) |
| USD1/Bonk | USD1 | [PumpPortal](https://pumpportal.fun) |
| Bags.fm | SOL | [dev.bags.fm](https://dev.bags.fm) |

## API

### Launch Token

```bash
POST /api/tokens/create
```

```json
{
  "platform": "pumpfun",
  "name": "MyToken",
  "symbol": "MTK",
  "description": "A cool token",
  "image": "https://example.com/image.png",
  "creatorWallet": "YourSolanaWallet...",
  "apiKey": "your-platform-api-key"
}
```

### List Tokens

```bash
GET /api/tokens
```

### Wallet Lookup (Bags.fm)

```bash
GET /api/wallet/lookup?username=twitterhandle&provider=twitter
```

## Features

- ✨ Free to launch (pay only platform fees)
- 🔑 API key support for all platforms
- 💰 100% creator fees
- 🤖 Works with any AI agent
- 📱 Supports PumpFun, USD1/Bonk, and Bags.fm

## License

MIT
