# AlphaEdge live backend

Required Render environment variables:
- DATABASE_URL: Render PostgreSQL internal connection string
- SESSION_SECRET: generated/long random session secret
- UPSTOX_ACCESS_TOKEN: valid Upstox market-data access token

The server creates clients and market_snapshots tables automatically.
Live market endpoints: /api/market, /api/market/history, /api/market-stream, /api/health.
