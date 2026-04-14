from __future__ import annotations

import asyncio
import os
import threading
from datetime import datetime, timezone
from typing import Any, Literal

import requests
from Crypto.Hash import keccak
from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
from web3 import Web3
from web3.exceptions import Web3Exception

load_dotenv()

# --- CONFIGURATION (from environment; no secrets in source) ---


def _require_env(name: str) -> str:
    v = os.getenv(name, "").strip()
    if not v:
        raise RuntimeError(
            f"Missing required environment variable {name}. Copy .env.example to .env and set it."
        )
    return v


RPC_URL = os.getenv("RPC_URL", "http://127.0.0.1:8545").strip()
PRIVATE_KEY = _require_env("PRIVATE_KEY")
CONTRACT_ADDRESS = Web3.to_checksum_address(_require_env("CONTRACT_ADDRESS"))
CHAIN_ID = int(os.getenv("CHAIN_ID", "31337"))

w3 = Web3(Web3.HTTPProvider(RPC_URL))
ORACLE_ADDRESS = w3.eth.account.from_key(PRIVATE_KEY).address

# Physics constants
PAPER_CONSTANTS = {
    "ETA_CHARGE": 0.92,
    "SOC_MIN": 20,
    "SOC_MAX": 90,
    "BATTERY_CAPACITY": 50,
    "SOLAR_MAX_OUTPUT": 50,
}

CONTRACT_ABI = [
    {
        "inputs": [
            {"internalType": "bytes32", "name": "_merkleRoot", "type": "bytes32"},
            {"internalType": "uint256", "name": "_tradeCount", "type": "uint256"},
            {"internalType": "uint256", "name": "_totalValue", "type": "uint256"},
        ],
        "name": "submitBatch",
        "outputs": [],
        "stateMutability": "payable",
        "type": "function",
    }
]

contract = w3.eth.contract(address=CONTRACT_ADDRESS, abi=CONTRACT_ABI)

app = FastAPI(title="Energy Trading Oracle API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={
            "error": "validation_error",
            "detail": exc.errors(),
        },
    )


TradeType = Literal["OG (Solar)", "ES (Battery)"]


class TradeRequest(BaseModel):
    seller: str
    amount: int = Field(..., gt=0, le=10_000_000)
    type: TradeType

    @field_validator("seller")
    @classmethod
    def seller_must_be_address(cls, v: str) -> str:
        if not Web3.is_address(v):
            raise ValueError("seller must be a valid Ethereum address")
        return Web3.to_checksum_address(v)


# Global queue state
trade_queue: list[dict[str, Any]] = []
BATCH_SIZE = 5
queue_lock = asyncio.Lock()

# Last on-chain batch (updated from executor thread)
_last_batch_lock = threading.Lock()
last_batch: dict[str, Any] = {
    "tx_hash": None,
    "trade_count": None,
    "total_value_wei": None,
    "error": None,
    "submitted_at": None,
}


def generate_merkle_root(trades: list[dict[str, Any]]) -> bytes:
    if not trades:
        return b"\x00" * 32
    leaves = []
    for trade in trades:
        data = f"{trade['seller']}{trade['amount']}{trade['price']}{trade['weather']}"
        k = keccak.new(digest_bits=256)
        k.update(data.encode("utf-8"))
        leaves.append(k.digest())
    current = leaves
    while len(current) > 1:
        next_lvl = []
        for i in range(0, len(current), 2):
            left = current[i]
            right = current[i + 1] if i + 1 < len(current) else left
            k = keccak.new(digest_bits=256)
            k.update(left + right)
            next_lvl.append(k.digest())
        current = next_lvl
    return current[0]


async def get_weather_forecast() -> tuple[str, int]:
    try:
        url = "https://api.open-meteo.com/v1/forecast?latitude=34.05&longitude=-118.24&current=weather_code,cloud_cover,is_day"
        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(None, lambda: requests.get(url, timeout=10))
        response.raise_for_status()
        data = response.json()["current"]

        if data["is_day"] == 0:
            return "Night", 0
        efficiency = (100 - data["cloud_cover"]) / 100
        max_gen = int(PAPER_CONSTANTS["SOLAR_MAX_OUTPUT"] * efficiency)

        label = (
            "Sunny"
            if data["cloud_cover"] < 20
            else "Cloudy"
            if data["cloud_cover"] < 70
            else "Stormy"
        )
        return label, max_gen
    except Exception:
        return "Sunny", 50


def send_tx(root: bytes, count: int, batch_value: int) -> bool:
    try:
        nonce = w3.eth.get_transaction_count(ORACLE_ADDRESS)
        tx = contract.functions.submitBatch(root, count, batch_value).build_transaction(
            {
                "chainId": CHAIN_ID,
                "gas": 3_000_000,
                "gasPrice": w3.to_wei("1", "gwei"),
                "nonce": nonce,
                "value": batch_value,
            }
        )
        signed = w3.eth.account.sign_transaction(tx, private_key=PRIVATE_KEY)
        raw = getattr(signed, "raw_transaction", None) or getattr(signed, "rawTransaction", None)
        if raw is None:
            raise RuntimeError("Signed transaction has no raw_transaction bytes")
        tx_hash = w3.eth.send_raw_transaction(raw)
        tx_hex = w3.to_hex(tx_hash)
        print(f"\n[batch] submitted trades={count} value_wei={batch_value} tx={tx_hex}\n")
        with _last_batch_lock:
            last_batch.update(
                {
                    "tx_hash": tx_hex,
                    "trade_count": count,
                    "total_value_wei": batch_value,
                    "error": None,
                    "submitted_at": datetime.now(timezone.utc).isoformat(),
                }
            )
        return True
    except Exception as e:
        err = str(e)
        print(f"\n[batch] on-chain FAILED: {err}\n")
        with _last_batch_lock:
            last_batch.update(
                {
                    "tx_hash": None,
                    "trade_count": count,
                    "total_value_wei": batch_value,
                    "error": err,
                    "submitted_at": datetime.now(timezone.utc).isoformat(),
                }
            )
        return False


async def flush_batch() -> None:
    global trade_queue
    async with queue_lock:
        if not trade_queue:
            return
        batch = trade_queue[:]
        trade_queue = []

    print(f"\n[batch] processing {len(batch)} trades...")

    total_value = sum(t["amount"] * t["price"] for t in batch)
    root = generate_merkle_root(batch)

    loop = asyncio.get_running_loop()
    ok = await loop.run_in_executor(None, send_tx, root, len(batch), total_value)
    if not ok:
        async with queue_lock:
            trade_queue[:0] = batch


def _snapshot_last_batch() -> dict[str, Any]:
    with _last_batch_lock:
        return dict(last_batch)


@app.on_event("startup")
async def startup_check() -> None:
    try:
        _ = w3.eth.block_number
    except Exception as e:
        raise RuntimeError(
            f"Cannot reach RPC at {RPC_URL}. Start Hardhat in another terminal: npm run node"
        ) from e
    try:
        code = w3.eth.get_code(CONTRACT_ADDRESS)
        if code in (b"", b"\x00"):
            raise RuntimeError(
                f"No contract bytecode at {CONTRACT_ADDRESS}. Run: npm run compile && npm run deploy:local"
            )
    except Web3Exception as e:
        raise RuntimeError(f"RPC check failed: {e}") from e


@app.post("/submit_trade")
async def submit_trade(trade: TradeRequest, background_tasks: BackgroundTasks) -> dict[str, Any]:
    weather, limit = await get_weather_forecast()

    is_fraud = False
    if trade.type == "OG (Solar)" and trade.amount > limit:
        is_fraud = True
    elif trade.type == "ES (Battery)":
        limit = int(PAPER_CONSTANTS["BATTERY_CAPACITY"] * 0.92)
        if trade.amount > limit:
            is_fraud = True

    if is_fraud:
        return {
            "status": "Rejected",
            "reason": f"Fraud Detected: {trade.amount} > {limit}",
            "weather": weather,
        }

    async with queue_lock:
        trade_queue.append(
            {
                "seller": trade.seller,
                "amount": trade.amount,
                "price": 80,
                "type": trade.type,
                "weather": weather,
            }
        )
        queue_len = len(trade_queue)

    if queue_len >= BATCH_SIZE:
        background_tasks.add_task(flush_batch)

    return {"status": "Queued", "queue_position": queue_len, "weather": weather}


@app.get("/status")
async def get_status() -> dict[str, Any]:
    last = _snapshot_last_batch()
    return {
        "queue_size": len(trade_queue),
        "batch_size": BATCH_SIZE,
        "chain_id": CHAIN_ID,
        "last_batch": {
            "tx_hash": last.get("tx_hash"),
            "trade_count": last.get("trade_count"),
            "total_value_wei": last.get("total_value_wei"),
            "error": last.get("error"),
            "submitted_at": last.get("submitted_at"),
        },
    }
