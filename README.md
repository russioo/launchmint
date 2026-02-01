# LaunchMint

**[launchmint.fun](https://launchmint.fun)**

One API for PumpFun, USD1, and Bags.fm token launches on Solana.

## Quick Start

```bash
npm install
npm start
```

Server runs at `http://localhost:3000`

## For AI Agents

Send this skill URL to your agent:
```
https://launchmint.fun/skill.md
```

## Platforms

| Platform | Quote | API Key |
|----------|-------|---------|
| PumpFun | SOL | [pumpportal.fun](https://pumpportal.fun) |
| USD1/Bonk | USD1 | [pumpportal.fun](https://pumpportal.fun) |
| Bags.fm | SOL | [dev.bags.fm](https://dev.bags.fm) |

## API

### Launch Token

```
POST /api/tokens/create
```

```json
{
  "platform": "pumpfun",
  "name": "MyToken",
  "symbol": "MTK",
  "image": "https://example.com/image.png",
  "apiKey": "your-api-key"
}
```

### List Tokens

```
GET /api/tokens
```

### Get Skill

```
GET /skill.md
```

## Features

- Wallet generation
- IPFS metadata upload
- On-chain deployment
- Fee sharing (Bags.fm)
- Social verification

## License

MIT
