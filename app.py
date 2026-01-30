import asyncio
import requests
from fastapi import FastAPI, BackgroundTasks
from pydantic import BaseModel
from web3 import Web3
from Crypto.Hash import keccak
from fastapi.middleware.cors import CORSMiddleware

# --- CONFIGURATION ---
CONTRACT_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3" # <--- CHECK THIS!
w3 = Web3(Web3.HTTPProvider("http://127.0.0.1:8545"))
PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ORACLE_ADDRESS = w3.eth.account.from_key(PRIVATE_KEY).address

# Physics Constants
PAPER_CONSTANTS = {"ETA_CHARGE": 0.92, "SOC_MIN": 20, "SOC_MAX": 90, "BATTERY_CAPACITY": 50, "SOLAR_MAX_OUTPUT": 50}

# Contract Setup
# UPDATE THIS LINE AT THE TOP
CONTRACT_ABI = [
    {
        "inputs": [
            {"internalType": "bytes32", "name": "_merkleRoot", "type": "bytes32"},
            {"internalType": "uint256", "name": "_tradeCount", "type": "uint256"},
            {"internalType": "uint256", "name": "_totalValue", "type": "uint256"}
        ],
        "name": "submitBatch",
        "outputs": [],
        "stateMutability": "payable", # Changed to payable
        "type": "function"
    }
]
contract = w3.eth.contract(address=CONTRACT_ADDRESS, abi=CONTRACT_ABI)

# FastAPI Setup
app = FastAPI()

# Enable CORS (Allows website to talk to Python)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Trade Data Model
class TradeRequest(BaseModel):
    seller: str
    amount: int
    type: str

# Global State
trade_queue = []
BATCH_SIZE = 5
queue_lock = asyncio.Lock()

# --- HELPER FUNCTIONS ---
def generate_merkle_root(trades):
    if not trades: return b'\x00' * 32
    leaves = []
    for trade in trades:
        data = f"{trade['seller']}{trade['amount']}{trade['price']}{trade['weather']}"
        k = keccak.new(digest_bits=256); k.update(data.encode('utf-8')); leaves.append(k.digest())
    current = leaves
    while len(current) > 1:
        next_lvl = []
        for i in range(0, len(current), 2):
            left = current[i]
            right = current[i+1] if i+1 < len(current) else left
            k = keccak.new(digest_bits=256); k.update(left + right); next_lvl.append(k.digest())
        current = next_lvl
    return current[0]

async def get_weather_forecast():
    try:
        url = "https://api.open-meteo.com/v1/forecast?latitude=34.05&longitude=-118.24&current=weather_code,cloud_cover,is_day"
        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(None, requests.get, url)
        data = response.json()['current']
        
        if data['is_day'] == 0: return "Night", 0
        efficiency = (100 - data['cloud_cover']) / 100
        max_gen = int(PAPER_CONSTANTS["SOLAR_MAX_OUTPUT"] * efficiency)
        
        label = "Sunny" if data['cloud_cover'] < 20 else "Cloudy" if data['cloud_cover'] < 70 else "Stormy"
        return label, max_gen
    except:
        return "Sunny", 50

async def flush_batch():
    global trade_queue
    async with queue_lock:
        if not trade_queue: return
        batch, trade_queue = trade_queue[:], []
    
    print(f"\n⚡ Processing Batch of {len(batch)} trades...")
    
    # Calculate Total Value (Sum of Amount * Price)
    total_value = sum(t['amount'] * t['price'] for t in batch)
    
    root = generate_merkle_root(batch)
    
    # Send to Blockchain with Value
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, send_tx, root, len(batch), total_value)

# --- UPDATED FUNCTION TO SEND VALUE ---
def send_tx(root, count, batch_value):
    nonce = w3.eth.get_transaction_count(ORACLE_ADDRESS)
    
    # We send 'batch_value' as Wei. 
    # If the batch is worth $400, we send 400 Wei.
    # This makes the "Value" field in Hardhat vary!
    tx = contract.functions.submitBatch(root, count, batch_value).build_transaction({
        'chainId': 31337,
        'gas': 3000000,
        'gasPrice': w3.to_wei('1', 'gwei'),
        'nonce': nonce,
        'value': batch_value # <--- THE MAGIC FIX
    })
    
    signed = w3.eth.account.sign_transaction(tx, PRIVATE_KEY)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    print(f"🚀 Batch Confirmed! Value: {batch_value} Wei | Hash: {w3.to_hex(tx_hash)}\n")

# --- API ENDPOINTS ---

@app.post("/submit_trade")
async def submit_trade(trade: TradeRequest, background_tasks: BackgroundTasks):
    weather, limit = await get_weather_forecast()
    
    # 1. Fraud Check
    is_fraud = False
    if trade.type == "OG (Solar)" and trade.amount > limit: is_fraud = True
    elif trade.type == "ES (Battery)":
        limit = PAPER_CONSTANTS["BATTERY_CAPACITY"] * 0.92 # simplified
        if trade.amount > limit: is_fraud = True
        
    if is_fraud:
        return {"status": "Rejected", "reason": f"Fraud Detected: {trade.amount} > {limit}", "weather": weather}

    # 2. Add to Queue
    async with queue_lock:
        trade_queue.append({
            'seller': trade.seller, 'amount': trade.amount, 
            'price': 80, 'type': trade.type, 'weather': weather
        })
        queue_len = len(trade_queue)
    
    # 3. Trigger Batch if full
    if queue_len >= BATCH_SIZE:
        background_tasks.add_task(flush_batch)
        
    return {"status": "Queued", "queue_position": queue_len, "weather": weather}

@app.get("/status")
async def get_status():
    return {"queue_size": len(trade_queue)}